// UI pengaturan AI (provider, model, tugas, ElevenLabs).
// Dipasang di dialog ⚙︎ side panel dan di halaman Options (chrome-extension://…/options.html).

import * as llm from './llm.js';
import { h, toast, errMsg, fillSelect } from './dom.js';
import { VISUAL_STYLES } from './data.js';

const modelCache = new Map(); // target → daftar model (bertahan selama halaman terbuka)

// Saring daftar model sesuai jenis kolom; kalau hasilnya kosong, tampilkan semua.
const KIND_FILTER = {
  text: (m) => !/(tts|whisper|transcribe|embed|dall-e|imagen|image|moderation|realtime|audio|veo|aqa)/i.test(m),
  tts: (m) => /tts/i.test(m),
  stt: (m) => /(whisper|transcribe)/i.test(m),
  any: () => true,
};

// Izin host untuk endpoint custom harus diminta langsung dari klik pengguna.
function requestOrigins(bases) {
  const origins = [...new Set(bases.map((b) => { try { return `${new URL(b).origin}/*`; } catch { return null; } }).filter(Boolean))];
  if (!origins.length) return Promise.resolve(true);
  return chrome.permissions.request({ origins }).catch(() => false);
}

/**
 * @param {HTMLElement} root
 * @param {{ onSaved?: (s) => void, onCancel?: () => void }} hooks
 * @returns {{ load: (settings) => void }}
 */
export function mountSettings(root, { onSaved, onCancel } = {}) {
  let draft = null; // salinan pengaturan yang sedang diedit
  let rules = null; // { script: [...], scene: [...], thumb: [...] } daftar aturan efektif yang sedang diedit
  let styles = null; // gaya visual efektif yang sedang diedit

  const taskMap = h('div', { class: 'task-map' });
  const fallback = h('input', { type: 'checkbox', onchange: (e) => { draft.fallback = e.target.checked; } });
  const cards = h('div', {});
  const addPreset = h('select', {});
  const elevenKey = h('input', {
    type: 'password', autocomplete: 'off', placeholder: 'sk_…',
    oninput: (e) => { draft.eleven.key = e.target.value.trim(); },
    onchange: () => reloadModels('eleven'),
  });
  const elevenBox = h('div', {});
  const ruleBoxes = { script: h('div', {}), scene: h('div', {}), thumb: h('div', {}) };
  const styleBox = h('div', {});

  root.replaceChildren(
    h('div', { class: 'card' },
      h('h3', {}, '🧭 Tugas → provider'),
      taskMap,
      h('label', { class: 'check' }, fallback, ' Cadangan otomatis: kalau provider gagal, pindah ke provider lain yang siap')),
    h('h3', { class: 'sec' }, '🔌 Provider teks'),
    cards,
    h('div', { class: 'row add-row' },
      addPreset,
      h('button', { class: 'btn', onclick: addProvider }, '＋ Tambah provider')),
    h('h3', { class: 'sec' }, '🎙️ ElevenLabs (suara)'),
    h('div', { class: 'card' },
      h('label', {}, 'API key ', h('a', { href: 'https://elevenlabs.io/app/settings/api-keys', target: '_blank' }, 'ambil ↗')),
      elevenKey,
      elevenBox),
    h('h3', { class: 'sec' }, '✍️ Aturan prompt'),
    h('p', { class: 'hint' }, 'Aturan yang dikirim ke AI saat menulis naskah, prompt gambar, dan konsep thumbnail. Matikan, ubah teksnya, atau tambah aturan sendiri. Aturan bawaan yang tidak kamu ubah ikut diperbarui saat Klipin update.'),
    rulesCard('script', '📝 Naskah'),
    rulesCard('scene', '🖼️ Prompt gambar (scene)'),
    rulesCard('thumb', '🎯 Thumbnail'),
    h('h3', { class: 'sec' }, '🎨 Gaya visual'),
    h('details', { class: 'card' },
      h('summary', {}, 'Prompt gaya visual'),
      h('p', { class: 'hint' }, 'Deskripsi gaya ini ditaruh di depan setiap prompt gambar. Ubah gaya bawaan atau tambah gaya sendiri; gaya baru muncul di pilihan langkah 3.'),
      styleBox,
      h('button', { class: 'btn', onclick: addStyle }, '＋ Tambah gaya')),
    h('div', { class: 'row sticky-actions' },
      h('button', { class: 'btn', onclick: () => onCancel?.() }, 'Batal'),
      h('button', { class: 'btn primary', onclick: save }, 'Simpan')),
  );

  // Dropdown model: diisi daftar dari provider (↻ / otomatis), plus opsi ketik manual.
  function modelField(label, value, onInput, target, kind = 'text', optional = false) {
    let cur = value || '';
    let models = modelCache.get(target) || [];
    const sel = h('select', {});
    const input = h('input', {
      class: 'hidden', value: cur, placeholder: 'ketik nama model…',
      oninput: (e) => { cur = e.target.value.trim(); onInput(cur); },
    });
    const fill = () => {
      const filtered = models.filter(KIND_FILTER[kind]);
      const list = [...new Set([cur, ...(filtered.length ? filtered : models)].filter(Boolean))];
      sel.replaceChildren(
        h('option', { value: '', selected: !cur }, optional ? '— tidak dipakai —' : '— pilih model —'),
        ...list.map((m) => h('option', { value: m, selected: m === cur }, m)),
        h('option', { value: '__manual' }, '✏️ Ketik manual…'),
      );
      sel.title = models.length ? `${list.length} model tersedia` : 'Klik ↻ untuk memuat daftar model';
    };
    sel.addEventListener('change', () => {
      if (sel.value === '__manual') {
        input.classList.remove('hidden');
        input.value = cur;
        input.focus();
        sel.value = cur;
        return;
      }
      cur = sel.value;
      input.classList.add('hidden');
      onInput(cur);
    });
    fill();
    const row = h('div', { class: 'model-row' },
      sel,
      h('button', { class: 'icon-btn', title: 'Muat daftar model dari provider', 'data-models': target }, '↻'));
    row.setModels = (list) => { models = list; fill(); };
    return [h('label', {}, label), row, input];
  }

  function renderTaskMap() {
    const all = llm.providers(draft);
    taskMap.replaceChildren(...Object.entries(llm.TASKS).flatMap(([task, label]) => {
      const capable = llm.capableProviders(draft, task).map((p) => p.id);
      const options = all.filter((p) => task !== 'transcribe' || p.type === 'gemini' || p.cfg.sttModel);
      return [
        h('span', {}, label),
        h('select', { onchange: (e) => { draft.tasks[task] = e.target.value; } },
          options.map((p) => h('option', { value: p.id, selected: draft.tasks[task] === p.id },
            `${p.name} — ${p.model || 'model belum diisi'}${capable.includes(p.id) ? '' : ' (belum siap)'}`))),
      ];
    }));
  }

  function providerCard(p) {
    const status = () => {
      const pr = llm.providers(draft).find((x) => x.id === (p === 'gemini' ? 'gemini' : p.id));
      return h('span', { class: `pill ${pr?.ready ? 'ok' : ''}` }, pr?.ready ? 'siap' : 'belum siap');
    };
    let card;
    const refresh = () => { card.querySelector('.pill').replaceWith(status()); renderTaskMap(); };

    if (p === 'gemini') {
      const g = draft.gemini;
      card = h('div', { class: 'card' },
        h('div', { class: 'prov-head' }, h('b', { style: 'flex:1' }, '✦ Google Gemini'), status()),
        h('label', {}, 'API key ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank' }, 'ambil gratis ↗')),
        h('input', { type: 'password', autocomplete: 'off', placeholder: 'AIza…', value: g.key, oninput: (e) => { g.key = e.target.value.trim(); refresh(); }, onchange: () => reloadModels('gemini') }),
        ...modelField('Model teks', g.model, (v) => { g.model = v; refresh(); }, 'gemini', 'text'),
        ...modelField('Model TTS (suara)', g.ttsModel, (v) => { g.ttsModel = v; }, 'gemini', 'tts'),
        h('p', { class: 'hint' }, 'Gemini juga dipakai untuk transkrip audio & suara (TTS).'));
      return card;
    }

    const c = p;
    const preset = llm.PRESETS[c.preset] || llm.PRESETS.custom;
    card = h('div', { class: 'card' },
      h('div', { class: 'prov-head' },
        h('input', { value: c.name, title: 'Nama provider', oninput: (e) => { c.name = e.target.value; renderTaskMap(); } }),
        status(),
        h('button', {
          class: 'icon-btn', title: 'Hapus provider',
          onclick: () => {
            draft.compat = draft.compat.filter((x) => x !== c);
            for (const t of Object.keys(draft.tasks)) if (draft.tasks[t] === c.id) draft.tasks[t] = 'gemini';
            render();
          },
        }, '✕')),
      h('label', {}, 'Base URL'),
      h('input', { value: c.base, placeholder: 'https://…/v1', oninput: (e) => { c.base = e.target.value.trim(); refresh(); }, onchange: () => reloadModels(c.id) }),
      h('label', {}, 'API key ', preset.keyUrl ? h('a', { href: preset.keyUrl, target: '_blank' }, 'ambil ↗') : null),
      h('input', {
        type: 'password', autocomplete: 'off', value: c.key,
        placeholder: c.preset === 'ollama' ? 'tidak perlu untuk Ollama' : 'sk-…',
        oninput: (e) => { c.key = e.target.value.trim(); refresh(); },
        onchange: () => reloadModels(c.id),
      }),
      ...modelField('Model teks', c.model, (v) => { c.model = v; refresh(); }, c.id, 'text'),
      ...modelField('Model transkrip (opsional)', c.sttModel, (v) => { c.sttModel = v; refresh(); }, c.id, 'stt', true),
      ...modelField('Model TTS (opsional)', c.ttsModel, (v) => { c.ttsModel = v; }, c.id, 'tts', true),
      c.preset === 'ollama'
        ? h('p', { class: 'hint' }, 'Jalankan Ollama dengan OLLAMA_ORIGINS="chrome-extension://*" supaya extension boleh mengakses.')
        : c.preset === 'ninerouter' ? h('p', { class: 'hint' }, 'Cocokkan Base URL dengan yang tertera di dashboard 9Router kamu.') : null);
    return card;
  }

  function rulesCard(kind, title) {
    return h('details', { class: 'card' },
      h('summary', {}, title),
      ruleBoxes[kind],
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { rules[kind].push({ id: `u_${Date.now().toString(36)}`, label: '', text: '', on: true, builtin: false }); renderRules(kind); } }, '＋ Tambah aturan'),
        h('button', { class: 'btn', onclick: () => { rules[kind] = llm.rulesFor({}, kind); renderRules(kind); } }, '↺ Kembalikan bawaan')));
  }

  function renderRules(kind) {
    const defs = new Map(llm.DEFAULT_RULES[kind].map((d) => [d.id, d.text]));
    ruleBoxes[kind].replaceChildren(...rules[kind].map((r) => {
      const text = h('textarea', { rows: 3, placeholder: 'Tulis aturannya…', oninput: (e) => { r.text = e.target.value; } }, r.text);
      return h('div', { class: 'rule' },
        h('div', { class: 'prov-head' },
          h('input', { type: 'checkbox', title: 'Pakai aturan ini', checked: r.on, onchange: (e) => { r.on = e.target.checked; } }),
          r.builtin
            ? h('b', { style: 'flex:1' }, r.label)
            : h('input', { style: 'flex:1', value: r.label, placeholder: 'Nama aturan', oninput: (e) => { r.label = e.target.value; } }),
          r.builtin
            ? h('button', { class: 'icon-btn', title: 'Kembalikan teks bawaan', onclick: () => { r.text = defs.get(r.id); text.value = r.text; } }, '↺')
            : h('button', { class: 'icon-btn', title: 'Hapus aturan', onclick: () => { rules[kind] = rules[kind].filter((x) => x !== r); renderRules(kind); } }, '✕')),
        text);
    }));
  }

  function renderStyles() {
    const defs = new Map(VISUAL_STYLES.map((v) => [v.id, v.prompt]));
    styleBox.replaceChildren(...styles.map((v) => {
      const text = h('textarea', { rows: 3, placeholder: 'Deskripsi gaya dalam Bahasa Inggris…', oninput: (e) => { v.prompt = e.target.value; } }, v.prompt);
      return h('div', { class: 'rule' },
        h('div', { class: 'prov-head' },
          v.builtin
            ? h('b', { style: 'flex:1' }, `${v.emoji} ${v.label}`)
            : [h('input', { class: 'emoji', value: v.emoji, title: 'Emoji', oninput: (e) => { v.emoji = e.target.value; } }),
              h('input', { style: 'flex:1', value: v.label, placeholder: 'Nama gaya', oninput: (e) => { v.label = e.target.value; } })],
          v.builtin
            ? h('button', { class: 'icon-btn', title: 'Kembalikan prompt bawaan', onclick: () => { v.prompt = defs.get(v.id); text.value = v.prompt; } }, '↺')
            : h('button', { class: 'icon-btn', title: 'Hapus gaya', onclick: () => { styles = styles.filter((x) => x !== v); renderStyles(); } }, '✕')),
        text);
    }));
  }

  function addStyle() {
    styles.push({ id: `gaya_${Date.now().toString(36)}`, emoji: '🖌️', label: '', prompt: '', builtin: false });
    renderStyles();
    styleBox.lastElementChild.querySelector('input:not([type=checkbox])')?.focus();
  }

  // Aturan & gaya yang sedang diedit → bentuk simpanan (hanya selisih dari bawaan).
  function commitPrompts(next) {
    next.rules = Object.fromEntries(Object.keys(rules).map((k) => [k, llm.compactRules(k, rules[k])]));
    const defs = new Map(VISUAL_STYLES.map((v) => [v.id, v.prompt]));
    next.styleOverrides = Object.fromEntries(styles
      .filter((v) => v.builtin && v.prompt.trim() && v.prompt.trim() !== defs.get(v.id))
      .map((v) => [v.id, v.prompt.trim()]));
    next.customStyles = styles
      .filter((v) => !v.builtin && v.prompt.trim())
      .map(({ id, emoji, label, prompt }) => ({ id, emoji: emoji || '🖌️', label: label.trim() || 'Gaya saya', prompt: prompt.trim() }));
  }

  function render() {
    fallback.checked = draft.fallback;
    elevenKey.value = draft.eleven.key;
    elevenBox.replaceChildren(...modelField('Model', draft.eleven.model, (v) => {
      draft.eleven.model = v || llm.DEFAULT_SETTINGS.eleven.model;
    }, 'eleven', 'any'));
    cards.replaceChildren(providerCard('gemini'), ...draft.compat.map(providerCard));
    renderRules('script');
    renderRules('scene');
    renderRules('thumb');
    renderStyles();
    renderTaskMap();
    autoLoadModels();
  }

  // Muat daftar model otomatis untuk provider yang key-nya sudah ada & izin aksesnya sudah diberikan.
  async function autoLoadModels() {
    for (const p of llm.providers(draft)) {
      if (!p.ready || modelCache.has(p.id)) continue;
      if (p.type === 'compat') {
        let origin;
        try { origin = `${new URL(p.cfg.base).origin}/*`; } catch { continue; }
        if (!(await chrome.permissions.contains({ origins: [origin] }).catch(() => false))) continue;
      }
      loadModels(p.id, { quiet: true });
    }
    if (draft.eleven.key && !modelCache.has('eleven')) loadModels('eleven', { quiet: true });
  }

  function reloadModels(target) {
    modelCache.delete(target);
    autoLoadModels();
  }

  function loadModels(target, { quiet = false } = {}) {
    const btns = [...root.querySelectorAll(`[data-models="${target}"]`)];
    btns.forEach((b) => { b.disabled = true; b.textContent = '…'; });
    return llm.listModels(draft, target)
      .then((models) => {
        modelCache.set(target, models);
        btns.forEach((b) => b.parentElement.setModels?.(models));
        if (!quiet) toast(`${models.length} model dimuat — pilih dari dropdown.`, 'ok');
      })
      .catch((err) => { if (!quiet) toast(errMsg(err), 'err'); })
      .finally(() => btns.forEach((b) => { b.disabled = false; b.textContent = '↻'; }));
  }

  function addProvider() {
    const preset = addPreset.value;
    const c = llm.newCompat(preset);
    // nama unik kalau preset yang sama ditambah dua kali
    const same = draft.compat.filter((x) => x.preset === preset).length;
    if (same) c.name = `${c.name} ${same + 1}`;
    draft.compat.push(c);
    render();
    cards.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Tombol ↻ di samping kolom model → ambil daftar model dari provider.
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-models]');
    if (!btn) return;
    const target = btn.dataset.models;
    const c = draft.compat.find((x) => x.id === target);
    (c ? requestOrigins([c.base]) : Promise.resolve(true)).then(() => loadModels(target));
  });

  function save() {
    const next = draft;
    commitPrompts(next);
    for (const c of next.compat) c.name = c.name.trim() || llm.PRESETS[c.preset]?.name || 'Custom';
    requestOrigins(next.compat.map((c) => c.base)).then(async (granted) => {
      await llm.saveSettings(next);
      draft = structuredClone(next);
      toast(granted ? 'Pengaturan disimpan ✓' : 'Disimpan, tapi izin akses ke sebagian endpoint ditolak.', granted ? 'ok' : 'err');
      onSaved?.(structuredClone(next));
    });
  }

  return {
    load(settings) {
      draft = structuredClone(settings);
      rules = { script: llm.rulesFor(draft, 'script'), scene: llm.rulesFor(draft, 'scene'), thumb: llm.rulesFor(draft, 'thumb') };
      styles = llm.visualStyles({ ...draft, customStyles: [] }).concat((draft.customStyles || []).map((v) => ({ ...v, builtin: false })));
      fillSelect(addPreset, Object.entries(llm.PRESETS).map(([k, p]) => [k, p.name]), 'openai');
      render();
    },
  };
}
