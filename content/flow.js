// Klipin — otomasi Google Flow (flow.google.com / labs.google/fx/tools/flow).
// Menerima prompt dari side panel, mengetik ke kolom prompt Flow, menekan tombol generate,
// menunggu gambar baru muncul, lalu mengirim gambarnya kembali ke side panel.
(() => {
  if (window.__tuyulFlow) return;
  window.__tuyulFlow = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const seen = new Set(); // src gambar yang sudah ada / sudah dipakai
  let busy = false;

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  function findInput() {
    const byId = document.getElementById('PINHOLE_TEXT_AREA_ELEMENT_ID');
    if (visible(byId)) return byId;
    const tas = [...document.querySelectorAll('textarea')].filter(visible);
    if (tas.length) return tas.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    return [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')].find(visible) || null;
  }

  function setInputValue(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text); // agar React mendeteksi perubahan
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }

  function findSubmit(input) {
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const score = (b) => {
      const txt = (b.innerText || '').trim().toLowerCase();
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      let s = 0;
      const title = (b.getAttribute('title') || '').toLowerCase();
      if (/arrow_forward|arrow_upward|send/.test(txt)) s += 5;
      if (/^(create|generate|buat|kirim|send|submit)\b/.test(label) || /^(create|generate|buat)$/.test(txt)) s += 4;
      if (/send|kirim|submit|generate|buat/.test(`${label} ${title}`)) s += 3;
      if (/stop|hentikan|cancel|batal|close|tutup|attach|lampir|setting|setelan|tambah|add|media|upload|unggah|mic|tune|edit/.test(`${label} ${title} ${txt}`)) s -= 10;
      if (input) {
        // tombol di dalam kotak composer yang sama dengan kolom prompt (UI chat Flow baru)
        const box = composerOf(input);
        if (box && box.contains(b)) s += 3;
        // tombol yang dekat dengan kolom prompt lebih mungkin tombol kirim
        const a = input.getBoundingClientRect(), r = b.getBoundingClientRect();
        const dist = Math.hypot(r.left - a.right, r.top - a.bottom);
        if (dist < 260) s += 2;
        // tombol kirim biasanya paling kanan-bawah di composer
        if (box && box.contains(b) && r.right >= box.getBoundingClientRect().right - 80) s += 1;
      }
      return s;
    };
    const ranked = buttons.map((b) => [score(b), b]).filter(([s]) => s >= 5).sort((a, b) => b[0] - a[0]);
    return ranked[0]?.[1] || null;
  }

  // naik beberapa level dari kolom prompt sampai ketemu wadah yang juga berisi tombol
  function composerOf(input) {
    let el = input;
    for (let i = 0; i < 6 && el.parentElement; i++) {
      el = el.parentElement;
      if (el.querySelectorAll('button').length >= 1 && el.getBoundingClientRect().height < 700) return el;
    }
    return null;
  }

  const inputText = (el) => ((el.value ?? el.innerText) || '').trim();
  const isDisabled = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true';

  function pressEnter(el) {
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  // Kirim prompt dan pastikan benar-benar terkirim (kolom prompt kosong/berubah).
  // Kalau Flow masih sibuk menyelesaikan respons sebelumnya, klik bisa diabaikan → ulangi.
  async function submitPrompt(prompt, label) {
    const deadline = Date.now() + 90000;
    for (let attempt = 1; Date.now() < deadline; attempt++) {
      let input = findInput();
      if (!input) { await sleep(1000); continue; }
      if (inputText(input) !== prompt.trim()) {
        setInputValue(input, prompt);
        await sleep(500);
      }
      const btn = findSubmit(input);
      if (btn && !isDisabled(btn)) btn.click();
      else if (attempt % 2 === 0) pressEnter(input); // cadangan: Enter di kolom prompt
      else { status(`${label}: menunggu Flow siap…`); await sleep(1500); continue; }

      // terkirim = isi kolom prompt hilang/berubah
      for (let i = 0; i < 16; i++) {
        await sleep(250);
        input = findInput();
        if (!input || inputText(input) !== prompt.trim()) return true;
      }
      if (attempt % 2 === 1 && btn) pressEnter(input); // klik diabaikan → coba Enter sekali
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        input = findInput();
        if (!input || inputText(input) !== prompt.trim()) return true;
      }
      status(`${label}: Flow belum menerima prompt, coba lagi (${attempt})…`);
      await sleep(2000);
    }
    return false;
  }

  function currentImages() {
    return [...document.querySelectorAll('img')].filter(
      (img) => img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256 && img.src && !img.src.startsWith('data:image/svg'),
    );
  }

  function markAllSeen() {
    currentImages().forEach((img) => seen.add(img.currentSrc || img.src));
  }

  async function toDataUrl(img) {
    const src = img.currentSrc || img.src;
    if (src.startsWith('data:')) return src;
    try {
      const res = await fetch(src, { credentials: 'include' });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith('image/')) {
          return await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = reject;
            fr.readAsDataURL(blob);
          });
        }
      }
    } catch {}
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/jpeg', 0.92);
    } catch {}
    return null; // side panel akan coba ambil dari URL langsung
  }

  // ---- Badge status kecil di pojok halaman ----
  let badge;
  function status(text) {
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;left:16px;padding:10px 14px;border-radius:12px;background:#111;color:#fff;font:600 13px system-ui;box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid #333;max-width:360px;pointer-events:none';
      document.body.appendChild(badge);
    }
    badge.textContent = `🎬 Klipin — ${text}`;
    badge.style.display = text ? 'block' : 'none';
  }

  async function generate({ prompt, label, timeoutMs = 180000 }) {
    const input = findInput();
    if (!input) throw new Error('Kolom prompt Flow tidak ditemukan. Buka sebuah project di Flow dulu.');
    status(`${label}: mengetik prompt…`);
    markAllSeen();

    if (!(await submitPrompt(prompt, label))) {
      throw new Error('Prompt tidak terkirim ke Flow (tombol kirim tidak merespons — kredit habis atau Flow masih sibuk?).');
    }
    status(`${label}: menunggu gambar…`);

    const t0 = Date.now();
    let found = null;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1000);
      const fresh = currentImages().filter((img) => !seen.has(img.currentSrc || img.src));
      if (fresh.length) {
        found = fresh.sort((a, b) => b.naturalWidth - a.naturalWidth)[0];
        break;
      }
    }
    if (!found) throw new Error('Timeout: gambar tidak muncul di Flow.');

    // Flow bisa membuat 2–4 gambar per prompt. Kumpulkan SEMUA output prompt ini (dipakai
    // sebagai pilihan alternatif di side panel) dan tunggu sampai jumlahnya stabil, supaya
    // gambar yang datang belakangan tidak dikira hasil scene berikutnya.
    const freshImgs = () => currentImages().filter((img) => !seen.has(img.currentSrc || img.src));
    let last = freshImgs().length, stable = 0;
    while (stable < 5 && Date.now() - t0 < timeoutMs) {
      await sleep(1000);
      const n = freshImgs().length;
      stable = n === last ? stable + 1 : 0;
      last = n;
    }
    await sleep(1200); // beri waktu gambar resolusi penuh termuat
    const outs = [found, ...freshImgs().filter((img) => img !== found)].slice(0, 4);
    const images = [];
    for (const img of outs) {
      const dataUrl = await toDataUrl(img);
      images.push({ image: dataUrl, url: img.currentSrc || img.src });
    }
    // tunggu Flow selesai menulis respons (tombol kirim tidak dalam mode stop/sibuk)
    for (let i = 0; i < 20; i++) {
      const inp = findInput();
      const busyBtn = [...document.querySelectorAll('button')].filter(visible)
        .some((b) => /stop|hentikan/i.test(`${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`));
      if (inp && !inp.disabled && !busyBtn) break;
      await sleep(1000);
    }
    markAllSeen();
    status(`${label}: selesai ✓ (${images.length} gambar)`);
    return { ...images[0], images };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'TUYUL_PING') {
      sendResponse({ ok: true, hasInput: !!findInput(), url: location.href });
      return false;
    }
    if (msg?.type === 'TUYUL_STATUS') {
      status(msg.text || '');
      return false;
    }
    if (msg?.type === 'TUYUL_FLOW_GENERATE') {
      if (busy) { sendResponse({ ok: false, error: 'Flow sedang memproses prompt lain.' }); return false; }
      busy = true;
      // busy dilepas SEBELUM membalas, supaya prompt berikutnya tidak tertolak
      generate(msg)
        .then((r) => { busy = false; sendResponse({ ok: true, ...r }); })
        .catch((e) => { busy = false; status(`gagal — ${e.message}`); sendResponse({ ok: false, error: e.message }); });
      return true; // respons async
    }
    return false;
  });
})();
