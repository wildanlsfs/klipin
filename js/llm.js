// Lapisan AI multi-provider:
// - Gemini (native) + banyak endpoint OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek, 9Router, Ollama, custom)
// - Provider dipilih per tugas, dengan cadangan otomatis ke provider lain yang sudah dikonfigurasi
// - TTS: Gemini, OpenAI-compatible (/audio/speech), ElevenLabs
// - Transkrip: Gemini (audio inline) atau Whisper-compatible (/audio/transcriptions)

import { decodeFile } from './audio.js';
import { VISUAL_STYLES, THUMB_TYPES, THUMB_TONE } from './data.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

export const PRESETS = {
  openai: {
    name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    sttModel: 'whisper-1', ttsModel: 'gpt-4o-mini-tts', keyUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash',
    sttModel: '', ttsModel: '', keyUrl: 'https://openrouter.ai/keys',
  },
  groq: {
    name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile',
    sttModel: 'whisper-large-v3', ttsModel: '', keyUrl: 'https://console.groq.com/keys',
  },
  deepseek: {
    name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    sttModel: '', ttsModel: '', keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  ninerouter: {
    name: '9Router', base: 'https://api.9router.com/v1', model: '',
    sttModel: '', ttsModel: '', keyUrl: '',
  },
  ollama: {
    name: 'Ollama (lokal)', base: 'http://localhost:11434/v1', model: 'llama3.1',
    sttModel: '', ttsModel: '', keyUrl: '',
  },
  custom: { name: 'Custom', base: '', model: '', sttModel: '', ttsModel: '', keyUrl: '' },
};

export const TASKS = {
  title: 'Kembangkan judul',
  script: 'Tulis naskah',
  scene: 'Prompt scene',
  transcribe: 'Transkrip audio',
  youtube: 'Paket YouTube',
};

export const DEFAULT_SETTINGS = {
  version: 2,
  gemini: { key: '', model: 'gemini-3.8-flash', ttsModel: 'gemini-2.5-flash-preview-tts' },
  compat: [], // [{ id, preset, name, base, key, model, sttModel, ttsModel }]
  eleven: { key: '', model: 'eleven_multilingual_v2' },
  tasks: { title: 'gemini', script: 'gemini', scene: 'gemini', transcribe: 'gemini', youtube: 'gemini' },
  fallback: true,
  rules: {}, // { script: [{ id, on, text, label? }], scene: [...] } — hanya yang diubah/ditambah pengguna
  styleOverrides: {}, // { <id gaya bawaan>: prompt pengganti }
  customStyles: [], // [{ id, label, emoji, prompt }]
};

// Aturan prompt bawaan. Pengguna bisa mematikan, mengubah teks, atau menambah aturan sendiri
// (⚙︎ Pengaturan → Aturan prompt); yang tidak diubah tetap mengikuti teks bawaan versi terbaru.
export const DEFAULT_RULES = {
  script: [
    { id: 'hook', label: 'Pembuka 3 detik', text: 'Kalimat PERTAMA (≤3 detik, maks ±10 kata) langsung ke inti: klaim tajam, kontras, atau angka mengejutkan tentang topik. Tanpa salam, tanpa pengantar ("Pernahkah kamu…", "Di video ini…"), tanpa menjelaskan latar dulu. Kalimat kedua memberi alasan untuk terus menonton (janji jawaban/akibat).' },
    { id: 'core10', label: 'Inti dalam 10 detik', text: 'Dalam 10 detik pertama (±3 kalimat) sudah muncul angka/kontras inti yang konkret (contoh: margin A vs margin B). JANGAN membuka dengan simulasi panjang ("Misalnya kamu beli 10 kg…", "Bayangkan…"). Hitungan atau contoh baru boleh SETELAH kontras inti disebut, dan dibuat ringkas.' },
    { id: 'comment', label: 'Pertanyaan komentar (video panjang)', for: 'long', text: 'Di sepertiga awal video (sekitar 25–40% durasi), sisipkan SATU pertanyaan komentar berupa dilema spesifik dari pengalaman penonton, terkait langsung dengan bagian yang sedang dibahas (contoh: "Pernah hitung susut bobot waktu bikin fillet? Berapa persen? Tulis di komentar."). Hindari ajakan umum seperti "Bagaimana pendapatmu?". Setelah itu lanjutkan isi seperti biasa.' },
    { id: 'density', label: 'Padat informasi', text: 'Setiap 1–2 kalimat harus memberi informasi baru (fakta, angka, akibat, atau perbandingan). Tanpa kalimat pengisi, pengulangan, atau basa-basi transisi ("Nah, sekarang kita bahas…").' },
    { id: 'narration', label: 'Hanya narasi', text: 'Hanya teks yang dibacakan narator. TANPA judul bagian, label adegan, instruksi visual, tanda kurung, emoji, markdown, atau nomor.' },
    { id: 'tts', label: 'Enak dibacakan TTS', text: 'Paragraf pendek (2–4 kalimat), dipisah baris kosong. Kalimat tidak terlalu panjang supaya enak dibacakan TTS.' },
    { id: 'facts', label: 'Fakta akurat', text: 'Fakta harus akurat; jika ada yang belum pasti, sebutkan sebagai dugaan/teori.' },
    { id: 'wayforward', label: 'Jalan keluar, bukan hanya masalah', text: 'Kalau hitungan atau ceritanya berujung tipis, rugi, atau merugikan, jangan berhenti di situ: sebelum penutup, beri jalan keluar konkret yang bisa dilakukan penonton (syarat supaya untung, mis. skala atau harga jual minimal; cara menekan biaya terbesar; atau pilihan yang lebih baik). Tetap jujur: jangan membesar-besarkan untung maupun rugi.' },
    { id: 'commentEnd', label: 'Pertanyaan komentar di akhir (Shorts)', for: 'short', text: 'JANGAN menyela hitungan atau penjelasan di tengah video dengan ajakan komentar; isi mengalir tanpa jeda sampai jawaban utama keluar. SATU pertanyaan komentar diletakkan di akhir, tepat setelah jawaban: dilema spesifik yang membelah opini (contoh: "Kamu pilih jual langsung ke konsumen, atau tetap lewat tengkulak?"). Hindari ajakan umum seperti "Bagaimana pendapatmu?".' },
    { id: 'cta', label: 'Ajakan di penutup', text: 'Penutup: langsung tuntaskan poin terakhir atau jawaban utama, lalu 1 kalimat ajakan (kirim video ini ke orang spesifik yang butuh, contoh: "Kirim ke teman yang lagi mulai ternak.", atau subscribe).' },
    { id: 'nofarewell', label: 'Tanpa kata pamitan', text: 'JANGAN memakai kalimat penutup yang memberi sinyal video selesai, seperti "Jadi, kesimpulannya…", "Itulah…", "Sekian video kali ini", "Terima kasih sudah menonton", atau "Sampai jumpa". Penonton langsung keluar saat mendengarnya.' },
    { id: 'loop', label: 'Loop ke pembuka (Shorts; hanya jika kotak 🔁 Loop dicentang)', for: 'short', text: 'Mode loop: kalimat PERTAMA dan kalimat PALING AKHIR dirancang sebagai satu lingkaran, supaya saat video terputar ulang otomatis akhirnya terdengar menyambung ke awal. Tulis pembuka dulu, lalu tutup dengan SATU kalimat penyambung pendek (maks ±12 kata) yang MENGGANTUNG: berakhir dengan titik dua atau koma, belum selesai secara makna, dan baru "dijawab/dilengkapi" oleh kalimat pembuka saat video terulang. Suara TTS membaca titik dan tanda tanya dengan nada turun (terdengar selesai), sedangkan titik dua dan koma menahan nada, jadi hindari penutup bertitik atau bertanda tanya. JANGAN mengulang kalimat pembuka dan JANGAN terpotong di tengah kata. Contoh: penutup "Jadi sebelum kamu mulai jual maggot, ingat satu hal:" → pembuka "Maggot BSF laku Rp10 ribu, tapi untung bisa cuma Rp2 ribu."; penutup "Dan semua itu bermuara pada satu angka:" → pembuka "Untung Rp2 ribu dari Rp10 ribu." Kalimat penyambung ini menggantikan pertanyaan komentar di akhir; jangan ada kata pamitan setelahnya. Urutan akhir: jawaban utama → jalan keluar → ajakan → kalimat penyambung.' },
    { id: 'sections', label: 'Bagian jelas (video panjang)', for: 'long', text: 'Susun 4–7 bagian berurutan, masing-masing membahas satu sub-topik (nanti jadi bab YouTube). Kalimat pertama tiap bagian langsung menyebut isinya, tanpa judul bagian.' },
    { id: 'bridge', label: 'Jembatan ke video lain (video panjang)', for: 'long', text: 'Kalimat terakhir menjembatani ke topik berikutnya yang masih berkaitan (contoh: "Tapi hitungan ini tidak ada artinya kalau salah memilih bibit. Itu kita bedah di video berikutnya."), bukan pamitan.' },
    { id: 'rehook', label: 'Pancingan berkala (video panjang)', for: 'long', text: 'Setiap ±45–60 detik buka pertanyaan atau janji baru yang baru dijawab beberapa paragraf kemudian, supaya penonton bertahan. Jawaban/hitungan utama dibuka menjelang akhir, bukan di awal.' },
  ],
  scene: [
    { id: 'describe', label: 'Isi prompt', text: '1–3 kalimat, deskripsikan subjek, aksi, latar, komposisi kamera, dan suasana yang MENGGAMBARKAN isi narasi.' },
    { id: 'stylefirst', label: 'Gaya di depan', text: 'Selalu awali dengan deskripsi gaya visual di atas agar konsisten.' },
    { id: 'hookimg', label: 'Scene 1 = hook', text: 'Scene 1 adalah hook: buat gambar paling mencolok yang langsung MEMPERLIHATKAN kontras/klaim di narasinya (mis. dua pilihan berdampingan, sebelum–sesudah, perbandingan besar–kecil), bukan suasana pembuka.' },
    { id: 'cast', label: 'Tokoh berulang & antagonis', text: 'Tokoh yang muncul berulang diberi ciri tetap yang sama di setiap scene (mis. peternak bercaping, pembeli membawa tas belanja). Pihak yang merugikan dalam cerita (tengkulak, rentenir, biaya tak terduga) digambarkan sebagai tokoh antagonis dengan ciri jelas yang konsisten, mis. stickman berkacamata hitam dan berjas, supaya cerita terasa seperti drama.' },
    { id: 'safe', label: 'Tanpa teks & aman', text: 'Tanpa teks/tulisan/huruf/watermark di gambar. Hindari tokoh nyata yang dikenali, kekerasan grafis, dan konten sensitif.' },
  ],
  thumb: [
    { id: 'gap', label: 'Celah penasaran', text: 'Teks dan gambar melengkapi judul, bukan mengulanginya. Judul memberi topik, thumbnail memberi ketegangan (angka, kontras, atau pertanyaan). Jangan pernah menjawab pertanyaan di judul.' },
    { id: 'honest', label: 'Jujur sesuai isi', text: 'Setiap angka dan klaim di teks harus ada di naskah. Gambar memperlihatkan hal yang benar-benar dibahas di video, bukan hal yang lebih heboh.' },
    { id: 'specific', label: 'Subjek spesifik', text: 'Gambar memakai benda, hewan, tempat, atau tokoh yang disebut di naskah (sebutkan namanya di prompt), bukan simbol umum seperti tumpukan koin atau tanda tanya polos.' },
    { id: 'mobile', label: 'Terbaca di HP', text: 'Satu titik fokus, maks 2 tokoh, ekspresi dan objek besar. Teks maks 4 kata (atau 2×3 kata untuk jenis dua sisi) dan tidak bertumpuk dengan subjek.' },
    { id: 'notext', label: 'Gambar tanpa tulisan', text: 'Prompt gambar wajib menyebut tanpa teks, huruf, angka, logo, atau watermark di gambar; teks ditambahkan Klipin.' },
  ],
};

// Daftar aturan efektif: bawaan (dengan perubahan pengguna) lalu aturan tambahan pengguna.
// Aturan bawaan bisa khusus Shorts (for: 'short', < 2 menit) atau video panjang (for: 'long').
// Tambahan instruksi gaya suara untuk Shorts loop: nada kalimat terakhir menggantung dan energinya sama dengan pembuka.
export const LOOP_STYLE_TAIL = {
  id: ' Video ini diputar ulang otomatis: jaga energi, tempo, dan tinggi nada kalimat terakhir sama seperti kalimat pertama, dan bacakan kalimat terakhir dengan nada menggantung (jangan turun menutup), seolah langsung dilanjutkan.',
  en: ' This video replays automatically: keep the energy, pace and pitch of the last sentence the same as the first, and read the last sentence with a suspended, unresolved tone (do not fall as if finished), as if it continues straight on.',
};

export const ruleApplies = (r, minutes) => !r.for || r.for === (minutes == null ? r.for : minutes < 2 ? 'short' : 'long');
export function rulesFor(s, kind) {
  const defs = DEFAULT_RULES[kind] || [];
  const user = s.rules?.[kind] || [];
  const byId = new Map(user.map((r) => [r.id, r]));
  return [
    ...defs.map((d) => {
      const u = byId.get(d.id) || {};
      return { ...d, builtin: true, on: u.on !== false, text: u.text ?? d.text };
    }),
    ...user.filter((r) => !defs.some((d) => d.id === r.id)).map((r) => ({ label: '', ...r, builtin: false, on: r.on !== false })),
  ];
}

// Simpan hanya selisih dari bawaan, supaya perbaikan aturan bawaan di versi baru tetap sampai ke pengguna.
export function compactRules(kind, list) {
  const defs = new Map((DEFAULT_RULES[kind] || []).map((d) => [d.id, d]));
  return list.flatMap((r) => {
    const d = defs.get(r.id);
    if (!d) return r.text.trim() ? [{ id: r.id, label: r.label || '', on: r.on, text: r.text.trim() }] : [];
    const text = r.text.trim();
    const diff = { id: r.id };
    if (!r.on) diff.on = false;
    if (text && text !== d.text) diff.text = text;
    return Object.keys(diff).length > 1 ? [diff] : [];
  });
}

// Gaya visual efektif: bawaan (prompt bisa diganti pengguna) + gaya buatan pengguna.
export function visualStyles(s) {
  return [
    ...VISUAL_STYLES.map((v) => ({ ...v, builtin: true, prompt: s.styleOverrides?.[v.id] || v.prompt })),
    ...(s.customStyles || []).filter((v) => v.prompt?.trim()).map((v) => ({ emoji: '🖌️', ...v, builtin: false })),
  ];
}

// Aturan naskah yang berlaku. Aturan 'loop' hanya jika kotak Loop dicentang; saat itu kalimat
// penyambung menggantikan pertanyaan komentar di akhir ('commentEnd').
export const scriptRules = (s, minutes, loop) => rulesFor(s, 'script').filter((r) => r.on && r.text.trim() && ruleApplies(r, minutes)
  && (r.id === 'loop' ? !!loop : r.id === 'commentEnd' ? !loop : true));

const ruleLines = (s, kind, minutes, loop) => (kind === 'script' ? scriptRules(s, minutes, loop) : rulesFor(s, kind).filter((r) => r.on && r.text.trim() && ruleApplies(r, minutes)))
  .map((r) => `- ${r.text.trim()}`).join('\n');

export const OPENAI_VOICES = [
  { id: 'onyx', name: 'Onyx', gender: 'L', desc: 'Dalam, berwibawa' },
  { id: 'echo', name: 'Echo', gender: 'L', desc: 'Jernih, tenang' },
  { id: 'ash', name: 'Ash', gender: 'L', desc: 'Hangat, ekspresif' },
  { id: 'ballad', name: 'Ballad', gender: 'L', desc: 'Lembut, bercerita' },
  { id: 'verse', name: 'Verse', gender: 'L', desc: 'Dinamis' },
  { id: 'fable', name: 'Fable', gender: 'L', desc: 'Storyteller' },
  { id: 'alloy', name: 'Alloy', gender: 'P', desc: 'Netral' },
  { id: 'nova', name: 'Nova', gender: 'P', desc: 'Cerah, energik' },
  { id: 'shimmer', name: 'Shimmer', gender: 'P', desc: 'Lembut' },
  { id: 'coral', name: 'Coral', gender: 'P', desc: 'Ramah' },
  { id: 'sage', name: 'Sage', gender: 'P', desc: 'Tenang, bijak' },
];

const uid = () => `c_${Math.random().toString(36).slice(2, 9)}`;

export function newCompat(preset = 'openai') {
  const p = PRESETS[preset] || PRESETS.custom;
  return { id: uid(), preset, name: p.name, base: p.base, key: '', model: p.model, sttModel: p.sttModel, ttsModel: p.ttsModel };
}

// Pengaturan versi 1 (satu provider) → versi 2.
function migrate(old) {
  if (!old) return structuredClone(DEFAULT_SETTINGS);
  if (old.version === 2) {
    const d = structuredClone(DEFAULT_SETTINGS);
    return {
      ...d, ...old,
      gemini: { ...d.gemini, ...old.gemini },
      eleven: { ...d.eleven, ...old.eleven },
      tasks: { ...d.tasks, youtube: old.tasks?.script || 'gemini', ...old.tasks }, // tugas baru ikut provider naskah
      compat: old.compat || [],
    };
  }
  const s = structuredClone(DEFAULT_SETTINGS);
  s.gemini = { key: old.geminiKey || '', model: old.geminiModel || s.gemini.model, ttsModel: old.ttsModel || s.gemini.ttsModel };
  if (old.openaiKey) {
    const isOpenAI = /api\.openai\.com/.test(old.openaiBase || '');
    const c = newCompat(isOpenAI ? 'openai' : 'custom');
    Object.assign(c, { base: old.openaiBase || c.base, key: old.openaiKey, model: old.openaiModel || c.model });
    s.compat.push(c);
    if (old.provider === 'openai') s.tasks = { title: c.id, script: c.id, scene: c.id, youtube: c.id, transcribe: isOpenAI ? c.id : 'gemini' };
  }
  return s;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return migrate(settings);
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ settings: s });
}

const isLocal = (base) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base || '');

export function providers(s) {
  return [
    { id: 'gemini', type: 'gemini', name: 'Gemini', ready: !!s.gemini.key, model: s.gemini.model },
    ...s.compat.map((c) => ({
      id: c.id, type: 'compat', name: c.name || PRESETS[c.preset]?.name || 'Custom',
      ready: !!c.base && (!!c.key || isLocal(c.base)), model: c.model, cfg: c,
    })),
  ];
}

const CAPABLE = {
  title: (p) => p.ready && !!p.model,
  script: (p) => p.ready && !!p.model,
  scene: (p) => p.ready && !!p.model,
  youtube: (p) => p.ready && !!p.model,
  transcribe: (p) => p.ready && (p.type === 'gemini' || !!p.cfg.sttModel),
};

export function capableProviders(s, task) {
  return providers(s).filter(CAPABLE[task]);
}

let notify = () => {};
export function setNotifier(fn) { notify = fn; }

function order(s, task) {
  const all = capableProviders(s, task);
  const primary = all.find((p) => p.id === s.tasks[task]);
  const rest = all.filter((p) => p !== primary);
  const list = primary ? [primary, ...(s.fallback ? rest : [])] : s.fallback ? rest : [];
  if (!list.length) {
    throw new Error(`Belum ada provider siap untuk "${TASKS[task]}". Isi API key di ⚙︎ Pengaturan.`);
  }
  if (!primary) notify(`Provider utama "${TASKS[task]}" belum siap → pakai ${list[0].name}`);
  return list;
}

async function withFallback(s, task, fn) {
  const list = order(s, task);
  let lastErr;
  for (let k = 0; k < list.length; k++) {
    try {
      return await fn(list[k]);
    } catch (e) {
      lastErr = e;
      console.warn(`[Klipin] ${list[k].name} gagal (${task})`, e);
      if (k < list.length - 1) notify(`${list[k].name} gagal: ${e.message.slice(0, 90)} → coba ${list[k + 1].name}`);
    }
  }
  throw lastErr;
}

async function request(url, opts, label) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error(`Tidak bisa terhubung ke ${label} (cek Base URL / koneksi / izin akses).`);
  }
  if (res.ok) return res;
  const j = await res.json().catch(() => ({}));
  const msg = j.error?.message || j.detail?.message || (typeof j.detail === 'string' ? j.detail : '') || j.message;
  const err = new Error(`${label}: ${msg || `HTTP ${res.status}`}`);
  err.status = res.status;
  throw err;
}

// ---------------------------------------------------------------- teks

// Model Pro tidak tersedia di API key gratis (kuota "limit: 0"), dan model lama (mis. 2.5 Flash) ditutup untuk
// akun baru → otomatis turun ke model Flash terbaru.
const FREE_FALLBACK = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'];
// Cadangan TTS yang masih menerima instruksi gaya di dalam teks (model TTS 3.8 membaca teks apa adanya).
const TTS_FALLBACK = ['gemini-3.1-flash-tts-preview'];
const blockedModels = new Set(); // model yang kuotanya habis/0 selama panel ini terbuka

const isQuotaErr = (e) => e.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(e.message);
// model tidak ada / sudah ditutup untuk akun ini ("no longer available to new users")
const isGoneErr = (e) => e.status === 404 || /no longer available|not found for API|is not supported|has been deprecated/i.test(e.message);

function friendlyQuota(e, model) {
  const free = /free_?tier|limit: 0/i.test(e.message);
  const wait = e.message.match(/retry in ([\d.]+h)?([\d.]+m)?/i);
  return new Error(free
    ? `Gemini: kuota gratis model ${model} habis atau tidak tersedia untuk API key gratis. Pilih model Flash di ⚙︎ Pengaturan, aktifkan billing di Google AI Studio, atau tambah provider lain (Groq/OpenRouter).${wait ? ` Coba lagi dalam ${wait[0].replace(/retry in /i, '')}.` : ''}`
    : `Gemini: batas permintaan tercapai untuk ${model}. Tunggu sebentar lalu coba lagi.`);
}

async function geminiCall(s, body, model) {
  const res = await request(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.gemini.key },
    body: JSON.stringify(body),
  }, 'Gemini');
  return res.json();
}

async function geminiGenerate(s, body, model = s.gemini.model) {
  if (!s.gemini.key) throw new Error('Gemini API key belum diisi.');
  const textModel = model === s.gemini.model;
  const fallback = textModel ? [model.replace(/-pro\b/, '-flash'), ...FREE_FALLBACK] : model === s.gemini.ttsModel ? TTS_FALLBACK : [];
  const chain = [...new Set([model, ...fallback])].filter((m) => !blockedModels.has(m));
  let first;
  for (const m of chain.length ? chain : [model]) {
    try {
      const j = await geminiCall(s, body, m);
      if (m !== model && first) notify(isGoneErr(first) ? `Model Gemini ${model} tidak tersedia untuk akunmu → memakai ${m}` : `Kuota Gemini ${model} habis → memakai ${m}`);
      return j;
    } catch (e) {
      first ||= e;
      // kuota habis atau model tidak tersedia → coba model berikutnya; error lain langsung dilaporkan
      if (!isQuotaErr(e) && !isGoneErr(e)) throw e;
      if (isGoneErr(e) || /limit: 0|per day/i.test(e.message)) blockedModels.add(m); // bukan batas per menit
    }
  }
  if (isGoneErr(first)) throw new Error(`Gemini: model ${model} tidak tersedia untuk API key ini. Pilih model lain di ⚙︎ Pengaturan (mis. gemini-3.8-flash).`);
  throw isQuotaErr(first) ? friendlyQuota(first, model) : first;
}

async function geminiText(s, prompt, json) {
  const j = await geminiGenerate(s, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: json ? { responseMimeType: 'application/json' } : {},
  });
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error('Respons Gemini kosong (mungkin diblokir safety filter).');
  return text;
}

function compatHeaders(c, json = true) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}),
    ...(c.preset === 'openrouter' ? { 'X-Title': 'Klipin' } : {}),
  };
}

async function compatChat(c, prompt, json) {
  const base = c.base.replace(/\/+$/, '');
  const send = (withFormat) => request(`${base}/chat/completions`, {
    method: 'POST',
    headers: compatHeaders(c),
    body: JSON.stringify({
      model: c.model,
      messages: [{ role: 'user', content: prompt }],
      ...(withFormat ? { response_format: { type: 'json_object' } } : {}),
    }),
  }, c.name);
  let res;
  try {
    res = await send(json);
  } catch (e) {
    // tidak semua endpoint mendukung response_format → ulangi tanpa itu
    if (json && e.status === 400) res = await send(false);
    else throw e;
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`Respons ${c.name} kosong.`);
  return text;
}

function rawText(s, p, prompt, json) {
  return p.type === 'gemini' ? geminiText(s, prompt, json) : compatChat(p.cfg, prompt, json);
}

export function parseJSON(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/[\[{][\s\S]*[\]}]/);
  if (m) return JSON.parse(m[0]);
  throw new Error('Gagal membaca JSON dari AI.');
}

export function generateText(s, task, prompt) {
  return withFallback(s, task, (p) => rawText(s, p, prompt, false));
}

// JSON yang rusak juga dianggap gagal → lanjut ke provider cadangan.
export function generateJSON(s, task, prompt, validate = () => true) {
  return withFallback(s, task, async (p) => {
    const out = parseJSON(await rawText(s, p, prompt, true));
    if (!validate(out)) throw new Error('Format jawaban AI tidak sesuai.');
    return out;
  });
}

// ---------------------------------------------------------------- daftar model

export async function listModels(s, target) {
  if (target === 'gemini') {
    if (!s.gemini.key) throw new Error('Isi Gemini API key dulu.');
    const j = await (await request(`${GEMINI_BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': s.gemini.key } }, 'Gemini')).json();
    return (j.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .sort();
  }
  if (target === 'eleven') {
    if (!s.eleven.key) throw new Error('Isi ElevenLabs API key dulu.');
    const j = await (await request(`${ELEVEN_BASE}/models`, { headers: { 'xi-api-key': s.eleven.key } }, 'ElevenLabs')).json();
    return j.filter((m) => m.can_do_text_to_speech !== false).map((m) => m.model_id);
  }
  const c = s.compat.find((x) => x.id === target);
  if (!c?.base) throw new Error('Isi Base URL dulu.');
  const j = await (await request(`${c.base.replace(/\/+$/, '')}/models`, { headers: compatHeaders(c, false) }, c.name)).json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

// ---------------------------------------------------------------- prompt per tugas

export async function expandTitle(s, raw, lang) {
  const out = await generateJSON(s, 'title', `Kamu adalah ahli judul YouTube untuk channel faceless edukasi/dokumenter.
Kembangkan judul/ide mentah berikut menjadi 5 judul video yang lebih menarik, rapi, memancing rasa penasaran, tetap jujur (tidak menyesatkan), dan SEO-friendly.
Bahasa judul: ${lang === 'en' ? 'English' : 'Bahasa Indonesia'}. Maksimal 70 karakter per judul.

Ide mentah: """${raw}"""

Balas HANYA JSON: {"titles": ["...", "..."]}`, (o) => Array.isArray(o) || Array.isArray(o.titles));
  const titles = Array.isArray(out) ? out : out.titles;
  return titles.filter((t) => typeof t === 'string' && t.trim()).slice(0, 5);
}

const countWords = (t) => (t.match(/\S+/g) || []).length;
const cleanScript = (t) => t.trim().replace(/^\s*[#*].*$/gm, '').replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim();

export async function writeScript(s, { title, format, style, minutes, lang, wpm, loop }) {
  const words = Math.round(minutes * wpm);
  const rules = ruleLines(s, 'script', minutes, loop);
  let script = cleanScript(await generateText(s, 'script', `Tulis naskah voiceover untuk video YouTube faceless.

Judul: "${title}"
Format konten: ${format.label} — ${format.hint}
Gaya narasi: ${style.script}
Target durasi: ±${minutes} menit (≈${words} kata, toleransi ±10%)
Bahasa: ${lang === 'en' ? 'English' : 'Bahasa Indonesia yang natural (bukan terjemahan kaku)'}

Aturan:
${rules}`));
  // AI sering meleset jauh dari target kata (terutama naskah panjang) → satu kali revisi panjang naskah
  const n = countWords(script);
  if (n < words * 0.85 || n > words * 1.2) {
    const longer = n < words;
    const fixed = cleanScript(await generateText(s, 'script', `Naskah voiceover berikut ${longer ? 'terlalu pendek' : 'terlalu panjang'}: ${n} kata, targetnya ±${words} kata (±${minutes} menit).
Tulis ulang LENGKAP menjadi ±${words} kata. ${longer ? 'Tambah isi yang benar-benar baru (fakta, angka, contoh, akibat), bukan mengulang atau memperlambat.' : 'Pangkas bagian yang paling lemah atau berulang, pertahankan pembuka, angka inti, dan penutup.'}
Judul: "${title}". Gaya narasi: ${style.script}. Tetap patuhi aturan:
${rules}

Naskah:
${script}

Balas hanya dengan naskah barunya.`));
    if (Math.abs(countWords(fixed) - words) < Math.abs(n - words)) script = fixed;
  }
  return script;
}

export async function scenePrompts(s, { title, visualStyle, ratio, scenes, characterNote }) {
  const list = scenes.map((x) => `${x.i}. ${x.text}`).join('\n');
  const out = await generateJSON(s, 'scene', `Kamu adalah art director untuk video faceless "${title}".
Buat prompt gambar (Bahasa Inggris) untuk setiap scene narasi di bawah. Gambar akan dibuat dengan Google Flow (Imagen), rasio ${ratio}.

Gaya visual WAJIB (sama di semua scene): ${visualStyle.prompt}
${characterNote ? `Konsistensi karakter/tempat: ${characterNote}` : ''}

Aturan prompt:
${ruleLines(s, 'scene', null)}

Scene:
${list}

Balas HANYA JSON: {"scenes":[{"i":<nomor>,"prompt":"..."}]}`, (o) => Array.isArray(o) || Array.isArray(o.scenes));
  return Array.isArray(out) ? out : out.scenes;
}

// Paket upload YouTube: judul, deskripsi, tag, teks & prompt thumbnail, bab (chapters).
export async function youtubePack(s, { title, script, scenes, lang, ratio }) {
  const en = lang === 'en';
  const list = scenes.map((x) => `${x.i}. [${x.t}] ${x.text.slice(0, 140)}`).join('\n');
  const out = await generateJSON(s, 'youtube', `Kamu adalah strategist YouTube untuk channel faceless edukasi/dokumenter yang ahli CTR & SEO.
Buat paket upload untuk video berikut. Bahasa output: ${en ? 'English' : 'Bahasa Indonesia yang natural'} (kecuali "thumbPrompt": Bahasa Inggris).

Judul kerja: "${title}"
Naskah (ringkas):
${script.slice(0, 5000)}

Scene bertimestamp (nomor. [waktu] narasi):
${list.slice(0, 7000)}

Isi JSON:
- "titles": 5 judul berbeda sudut (rasa penasaran, angka/fakta, konflik, pertanyaan, manfaat). Maks 70 karakter, kata kunci utama di depan, jujur — tidak clickbait palsu, tidak HURUF BESAR SEMUA.
- "description": deskripsi siap tempel. 2 baris pertama = hook + kata kunci (tampil sebelum "lainnya"). Lalu 1 paragraf ringkasan isi, lalu ajakan subscribe/komentar dengan pertanyaan spesifik. JANGAN tulis timestamp/bab dan hashtag di sini (ditambahkan otomatis).
- "chapters": 4–8 bab, scene pertama wajib nomor 1. Format {"scene": <nomor scene awal bab>, "title": "<judul bab 2–5 kata>"}.
- "tags": 12–20 tag pencarian (gabungan luas & spesifik), tanpa tanda #.
- "hashtags": 3 hashtag relevan, dengan #.
- "thumbTexts": 4 teks thumbnail SANGAT pendek (2–4 kata), emosional/penasaran, BUKAN pengulangan judul.
- "thumbPrompt": prompt gambar thumbnail YouTube rasio ${ratio || '16:9'}: satu subjek fokus, ekspresi/aksi dramatis, kontras tinggi, warna mencolok, latar sederhana, ruang kosong ${ratio === '9:16' ? 'di bagian atas' : 'di sisi kiri'} untuk teks, tanpa teks/huruf di gambar, tanpa tokoh nyata.

Balas HANYA JSON: {"titles":[],"description":"","chapters":[],"tags":[],"hashtags":[],"thumbTexts":[],"thumbPrompt":""}`,
  (o) => Array.isArray(o.titles) && o.titles.length && typeof o.description === 'string');
  const strs = (a) => (Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  return {
    titles: strs(out.titles).slice(0, 6),
    description: out.description.trim(),
    chapters: (Array.isArray(out.chapters) ? out.chapters : []).filter((c) => c && Number(c.scene) && c.title),
    tags: strs(out.tags).map((t) => t.replace(/^#/, '')),
    hashtags: strs(out.hashtags).map((t) => (t.startsWith('#') ? t : `#${t}`).replace(/\s+/g, '')).slice(0, 5),
    thumbTexts: strs(out.thumbTexts).slice(0, 6),
    thumbPrompt: typeof out.thumbPrompt === 'string' ? out.thumbPrompt.trim() : '',
  };
}

// Konsep thumbnail: untuk tiap jenis yang dipilih, satu teks + satu prompt latar yang mengikuti isi naskah,
// format, gaya narasi, dan gaya visual proyek. Hasil: [{ type, idea, text, color, prompt }].
export async function thumbConcepts(s, { title, script, format, narrStyle, visualStyle, ratio, lang, types }) {
  const en = lang === 'en';
  const tall = ratio === '9:16';
  const list = types.map((id) => THUMB_TYPES.find((t) => t.id === id)).filter(Boolean);
  const spot = (t) => (t.layout === 'split' ? (tall ? 'atas dan bawah (masing-masing bagian)' : 'atas tiap belahan')
    : t.layout === 'bottom' ? (tall ? 'bawah (di atas 15% terbawah)' : 'bawah') : tall ? 'atas' : 'kiri');
  const out = await generateJSON(s, 'youtube', `Kamu adalah desainer thumbnail YouTube untuk channel faceless. Tugasmu membuat konsep thumbnail yang membuat orang PENASARAN untuk mengklik, tanpa menipu.

Video:
- Judul: "${title}"
- Format cerita: ${format.label} (${format.hint})
- Gaya narasi: ${narrStyle.label}; nada teks thumbnail: ${THUMB_TONE[narrStyle.id] || 'sesuai gaya narasi'}
- Rasio: ${ratio || '16:9'}${tall ? ' (vertikal, Shorts)' : ''}
- Gaya visual (WAJIB sama dengan video): ${visualStyle.prompt}

Naskah:
${script.slice(0, 6000)}

Buat SATU konsep untuk setiap jenis berikut, persis sesuai aturannya:
${list.map((t, k) => `${k + 1}. "${t.id}" (${t.label})
   Teks: ${t.text}
   Gambar: ${t.image}
   Ruang kosong untuk teks: ${spot(t)}.`).join('\n')}

Aturan untuk semua konsep:
${ruleLines(s, 'thumb', null)}

Isi tiap konsep:
- "type": id jenisnya.
- "idea": 1 kalimat ${en ? 'English' : 'Bahasa Indonesia'} untuk pengguna: kenapa konsep ini bikin penasaran dan apa yang terlihat.
- "text": teks thumbnail ${en ? 'English' : 'Bahasa Indonesia'} sesuai aturan jenisnya.
- "color": warna aksen teks: "yellow", "white", atau "red".
- "prompt": prompt gambar Bahasa Inggris 2–4 kalimat: diawali gaya visual di atas, lalu subjek spesifik dari naskah, komposisi sesuai jenis, ekspresi, pencahayaan, ruang kosong untuk teks, dan "no text, no letters, no numbers, no logos, no watermark".

Balas HANYA JSON: {"concepts":[{"type":"","idea":"","text":"","color":"","prompt":""}]}`,
  (o) => Array.isArray(o.concepts) && o.concepts.length);
  return out.concepts
    .filter((c) => c && typeof c.text === 'string' && typeof c.prompt === 'string' && list.some((t) => t.id === c.type))
    .map((c) => ({
      type: c.type,
      idea: String(c.idea || '').trim(),
      text: c.text.trim(),
      color: ['yellow', 'white', 'red'].includes(c.color) ? c.color : 'yellow',
      prompt: c.prompt.trim(),
    }));
}

// Teks besar untuk 2 detik pertama video: kontras/angka inti dari pembuka naskah, supaya penonton
// yang sedang menggulir langsung melihat alasan untuk berhenti.
export async function hookText(s, { title, script, lang }) {
  const en = lang === 'en';
  const out = await generateJSON(s, 'youtube', `Video pendek berjudul "${title}". Kalimat pembuka naskahnya:
${script.split(/\n\s*\n/).slice(0, 2).join('\n').slice(0, 600)}

Seluruh naskah (untuk mengecek arti tiap angka):
${script.slice(0, 2500)}

Tulis teks besar yang tampil di layar selama 2 detik pertama video, supaya orang yang sedang menggulir berhenti.
Aturan:
- Ambil kontras atau angka INTI dari kalimat pembuka (bukan dari bagian lain), dan hanya fakta yang ada di naskah.
- Kalau intinya perbandingan dua angka/hal, tulis dua sisi dipisah " | ", masing-masing 2–4 kata. Tiap angka WAJIB diberi label singkat apa angka itu, supaya tidak disangka angka lain (mis. disangka untung): "HARGA Rp25 RB | IKAN Rp5 RB", "JUAL Rp100 RB | MODAL Rp60 RB", "35 HARI | 3 BULAN".
- Kalau bukan, tulis satu frasa 2–5 kata (contoh: "70% TIDAK SAMPAI KE PETANI").
- Angka harus sama persis dengan naskah dan tetap bermakna sama (biaya tetap biaya, untung tetap untung). Jangan membulatkan atau menghitung ulang.
- Jangan mengulang judul kata per kata dan jangan menjawab pertanyaannya. Tanpa emoji dan tanpa tanda pagar.
- Bahasa: ${en ? 'English' : 'Bahasa Indonesia'}.

Balas HANYA JSON: {"text":""}`, (o) => typeof o.text === 'string' && o.text.trim());
  return out.text.trim().replace(/\s*\|\s*/g, ' | ');
}

// Angka penting di layar: untuk scene yang narasinya menyebut angka kunci, teks pendek bergaya catatan
// (mis. "Pakan −Rp3,8 JT"). Hasil: [{ i, text }].
export async function sceneCallouts(s, { title, scenes, lang }) {
  const en = lang === 'en';
  const list = scenes.map((x) => `${x.i}. ${x.text.slice(0, 220)}`).join('\n');
  const out = await generateJSON(s, 'scene', `Video "${title}". Narasi per scene:
${list.slice(0, 9000)}

Pilih scene yang narasinya menyebut ANGKA KUNCI (harga, biaya, untung/rugi, persen, jumlah, lama waktu), lalu tulis teks catatan pendek yang tampil di layar selama scene itu, seperti angka yang dicoret di papan tulis.
Aturan:
- Hanya angka yang benar-benar disebut di narasi scene itu. Tulis dengan digit dan singkatan (Rp25 JT, Rp3.800, 70%, 45 HARI, 10 EKOR).
- Maks 5 kata, tanpa label urutan (jangan "Pertama:", "Kedua:"). Boleh perbandingan/perubahan dengan "→" (contoh: "Rp100 RB → Rp60 RB", "Modal Rp25 JT", "Pakan −Rp7,2 JT").
- Maks sekitar 40% dari jumlah scene; lewati scene tanpa angka atau yang angkanya tidak penting. Scene 1 dilewati (sudah ada teks hook).
- Jangan mengulang teks yang sama di dua scene berturut-turut.
- Bahasa: ${en ? 'English' : 'Bahasa Indonesia'}.

Balas HANYA JSON: {"callouts":[{"i":<nomor scene>,"text":""}]}`, (o) => Array.isArray(o.callouts));
  const ids = new Set(scenes.map((x) => x.i));
  return out.callouts
    .filter((c) => c && ids.has(Number(c.i)) && Number(c.i) !== 1 && typeof c.text === 'string' && c.text.trim())
    .map((c) => ({ i: Number(c.i), text: c.text.trim().slice(0, 40) }));
}

export async function characterBible(s, { title, script, visualStyle }) {
  try {
    const out = await generateJSON(s, 'scene', `Dari naskah video "${title}" berikut, tulis catatan singkat (maks 70 kata, Bahasa Inggris) tentang tokoh utama, tempat, dan era yang akan muncul berulang, supaya gambar antar scene konsisten. Beri tiap tokoh ciri visual tetap; pihak yang merugikan dalam cerita (mis. tengkulak) jadikan tokoh antagonis dengan ciri jelas (mis. sunglasses and a dark suit). Gaya visual: ${visualStyle.label}.
Naskah:
${script.slice(0, 6000)}

Balas JSON: {"note":"..."}`);
    return out.note || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- TTS

export function ttsEngines(s) {
  return [
    { id: 'gemini', kind: 'gemini', name: 'Gemini', ready: !!s.gemini.key },
    ...s.compat.filter((c) => c.ttsModel).map((c) => ({
      id: c.id, kind: 'openai', name: c.name, ready: !!c.base && (!!c.key || isLocal(c.base)),
    })),
    { id: 'eleven', kind: 'eleven', name: 'ElevenLabs', ready: !!s.eleven.key },
  ];
}

export async function elevenVoices(s) {
  if (!s.eleven.key) throw new Error('Isi ElevenLabs API key di ⚙︎ Pengaturan.');
  const j = await (await request(`${ELEVEN_BASE}/voices`, { headers: { 'xi-api-key': s.eleven.key } }, 'ElevenLabs')).json();
  return (j.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    gender: v.labels?.gender === 'female' ? 'P' : v.labels?.gender === 'male' ? 'L' : '',
    desc: [v.labels?.description, v.labels?.accent, v.labels?.use_case].filter(Boolean).join(', '),
  }));
}

function chunkText(text, max) {
  const paras = text.split(/\n\s*\n/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > max && cur) { chunks.push(cur); cur = p; }
    else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  // paragraf tunggal yang terlalu panjang dipotong per kalimat
  return chunks.flatMap((c) => {
    if (c.length <= max) return [c];
    const out = [];
    let buf = '';
    for (const sent of c.split(/(?<=[.!?…])\s+/)) {
      if ((buf + ' ' + sent).length > max && buf) { out.push(buf); buf = sent; }
      else buf = buf ? `${buf} ${sent}` : sent;
    }
    if (buf) out.push(buf);
    return out;
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function ttsGeminiChunk(s, text, styleInstruction, voice) {
  // Instruksi gaya + teks yang dipisah jelas; kalau model tetap "menjawab" dengan teks
  // ("Model tried to generate text…"), ulangi, lalu terakhir tanpa instruksi gaya.
  const prompts = [
    `${styleInstruction}\nBacakan transkrip berikut persis apa adanya, tanpa menambah atau mengubah kata:\n\n${text}`,
    `${styleInstruction}\nBacakan transkrip berikut persis apa adanya, tanpa menambah atau mengubah kata:\n\n${text}`,
    `Read aloud exactly:\n\n${text}`,
  ];
  let j;
  for (let k = 0; ; k++) {
    try {
      j = await geminiGenerate(s, {
        contents: [{ role: 'user', parts: [{ text: styleInstruction ? prompts[k] : prompts[2] }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }, s.gemini.ttsModel);
      break;
    } catch (e) {
      if (k >= prompts.length - 1 || !/generate text/i.test(e.message)) throw e;
    }
  }
  const data = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!data) throw new Error('Gemini TTS tidak mengembalikan audio.');
  const bytes = base64ToBytes(data);
  const view = new DataView(bytes.buffer);
  const f = new Float32Array(bytes.length / 2);
  for (let k = 0; k < f.length; k++) f[k] = view.getInt16(k * 2, true) / 32768;
  return { samples: f, sampleRate: 24000 };
}

async function ttsOpenAIChunk(c, text, styleInstruction, voice) {
  const res = await request(`${c.base.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: compatHeaders(c),
    body: JSON.stringify({
      model: c.ttsModel,
      voice,
      input: text,
      response_format: 'wav',
      // hanya model gpt-4o-*-tts yang mengerti instruksi gaya
      ...(/gpt-4o/.test(c.ttsModel) && styleInstruction ? { instructions: styleInstruction } : {}),
    }),
  }, `${c.name} TTS`);
  return decodeFile(await res.blob());
}

async function ttsElevenChunk(s, text, voice, prev, next) {
  const res = await request(`${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': s.eleven.key },
    body: JSON.stringify({
      text,
      model_id: s.eleven.model,
      // konteks kalimat sebelum/sesudah supaya intonasi antar potongan nyambung
      ...(prev ? { previous_text: prev.slice(-500) } : {}),
      ...(next ? { next_text: next.slice(0, 500) } : {}),
    }),
  }, 'ElevenLabs');
  return decodeFile(await res.blob());
}

/** Mengembalikan { samples: Float32Array mono, sampleRate }. */
export async function synthesize(s, { engine, text, styleInstruction, voice, onProgress }) {
  const eng = ttsEngines(s).find((e) => e.id === engine);
  if (!eng) throw new Error('Mesin suara tidak ditemukan. Cek ⚙︎ Pengaturan.');
  if (!eng.ready) throw new Error(`${eng.name} belum dikonfigurasi (⚙︎ Pengaturan).`);
  if (!voice) throw new Error('Pilih suara narator dulu.');

  const max = eng.kind === 'openai' ? 3500 : 2500;
  const parts = chunkText(text, max);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    onProgress?.(i, parts.length);
    if (eng.kind === 'gemini') out.push(await ttsGeminiChunk(s, parts[i], styleInstruction, voice));
    else if (eng.kind === 'openai') out.push(await ttsOpenAIChunk(s.compat.find((c) => c.id === engine), parts[i], styleInstruction, voice));
    else out.push(await ttsElevenChunk(s, parts[i], voice, parts[i - 1], parts[i + 1]));
  }
  onProgress?.(parts.length, parts.length);
  const sampleRate = out[0].sampleRate;
  const total = out.reduce((n, a) => n + a.samples.length, 0);
  const samples = new Float32Array(total);
  let off = 0;
  for (const a of out) { samples.set(a.samples, off); off += a.samples.length; }
  return { samples, sampleRate };
}

// ---------------------------------------------------------------- transkrip

// Gemini kadang menulis waktu sebagai "1:05.2" / "00:01:05" alih-alih detik.
const toSec = (v) => {
  if (typeof v === 'number') return v;
  const parts = String(v ?? '').trim().replace(',', '.').split(':').map(Number);
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return NaN;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
};

async function transcribeGemini(s, chunks, lang) {
  const segments = [];
  for (const { base64, offset, duration } of chunks) {
    const j = await geminiGenerate(s, {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: base64 } },
          { text: `Transkripsikan audio narasi ini (${lang === 'en' ? 'English' : 'Bahasa Indonesia'}) per kalimat dengan timestamp dalam DETIK (angka desimal, relatif dari awal audio ini, durasi audio ${duration.toFixed(1)} detik).
Tulis waktu sebagai angka detik (contoh 65.2, BUKAN "1:05"). Jangan lewatkan kalimat apa pun.
Balas HANYA JSON: {"segments":[{"start":0.0,"end":2.4,"text":"..."}]}` },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json' },
    });
    const out = parseJSON(j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '');
    for (const seg of Array.isArray(out) ? out : out.segments || []) {
      // waktu yang tidak terbaca tetap disimpan teksnya; nanti diselaraskan ke jeda audio
      const st = toSec(seg.start), en = toSec(seg.end);
      const start = Math.max(0, Math.min(duration, Number.isFinite(st) ? st : 0)) + offset;
      const end = Math.max(start, Math.min(duration, Number.isFinite(en) ? en : 0) + offset);
      if (seg.text) segments.push({ start, end, text: String(seg.text).trim() });
    }
  }
  return segments;
}

async function transcribeWhisper(c, chunks, lang) {
  const segments = [];
  for (const { blob, offset } of chunks) {
    const fd = new FormData();
    fd.append('file', blob, 'audio.wav');
    fd.append('model', c.sttModel);
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'segment');
    fd.append('language', lang === 'en' ? 'en' : 'id');
    const res = await request(`${c.base.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST', headers: compatHeaders(c, false), body: fd,
    }, `${c.name} transkrip`);
    const j = await res.json();
    if (!Array.isArray(j.segments)) throw new Error(`Model ${c.sttModel} tidak memberi timestamp (butuh model Whisper).`);
    for (const seg of j.segments) {
      const text = String(seg.text || '').trim();
      if (text && seg.end > seg.start) segments.push({ start: seg.start + offset, end: seg.end + offset, text });
    }
  }
  return segments;
}

/** chunks: [{ blob, base64, offset, duration }] dari audio.wavChunksForTranscription */
export async function transcribe(s, { chunks, lang }) {
  const segs = await withFallback(s, 'transcribe', async (p) => {
    const out = p.type === 'gemini' ? await transcribeGemini(s, chunks, lang) : await transcribeWhisper(p.cfg, chunks, lang);
    if (!out.length) throw new Error('Transkrip kosong.');
    return out;
  });
  return segs; // urutan teks dipertahankan; timestamp yang kacau ditangani alignTranscript
}
