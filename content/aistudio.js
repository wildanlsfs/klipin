// Klipin — otomasi Google AI Studio Generate Speech (aistudio.google.com/generate-speech).
// Memilih mode Single-speaker + suara, mengisi style instruction & naskah, menekan Run,
// lalu mengambil audio hasil langsung dari DOM (<audio src="blob:...">) dan mengirimnya ke Klipin.
(() => {
  if (window.__klipinAiStudio) return;
  window.__klipinAiStudio = true;

  const sleep = (ms) => new Promise((resolve) => {
    if (!document.hidden) return setTimeout(resolve, ms);
    chrome.runtime.sendMessage({ type: 'TUYUL_SLEEP', ms })
      .then((r) => (r?.ok ? resolve() : setTimeout(resolve, ms)), () => setTimeout(resolve, ms));
  });

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  let badge;
  function status(text) {
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;left:16px;padding:10px 14px;border-radius:12px;background:#111;color:#fff;font:600 13px system-ui;box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid #333;max-width:360px;pointer-events:none';
      document.body.appendChild(badge);
    }
    badge.textContent = `🎙️ Klipin — ${text}`;
    badge.style.display = text ? 'block' : 'none';
  }

  function isLoginOrGate() {
    if (/accounts\.google\.com/i.test(location.hostname)) return true;
    return [...document.querySelectorAll('button, a')].filter(visible)
      .some((el) => /^(sign in|masuk|log in)\b/i.test((el.innerText || '').trim()));
  }

  async function clickReal(el, attempt = 1) {
    const att = await chrome.runtime.sendMessage({ type: 'TUYUL_DEBUG_ATTACH' }).catch(() => null);
    if (att?.fresh) await sleep(600);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const res = await chrome.runtime.sendMessage({
      type: 'TUYUL_TRUSTED_CLICK', x: r.left + r.width / 2, y: r.top + r.height / 2, attempt,
    }).catch(() => null);
    if (!res?.ok) el.click();
  }

  function getHintText(el) {
    const aria = el.getAttribute('aria-label') || '';
    const ph = el.getAttribute('placeholder') || '';
    const id = el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText || '') : '';
    const parent = el.closest('mat-form-field, .field, section, div')?.innerText?.slice(0, 120) || '';
    return `${aria} ${ph} ${id} ${parent}`.toLowerCase();
  }

  // Tombol/kartu "Create new dialog" (bukan "Create new voice") di galeri Generate Speech.
  function findCreateDialogButton() {
    return [...document.querySelectorAll('button, [role="button"], a, .card, [class*="card"]')].filter(visible)
      .find((el) => /create new dialog/i.test(`${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`)) || null;
  }

  function findInputs() {
    const all = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')].filter(visible);
    const byAria = document.querySelector('textarea[aria-label="Speech block text"]');
    let styleEl = null;
    let scriptEl = null;
    for (const el of all) {
      const hint = getHintText(el);
      if (!styleEl && /style|instruction|gaya/.test(hint)) {
        styleEl = el;
      } else if (!scriptEl && /text|script|transcript|type something|paste|start typing|ketik|naskah/.test(hint)) {
        scriptEl = el;
      }
    }
    if (byAria && visible(byAria)) scriptEl = byAria;
    // Fallback: textarea terbesar yang bukan styleEl adalah kolom naskah
    if (!scriptEl) {
      const cands = all.filter((el) => el !== styleEl)
        .sort((a, b) => (b.getBoundingClientRect().height * b.getBoundingClientRect().width) - (a.getBoundingClientRect().height * a.getBoundingClientRect().width));
      scriptEl = cands[0] || null;
    }
    return { styleEl, scriptEl };
  }

  const readField = (el) => ((el?.value ?? el?.innerText) || '').trim();

  async function setFieldText(el, text) {
    if (!el) return;
    el.focus();
    const val = String(text || '');
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, val);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await sleep(200);
    // Jika framework mengabaikan event sintetik, ketik lewat CDP Input.insertText
    if (readField(el) !== val.trim()) {
      await clickReal(el, 1);
      await sleep(150);
      await chrome.runtime.sendMessage({ type: 'TUYUL_CDP_TYPE', text: val, clear: true }).catch(() => {});
      await sleep(250);
    }
  }

  async function ensureSingleSpeaker() {
    const btn = [...document.querySelectorAll('button, [role="tab"], [role="radio"]')].filter(visible)
      .find((b) => /single[- ]speaker/i.test(`${b.innerText || ''} ${b.getAttribute('aria-label') || ''}`));
    if (!btn) return;
    const active = btn.getAttribute('aria-selected') === 'true' || btn.getAttribute('aria-pressed') === 'true' || btn.getAttribute('aria-checked') === 'true';
    if (!active) {
      await clickReal(btn, 1);
      await sleep(400);
    }
  }

  async function selectVoice(voiceName) {
    if (!voiceName) return;
    const target = voiceName.trim().toLowerCase();
    const btns = [...document.querySelectorAll('button, [role="combobox"], mat-select')].filter(visible);
    const trigger = btns.find((b) => {
      const t = `${b.innerText || ''} ${b.getAttribute('aria-label') || ''}`.toLowerCase();
      return /voice|suara|narrator|speaker/.test(t) && !/multi|single/.test(t);
    });
    if (!trigger) return;
    if ((trigger.innerText || '').toLowerCase().includes(target)) return;
    await clickReal(trigger, 1);
    await sleep(500);
    const opts = [...document.querySelectorAll('.cdk-overlay-pane [role="option"], .cdk-overlay-pane mat-option, .cdk-overlay-pane [role="menuitem"], .cdk-overlay-pane button, [role="listbox"] [role="option"]')].filter(visible);
    const pick = opts.find((o) => (o.innerText || '').trim().toLowerCase().startsWith(target))
      || opts.find((o) => (o.innerText || '').toLowerCase().includes(target));
    if (pick) {
      await clickReal(pick, 1);
      await sleep(400);
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
  }

  function findRunButton() {
    const btns = [...document.querySelectorAll('button')].filter(visible);
    const ranked = btns.map((b) => {
      const txt = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      let s = 0;
      if (/^(run|jalankan)\b/.test(txt) || /^(run|generate)\b/.test(label)) s += 8;
      if (/run ctrl|run cmd|play_arrow/.test(txt) || /\brun\b/.test(label)) s += 5;
      if (/stop|cancel|batal|close|download|unduh|clear/.test(`${txt} ${label}`)) s -= 10;
      return [s, b];
    }).filter(([s]) => s >= 5).sort((a, b) => b[0] - a[0]);
    return ranked[0]?.[1] || null;
  }

  function isRunning() {
    return [...document.querySelectorAll('button')].filter(visible)
      .some((b) => /^(stop|cancel|generating)/i.test((b.innerText || '').trim()));
  }

  function findAiStudioError() {
    const els = [...document.querySelectorAll('[role="alert"], .mat-mdc-snack-bar-label, .error-message')].filter(visible);
    for (const el of els) {
      const txt = (el.innerText || '').trim();
      if (/quota|limit|error|failed|blocked|rate|gagal/i.test(txt)) return txt.slice(0, 220);
    }
    return '';
  }

  function currentAudioSrcs() {
    return new Set([...document.querySelectorAll('audio')].map((a) => a.currentSrc || a.src).filter(Boolean));
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function generateSpeech({ script, styleInstr = '', voice = '', timeoutMs = 120000 }) {
    if (isLoginOrGate()) return { ok: false, needsLogin: true, error: 'Belum login ke Google AI Studio.' };

    status('menyiapkan halaman AI Studio…');
    let inputs = findInputs();
    let openedDialog = false;
    for (let i = 0; i < 20 && !inputs.scriptEl; i++) {
      await sleep(700);
      inputs = findInputs();
      // Halaman Generate Speech terbaru dibuka di galeri; kolom naskah baru ada setelah "Create new dialog".
      if (!inputs.scriptEl && !openedDialog && i >= 2) {
        const dlg = findCreateDialogButton();
        if (dlg) { openedDialog = true; status('membuka dialog baru…'); await clickReal(dlg, 1); await sleep(800); }
      }
    }
    if (!inputs.scriptEl) throw new Error('Kolom naskah di AI Studio tidak ditemukan — pastikan halaman Generate Speech terbuka.');

    await ensureSingleSpeaker();
    if (voice) await selectVoice(voice);
    inputs = findInputs();
    if (inputs.styleEl && styleInstr) await setFieldText(inputs.styleEl, styleInstr);
    await setFieldText(inputs.scriptEl, script);
    await sleep(300);

    const prevSrcs = currentAudioSrcs();
    const runBtn = findRunButton();
    if (!runBtn || runBtn.disabled || runBtn.getAttribute('aria-disabled') === 'true') {
      throw new Error('Tombol Run di AI Studio tidak aktif atau tidak ditemukan.');
    }

    status('membuat suara di AI Studio…');
    await clickReal(runBtn, 1);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(800);
      const err = findAiStudioError();
      if (err && !isRunning()) throw new Error(`AI Studio: ${err}`);

      const freshAudio = [...document.querySelectorAll('audio')].find((a) => {
        const s = a.currentSrc || a.src || '';
        return s && !prevSrcs.has(s) && /^(blob:|data:audio|https?:)/.test(s);
      });
      if (freshAudio && !isRunning()) {
        status('mengambil hasil audio…');
        await sleep(300);
        const res = await fetch(freshAudio.currentSrc || freshAudio.src);
        const blob = await res.blob();
        const base64 = await blobToBase64(blob);
        status('suara siap ✓');
        return { ok: true, mimeType: blob.type || 'audio/wav', base64 };
      }

      // Cadangan jika UI memakai tombol Download tanpa <audio src>
      if (!isRunning() && Date.now() > deadline - timeoutMs + 5000) {
        const dl = [...document.querySelectorAll('button, a')].filter(visible)
          .find((b) => /\b(download|unduh)\b/i.test(`${b.innerText || ''} ${b.getAttribute('aria-label') || ''}`));
        if (dl && !prevSrcs.size && document.querySelectorAll('audio').length === 0) {
          await clickReal(dl, 1);
          status('mengunduh audio…');
          return { ok: true, viaDownload: true };
        }
      }
    }
    throw new Error('Timeout menunggu suara selesai dibuat di Google AI Studio.');
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'KLIPIN_AISTUDIO_PING') {
      const { scriptEl } = findInputs();
      sendResponse({
        ok: true,
        url: location.href,
        isSpeechPage: /generate-speech/i.test(location.pathname),
        needsLogin: isLoginOrGate(),
        ready: !!scriptEl,
      });
      return false;
    }
    if (msg?.type === 'KLIPIN_AISTUDIO_SPEECH') {
      generateSpeech(msg).then(sendResponse, (e) => {
        status(`gagal — ${e.message}`);
        sendResponse({ ok: false, error: e.message });
      });
      return true;
    }
    return false;
  });
})();
