import {
  IDEA_BANK, FORMATS, NARRATION_STYLES, DURATIONS, WPM, VISUAL_STYLES, RATIOS, VOICES,
  AI_STUDIO_TTS_URL, FLOW_URL,
} from './data.js';
import * as llm from './llm.js';
import * as audioLib from './audio.js';
import { scenesFromScript, scenesFromTranscript, retimeScenes, fmtTime } from './scenes.js';
import { renderMp4, outputSize } from './render.js';
import { kvGet, kvSet, kvDel } from './store.js';
import { h, toast, errMsg, fillSelect } from './dom.js';
import { checkUpdate, downloadUpdate } from './update.js';
import { mountSettings } from './settings-ui.js';
import { startAgentBridge } from './agent.js';

// ---------------------------------------------------------------- state

const DEFAULT_STATE = {
  step: 1,
  rawTitle: '',
  titleOptions: [],
  title: '',
  format: 'misteri',
  narrStyle: 'dokumenter',
  minutes: 3,
  lang: 'id',
  script: '',
  styleInstr: '',
  styleInstrEdited: false,
  ttsEngine: 'gemini',
  ttsVoices: { gemini: 'Charon', openai: 'onyx', eleven: '' },
  visualStyle: 'stickman',
  ratio: '16:9',
  sceneSec: 6,
  maxPause: 0.35,
  scenes: [],
  res: 1080,
  fps: 30,
  subtitles: true,
  yt: null,
};

let S = structuredClone(DEFAULT_STATE);
let settings = { ...llm.DEFAULT_SETTINGS };
let audioRaw = null;   // { samples, sampleRate } hasil upload / TTS
let audioTrim = null;  // setelah potong jeda
let flowStop = false;
let renderAbort = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kvSet('state', S).catch((e) => console.warn('save', e)), 400);
  updateStepper();
}

async function busy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (e) {
    console.warn(e); // sudah ditampilkan sebagai toast — jangan dicatat sebagai error extension
    toast(errMsg(e), 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

function setProgress(id, pct) {
  const el = $(id);
  el.classList.toggle('hidden', pct == null);
  if (pct != null) el.firstElementChild.style.width = `${Math.round(pct * 100)}%`;
}

const currentAudio = () => audioTrim || audioRaw;
// Naikkan kalau cara menghitung waktu scene/subtitle berubah → proyek lama disinkronkan ulang saat dibuka.
const SYNC_V = 3;

// Jeda bicara di timeline audio yang dipakai (asli atau hasil potong jeda).
let pauseMemo = null;
function audioPauses() {
  const a = currentAudio();
  if (!a) return [];
  if (pauseMemo?.audio === a) return pauseMemo.pauses;
  let pauses = audioLib.findPauses(audioRaw);
  if (audioTrim) {
    const cuts = audioTrim.cuts || audioLib.trimSilence(audioRaw, { maxPause: Number(S.maxPause) }).cuts;
    pauses = audioLib.mapPausesThroughCuts(pauses, cuts);
  }
  pauseMemo = { audio: a, pauses };
  return pauses;
}
const fmtStyle = () => FORMATS.find((f) => f.id === S.format) || FORMATS[0];
const narrStyle = () => NARRATION_STYLES.find((n) => n.id === S.narrStyle) || NARRATION_STYLES[0];
const visualStyle = () => VISUAL_STYLES.find((v) => v.id === S.visualStyle) || VISUAL_STYLES[0];

// ---------------------------------------------------------------- navigation

function updateStepper() {
  const done = {
    1: !!(S.title || S.rawTitle),
    2: !!S.script && !!audioRaw,
    3: S.scenes.length > 0 && S.scenes.every((s) => s.prompt),
    4: S.scenes.length > 0 && S.scenes.every((s) => s.image),
    6: !!S.yt?.desc,
  };
  $$('#stepper button').forEach((b) => {
    const n = Number(b.dataset.step);
    b.classList.toggle('active', n === S.step);
    b.classList.toggle('done', !!done[n] && n !== S.step);
  });
}

async function go(step) {
  if (step === 2 && !S.title) {
    S.title = S.rawTitle.trim();
    if (!S.title) return toast('Tulis atau pilih judul dulu.', 'err');
  }
  // Masuk ke tahap scene: potong jeda otomatis kalau belum.
  if (step === 3 && audioRaw && !audioTrim) doTrim();
  S.step = step;
  $$('.step').forEach((s) => s.classList.toggle('active', Number(s.dataset.step) === step));
  renderStep(step);
  window.scrollTo({ top: 0 });
  save();
}

function renderStep(step) {
  if (step === 2) {
    $('#pickedTitle').textContent = S.title || S.rawTitle || '—';
    refreshStyleInstr();
  }
  if (step === 3) renderScenes();
  if (step === 4) { renderThumbs(); checkFlow(); }
  if (step === 5) renderSummary();
  if (step === 6) renderYt();
}

// ---------------------------------------------------------------- step 1: judul

function renderIdeaCats(active) {
  const cats = Object.keys(IDEA_BANK);
  active ||= cats[0];
  $('#ideaCats').replaceChildren(...cats.map((c) =>
    h('button', { class: `chip ${c === active ? 'active' : ''}`, onclick: () => renderIdeaCats(c) }, c)));
  $('#ideaList').replaceChildren(...IDEA_BANK[active].map((t) =>
    h('button', {
      onclick: () => {
        $('#rawTitle').value = S.rawTitle = t;
        S.title = t;
        S.titleOptions = [];
        renderTitleOptions();
        save();
        toast('Judul dipilih. Klik "Kembangkan Judul" atau langsung lanjut.');
      },
    }, t)));
}

function renderTitleOptions() {
  const box = $('#titleOptions');
  if (!S.titleOptions.length) return box.replaceChildren();
  const opt = (value, text, mine) => h('label', { class: `opt ${mine ? 'mine' : ''}` },
    h('input', {
      type: 'radio', name: 'title', checked: S.title === value,
      onchange: () => { S.title = value; save(); },
    }),
    h('span', {}, text));
  box.replaceChildren(
    ...S.titleOptions.map((t) => opt(t, t, false)),
    opt(S.rawTitle, `Pakai judul saya: "${S.rawTitle}"`, true),
  );
}

$('#rawTitle').addEventListener('input', (e) => {
  const wasRaw = !S.title || S.title === S.rawTitle;
  S.rawTitle = e.target.value;
  if (wasRaw) S.title = S.rawTitle.trim();
  save();
});

$('#expandBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Mengembangkan judul…', async () => {
  const raw = S.rawTitle.trim();
  if (!raw) throw new Error('Tulis judul / ide mentah dulu.');
  S.titleOptions = await llm.expandTitle(settings, raw, S.lang);
  S.title = S.titleOptions[0] || raw;
  renderTitleOptions();
  save();
}));

// ---------------------------------------------------------------- step 2: naskah & suara

function setupSeg(container, get, set) {
  const sync = () => [...container.children].forEach((b) => b.classList.toggle('active', b.dataset.v === String(get())));
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    sync();
    save();
  });
  sync();
  return sync;
}

function refreshStyleInstr() {
  if (!S.styleInstrEdited) S.styleInstr = narrStyle().tts[S.lang] || narrStyle().tts.id;
  $('#styleInstr').value = S.styleInstr;
}

function updateScriptMeta() {
  const words = S.script.trim() ? S.script.trim().split(/\s+/).length : 0;
  const est = words / (WPM[S.lang] || 135);
  $('#scriptMeta').textContent = words ? `${words} kata · ±${est.toFixed(1)} menit` : '';
}

let elevenCache = null;

function ttsEngine() {
  const all = llm.ttsEngines(settings);
  return all.find((e) => e.id === S.ttsEngine) || all[0];
}

// autoPick: saat pengaturan dimuat/berubah, pindah otomatis ke mesin yang sudah siap
function renderTtsEngines(autoPick = false) {
  const engines = llm.ttsEngines(settings);
  const cur = engines.find((e) => e.id === S.ttsEngine);
  if (!cur || (autoPick && !cur.ready)) S.ttsEngine = (engines.find((e) => e.ready) || engines[0]).id;
  $('#ttsEngineSeg').replaceChildren(...engines.map((e) =>
    h('button', {
      class: `${e.id === S.ttsEngine ? 'active' : ''} ${e.ready ? '' : 'off'}`,
      title: e.ready ? '' : 'Belum dikonfigurasi di ⚙︎ Pengaturan',
      onclick: () => { S.ttsEngine = e.id; renderTtsEngines(); save(); },
    }, e.name)));
  renderVoices();
}

async function loadElevenVoices(force = false) {
  if (elevenCache && !force) return elevenCache;
  elevenCache = await llm.elevenVoices(settings);
  return elevenCache;
}

function renderVoices() {
  const eng = ttsEngine();
  const kind = eng.kind;
  $('#refreshVoicesBtn').classList.toggle('hidden', kind !== 'eleven');
  $('#ttsApiBtn').textContent = `⚡ Generate suara langsung via ${eng.name}`;
  $('#ttsApiBtn').disabled = !eng.ready;
  $('#ttsApiBtn').title = eng.ready ? '' : `${eng.name} belum dikonfigurasi — isi API key di ⚙︎ Pengaturan`;
  $('#ttsHint').textContent = !eng.ready
    ? `${eng.name} belum dikonfigurasi — isi di ⚙︎ Pengaturan. Pilihan suara Gemini tetap bisa dipakai di AI Studio.`
    : kind === 'gemini' ? 'Pilih suara yang sama saat membuat di Google AI Studio, atau generate langsung via API.'
    : kind === 'eleven' ? 'Gaya baca ElevenLabs mengikuti karakter suara (style instruction tidak dipakai).'
    : /gpt-4o/.test(settings.compat.find((c) => c.id === eng.id)?.ttsModel || '') ? 'Style instruction ikut dikirim ke model.' : 'Model ini mengabaikan style instruction.';

  const pick = (id) => { S.ttsVoices[kind] = id; renderVoices(); save(); };
  const btn = (v) => h('button', {
    class: `voice ${S.ttsVoices[kind] === v.id ? 'active' : ''}`,
    onclick: () => pick(v.id),
  }, h('b', {}, `${v.name} `), h('span', { class: 'meta' }, v.gender === 'L' ? '♂' : v.gender === 'P' ? '♀' : ''), h('small', {}, v.desc || ''));

  if (kind === 'gemini') return $('#voices').replaceChildren(...VOICES.map((v) => btn({ ...v, id: v.name })));
  if (kind === 'openai') return $('#voices').replaceChildren(...llm.OPENAI_VOICES.map(btn));
  if (!eng.ready) return $('#voices').replaceChildren();
  if (!elevenCache) {
    $('#voices').replaceChildren(h('div', { class: 'hint' }, 'Memuat daftar suara ElevenLabs…'));
    loadElevenVoices().then(renderVoices).catch((e) => {
      $('#voices').replaceChildren(h('div', { class: 'hint' }, `Gagal memuat suara: ${errMsg(e)}`));
    });
    return;
  }
  if (!S.ttsVoices.eleven && elevenCache[0]) S.ttsVoices.eleven = elevenCache[0].id;
  $('#voices').replaceChildren(...elevenCache.map(btn));
}

$('#refreshVoicesBtn').addEventListener('click', () => {
  elevenCache = null;
  renderVoices();
});

$('#format').addEventListener('change', (e) => { S.format = e.target.value; $('#formatHint').textContent = fmtStyle().hint; save(); });
$('#narrStyle').addEventListener('change', (e) => { S.narrStyle = e.target.value; S.styleInstrEdited = false; refreshStyleInstr(); save(); });
$('#minutes').addEventListener('change', (e) => { S.minutes = Number(e.target.value); save(); });
$('#script').addEventListener('input', (e) => { S.script = e.target.value; updateScriptMeta(); save(); });
$('#styleInstr').addEventListener('input', (e) => { S.styleInstr = e.target.value; S.styleInstrEdited = true; save(); });

$('#writeScriptBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Menulis naskah…', async () => {
  const title = S.title || S.rawTitle;
  if (!title) throw new Error('Judul masih kosong.');
  if (S.script.trim() && !confirm('Naskah yang ada akan diganti. Lanjut?')) return;
  S.script = await llm.writeScript(settings, {
    title, format: fmtStyle(), style: narrStyle(), minutes: S.minutes, lang: S.lang, wpm: WPM[S.lang] || 135,
  });
  $('#script').value = S.script;
  updateScriptMeta();
  save();
  toast('Naskah selesai ✓', 'ok');
}));

async function copy(text, what) {
  if (!text.trim()) return toast(`${what} masih kosong.`, 'err');
  await navigator.clipboard.writeText(text);
  toast(`${what} disalin ✓`, 'ok');
}
$('#copyStyleBtn').addEventListener('click', () => copy(S.styleInstr, 'Style instruction'));
$('#copyScriptBtn').addEventListener('click', () => copy(S.script, 'Naskah'));
$('#openStudioBtn').addEventListener('click', async () => {
  if (S.script.trim()) await navigator.clipboard.writeText(S.script).catch(() => {});
  chrome.tabs.create({ url: AI_STUDIO_TTS_URL });
  toast('Naskah sudah disalin ke clipboard — tinggal paste di AI Studio.');
});

$('#ttsApiBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Membuat suara…', async () => {
  if (!S.script.trim()) throw new Error('Naskah masih kosong.');
  const eng = ttsEngine();
  const out = await llm.synthesize(settings, {
    engine: eng.id, text: S.script, styleInstruction: S.styleInstr, voice: S.ttsVoices[eng.kind],
    onProgress: (i, n) => setProgress('#ttsProgress', i / n),
  });
  setProgress('#ttsProgress', null);
  await setAudio(out);
  toast('Suara selesai dibuat ✓', 'ok');
}).finally(() => setProgress('#ttsProgress', null)));

let playerUrl;
function showAudio() {
  const ready = !!audioRaw;
  $('.drop-empty').classList.toggle('hidden', ready);
  $('.drop-ready').classList.toggle('hidden', !ready);
  if (!ready) return;
  $('#audioDur').textContent = fmtTime(audioLib.duration(audioRaw));
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(audioLib.encodeWav(audioRaw));
  $('#audioPlayer').src = playerUrl;
}

async function setAudio(a) {
  audioRaw = a;
  audioTrim = null;
  await kvSet('audioRaw', a);
  await kvDel('audioTrim');
  showAudio();
  showTrim();
  updateStepper();
}

async function loadAudioFile(file) {
  if (!file || !(file.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|aac|flac|webm)$/i.test(file.name))) {
    return toast('File harus berupa audio.', 'err');
  }
  try {
    await setAudio(await audioLib.decodeFile(file));
    toast('Audio siap ✓', 'ok');
  } catch (e) {
    toast(`Gagal membaca audio: ${errMsg(e)}`, 'err');
  }
}

{
  const drop = $('#audioDrop');
  drop.addEventListener('click', (e) => { if (!e.target.closest('audio')) $('#audioFile').click(); });
  $('#audioFile').addEventListener('change', (e) => loadAudioFile(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    loadAudioFile(e.dataTransfer.files[0]);
  });
}

// ---------------------------------------------------------------- step 3: visual, potong jeda, scene

function renderVisualStyles() {
  $('#visualStyles').replaceChildren(...VISUAL_STYLES.map((v) =>
    h('button', {
      class: `style ${S.visualStyle === v.id ? 'active' : ''}`,
      onclick: () => { S.visualStyle = v.id; renderVisualStyles(); save(); },
    }, h('span', {}, v.emoji), v.label)));
}

let trimUrl;
function showTrim() {
  const p = $('#trimPlayer');
  $('#maxPauseVal').textContent = `${Number(S.maxPause).toFixed(2)} detik`;
  if (!audioRaw) {
    $('#trimMeta').textContent = 'belum ada audio';
    p.classList.add('hidden');
    return;
  }
  if (!audioTrim) {
    $('#trimMeta').textContent = `asli ${fmtTime(audioLib.duration(audioRaw))}`;
    p.classList.add('hidden');
    return;
  }
  $('#trimMeta').textContent = `${fmtTime(audioLib.duration(audioRaw))} → ${fmtTime(audioLib.duration(audioTrim))}`;
  if (trimUrl) URL.revokeObjectURL(trimUrl);
  trimUrl = URL.createObjectURL(audioLib.encodeWav(audioTrim));
  p.src = trimUrl;
  p.classList.remove('hidden');
}

// Sinkronkan waktu scene dengan audio: tiap kalimat dicocokkan ke jeda nyata di suara.
function resyncScenes(quiet = false) {
  const a = currentAudio();
  if (!a || !S.scenes.length) {
    if (!quiet) toast(!a ? 'Belum ada audio.' : 'Belum ada scene.', 'err');
    return false;
  }
  retimeScenes(S.scenes, audioLib.duration(a), audioPauses());
  S.syncV = SYNC_V;
  renderScenes();
  save();
  if (!quiet) toast('Waktu scene & subtitle disinkronkan dengan audio ✓', 'ok');
  return true;
}

function doTrim() {
  if (!audioRaw) return toast('Belum ada audio. Upload di langkah Naskah.', 'err');
  const { audio, removed, cuts } = audioLib.trimSilence(audioRaw, { maxPause: Number(S.maxPause) });
  audioTrim = cuts.length ? { ...audio, cuts } : audio;
  kvSet('audioTrim', audioTrim);
  // Jeda yang dibuang tidak merata → waktu scene dihitung ulang dari teks + jeda audio baru
  // (bukan diskalakan rata, yang membuat gambar & subtitle tidak sinkron dengan suara).
  if (S.scenes.length) resyncScenes(true);
  showTrim();
  save();
  toast(`Jeda dipotong: −${removed.toFixed(1)} detik`, 'ok');
}

$('#maxPause').addEventListener('input', (e) => { S.maxPause = Number(e.target.value); showTrim(); save(); });
$('#trimBtn').addEventListener('click', doTrim);
$('#sceneSec').addEventListener('change', (e) => { S.sceneSec = Number(e.target.value); save(); });

function renderScenes() {
  const list = $('#sceneList');
  if (!S.scenes.length) {
    $('#sceneInfo').textContent = '';
    return list.replaceChildren();
  }
  const dur = S.scenes[S.scenes.length - 1].end;
  $('#sceneInfo').textContent = `${S.scenes.length} scene · total ${fmtTime(dur)} · ${S.scenes.filter((s) => s.prompt).length} prompt siap`;
  list.replaceChildren(...S.scenes.map((s) => h('div', { class: `scene ${s.prompt ? 'ready' : ''}`, id: `scene-${s.i}` },
    h('header', {}, h('span', {}, `SCENE ${s.i}`), h('span', {}, `${fmtTime(s.start)} – ${fmtTime(s.end)}`)),
    h('div', { class: 'txt' }, s.text),
    h('textarea', {
      rows: 2, placeholder: 'prompt gambar…',
      oninput: (e) => { s.prompt = e.target.value; save(); },
    }, s.prompt))));
}

async function buildPrompts(btn) {
  const vs = visualStyle();
  const title = S.title || S.rawTitle;
  setProgress('#sceneProgress', 0);
  btn.textContent = '⏳ Menyiapkan konsistensi karakter…';
  const note = await llm.characterBible(settings, { title, script: S.script || S.scenes.map((s) => s.text).join(' '), visualStyle: vs });
  const BATCH = 8;
  for (let b = 0; b < S.scenes.length; b += BATCH) {
    const batch = S.scenes.slice(b, b + BATCH);
    btn.textContent = `⏳ Membuat prompt scene ${b + 1}–${b + batch.length} dari ${S.scenes.length}…`;
    batch.forEach((s) => document.getElementById(`scene-${s.i}`)?.classList.add('working'));
    const out = await llm.scenePrompts(settings, { title, visualStyle: vs, ratio: S.ratio, scenes: batch, characterNote: note });
    for (const o of out) {
      const sc = S.scenes.find((s) => s.i === Number(o.i));
      if (sc && o.prompt) sc.prompt = String(o.prompt).trim();
    }
    // jika AI melewatkan scene, pakai prompt sederhana
    batch.forEach((s) => { if (!s.prompt) s.prompt = `${vs.prompt}. Scene illustrating: ${s.text}`; });
    setProgress('#sceneProgress', (b + batch.length) / S.scenes.length);
    renderScenes();
    save();
  }
  setProgress('#sceneProgress', null);
  toast(`${S.scenes.length} scene siap ✓`, 'ok');
}

function confirmReplaceScenes() {
  return !S.scenes.some((s) => s.image) || confirm('Scene & gambar yang sudah ada akan diganti. Lanjut?');
}

$('#fromScriptBtn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  busy(btn, '⏳ Membuat scene…', async () => {
    if (!S.script.trim()) throw new Error('Naskah masih kosong (langkah 2).');
    if (!confirmReplaceScenes()) return;
    await scenesFromScriptNow(btn);
  }).finally(() => setProgress('#sceneProgress', null));
});

async function scenesFromScriptNow(btn) {
  if (!S.script.trim()) throw new Error('Naskah masih kosong (langkah 2).');
  if (audioRaw && !audioTrim) doTrim();
  const a = currentAudio();
  const total = a ? audioLib.duration(a) : (S.script.split(/\s+/).length / (WPM[S.lang] || 135)) * 60;
  if (!a) toast('Belum ada audio — durasi scene diperkirakan dari panjang naskah.');
  S.scenes = scenesFromScript(S.script, total, S.sceneSec, audioPauses());
  S.syncV = SYNC_V;
  renderScenes();
  await buildPrompts(btn);
}

$('#transcribeBtn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  busy(btn, '⏳ Mentranskrip audio…', async () => {
    if (!audioRaw) throw new Error('Upload audio dulu (langkah 2).');
    if (!confirmReplaceScenes()) return;
    await scenesFromTranscriptNow(btn);
  }).finally(() => setProgress('#sceneProgress', null));
});

async function scenesFromTranscriptNow(btn) {
  if (!audioRaw) throw new Error('Upload audio dulu (langkah 2).');
  if (!audioTrim) doTrim();
  const a = currentAudio();
  const segs = await llm.transcribe(settings, { chunks: await audioLib.wavChunksForTranscription(a), lang: S.lang });
  if (!segs.length) throw new Error('Transkrip kosong.');
  S.scenes = scenesFromTranscript(segs, audioLib.duration(a), S.sceneSec, audioPauses());
  S.syncV = SYNC_V;
  renderScenes();
  await buildPrompts(btn);
}

// ---------------------------------------------------------------- step 4: gambar via Flow

// URL Flow berubah-ubah (flow.google.com, labs.google/fx/tools/flow, /fx/id/tools/flow, labs.google/flow…),
// jadi cocokkan longgar: domain Flow/Labs + kata "flow" di host/path.
const isFlowUrl = (u = '') => /^https:\/\/([a-z0-9-]+\.)*(labs\.google|flow\.google|flow\.google\.com)(:\d+)?(\/|$)/i.test(u) && /flow/i.test(u);

async function findFlowTab() {
  const tabs = (await chrome.tabs.query({})).filter((t) => isFlowUrl(t.url || t.pendingUrl));
  // utamakan tab project (punya kotak prompt) → tab aktif → yang terakhir dipakai
  return tabs.find((t) => /\/project\//.test(t.url || '')) || tabs.find((t) => t.active)
    || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

async function connectFlow() {
  const tab = await findFlowTab();
  if (!tab) {
    const [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const where = act?.url ? ` (tab aktif: ${act.url.replace(/^https?:\/\//, '').slice(0, 60)})` : '';
    return { ok: false, reason: `Tab Flow belum dibuka${where}` };
  }
  const ping = () => chrome.tabs.sendMessage(tab.id, { type: 'TUYUL_PING' });
  let r = await ping().catch(() => null);
  if (!r) {
    // tab dibuka sebelum extension dipasang → suntik content script manual
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/flow.js'] }).catch(() => {});
    r = await ping().catch(() => null);
  }
  if (!r) return { ok: false, tab, reason: 'Tidak bisa terhubung (muat ulang tab Flow)' };
  if (!r.hasInput) return { ok: false, tab, reason: 'Buka sebuah project di Flow' };
  return { ok: true, tab };
}

async function checkFlow() {
  const pill = $('#flowStatus');
  pill.textContent = 'memeriksa…';
  pill.className = 'pill';
  const c = await connectFlow();
  pill.textContent = c.ok ? 'terhubung ✓' : c.reason;
  pill.className = `pill ${c.ok ? 'ok' : 'err'}`;
  return c;
}

$('#openFlowBtn').addEventListener('click', async () => {
  const tab = await findFlowTab();
  if (tab) chrome.tabs.update(tab.id, { active: true });
  else chrome.tabs.create({ url: FLOW_URL });
});
$('#checkFlowBtn').addEventListener('click', checkFlow);

// status otomatis diperbarui saat tab Flow dibuka/selesai dimuat/dipindah
let flowRecheck;
const recheckFlowSoon = () => {
  if (S.step !== 4 || $('#stopFlowBtn').classList.contains('hidden') === false) return;
  clearTimeout(flowRecheck);
  flowRecheck = setTimeout(checkFlow, 600);
};
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status === 'complete' || info.url) if (isFlowUrl(tab.url)) recheckFlowSoon();
});
chrome.tabs.onActivated.addListener(recheckFlowSoon);
chrome.tabs.onRemoved.addListener(recheckFlowSoon);

async function normalizeImage(src, maxSide = 1920) {
  let blob = src instanceof Blob ? src : null;
  for (const credentials of ['include', 'omit']) { // domain gambar Flow menolak fetch ber-cookie
    if (blob) break;
    try {
      const res = await fetch(src, { credentials });
      if (res.ok) blob = await res.blob();
    } catch {}
  }
  if (!blob) throw new Error('Gambar tidak bisa diunduh.');
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const out = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(out);
  });
}

function thumbClass() {
  return S.ratio === '9:16' ? 'portrait' : S.ratio === '1:1' ? 'square' : '';
}

function thumbEl(s) {
  const status = s.status === 'working' ? '⏳ membuat di Flow…' : s.status === 'error' ? `⚠︎ ${s.error || 'gagal'}` : 'belum ada gambar';
  return h('div', { class: `thumb ${s.status || ''}`, id: `thumb-${s.i}`, title: s.text },
    s.image ? h('img', { src: s.image, alt: `Scene ${s.i}` }) : h('div', { class: 'st' }, status),
    h('span', { class: 'n' }, s.i),
    h('div', { class: 'acts' },
      h('button', { title: 'Buat ulang di Flow', onclick: () => runFlow([s]) }, '↻'),
      h('button', { title: 'Upload gambar sendiri', onclick: () => pickImageFor(s) }, '⬆'),
      s.image && s.alts?.length > 0 && h('button', { title: `Ganti ke gambar lain dari Flow (${s.alts.length + 1} pilihan)`, onclick: () => swapAlt(s) }, `⇄ ${s.alts.length + 1}`),
      s.image && h('button', { title: 'Hapus gambar', onclick: () => { s.image = null; s.alts = []; s.status = 'idle'; updateThumb(s); save(); } }, '✕')));
}

// putar ke gambar alternatif berikutnya (Flow sering membuat 2 gambar per prompt)
function swapAlt(s) {
  s.alts.push(s.image);
  s.image = s.alts.shift();
  updateThumb(s);
  save();
}

function updateThumb(s) {
  const old = document.getElementById(`thumb-${s.i}`);
  if (old) old.replaceWith(thumbEl(s));
  renderFlowInfo();
}

function renderFlowInfo() {
  const n = S.scenes.length, done = S.scenes.filter((s) => s.image).length;
  $('#flowInfo').textContent = n ? `${done} / ${n} gambar siap` : 'Belum ada scene. Buat scene di langkah 3.';
  updateStepper();
}

function renderThumbs() {
  const grid = $('#thumbGrid');
  grid.className = `thumbs ${thumbClass()}`;
  grid.replaceChildren(...S.scenes.map(thumbEl));
  renderFlowInfo();
}

const imgPicker = h('input', { type: 'file', accept: 'image/*', hidden: true });
document.body.append(imgPicker);
function pickImageFor(scene) {
  imgPicker.onchange = async () => {
    const f = imgPicker.files[0];
    imgPicker.value = '';
    if (!f) return;
    scene.image = await normalizeImage(f);
    scene.status = 'done';
    updateThumb(scene);
    save();
  };
  imgPicker.click();
}

{
  const grid = $('#thumbGrid');
  grid.addEventListener('dragover', (e) => { e.preventDefault(); grid.classList.add('over'); });
  grid.addEventListener('dragleave', () => grid.classList.remove('over'));
  grid.addEventListener('drop', async (e) => {
    e.preventDefault();
    grid.classList.remove('over');
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const empty = S.scenes.filter((s) => !s.image);
    for (let k = 0; k < files.length && k < empty.length; k++) {
      empty[k].image = await normalizeImage(files[k]);
      empty[k].status = 'done';
      updateThumb(empty[k]);
    }
    save();
    if (files.length) toast(`${Math.min(files.length, empty.length)} gambar dimasukkan ✓`, 'ok');
  });
}

// Atur Flow sebelum mulai: mode langsung (bukan Agen), Gambar, rasio proyek, 1 gambar per prompt.
async function configureFlow(tabId, ratio = S.ratio) {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'TUYUL_FLOW_CONFIGURE', ratio, count: 1 }).catch(() => null);
  if (r?.ok && r.changed?.length) toast(`Flow diatur otomatis: ${r.changed.join(', ')}`, 'ok');
  else if (r && !r.ok) toast(r.error, 'err');
  return r;
}

async function runFlow(targets, onProgress = () => {}) {
  if (!targets.length) return toast('Semua scene sudah punya gambar.', 'ok');
  if (targets.some((s) => !s.prompt)) return toast('Ada scene tanpa prompt. Buat scene dulu di langkah 3.', 'err');
  const c = await checkFlow();
  if (!c.ok) return toast(`Flow: ${c.reason}`, 'err');

  flowStop = false;
  await configureFlow(c.tab.id);
  $('#sendAllBtn').disabled = true;
  $('#stopFlowBtn').classList.remove('hidden');
  let ok = 0, fail = 0;
  try {
    for (let k = 0; k < targets.length && !flowStop; k++) {
      const s = targets[k];
      s.status = 'working';
      s.error = '';
      updateThumb(s);
      document.getElementById(`thumb-${s.i}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setProgress('#flowProgress', k / targets.length);
      onProgress(`scene ${s.i} (${k + 1}/${targets.length})`);

      let res = null;
      for (let attempt = 0; attempt < 2 && !flowStop; attempt++) {
        res = await chrome.tabs.sendMessage(c.tab.id, {
          type: 'TUYUL_FLOW_GENERATE', prompt: s.prompt, label: `Scene ${s.i}/${S.scenes.length}`, count: 1,
        }).catch((e) => ({ ok: false, error: errMsg(e) }));
        if (res?.ok) break;
        if (/tidak ditemukan|Receiving end/i.test(res?.error || '')) break; // bukan masalah sementara
      }

      if (res?.ok) {
        try {
          const outs = res.images?.length ? res.images : [res];
          const imgs = [];
          for (const o of outs) {
            try { imgs.push(await normalizeImage(o.image || o.url)); } catch {}
          }
          if (!imgs.length) throw new Error('kosong');
          [s.image, ...s.alts] = imgs; // output lain dari Flow disimpan sebagai pilihan (⇄)
          s.status = 'done';
          ok++;
        } catch (e) {
          s.status = 'error';
          s.error = 'gagal ambil gambar';
          fail++;
        }
      } else {
        s.status = 'error';
        s.error = res?.error || 'gagal';
        fail++;
        if (/tidak ditemukan|Receiving end/i.test(s.error)) { flowStop = true; toast(s.error, 'err'); }
      }
      updateThumb(s);
      save();
    }
  } finally {
    setProgress('#flowProgress', null);
    $('#sendAllBtn').disabled = false;
    $('#stopFlowBtn').classList.add('hidden');
    chrome.tabs.sendMessage(c.tab.id, { type: 'TUYUL_STATUS', text: flowStop ? 'dihentikan' : `selesai — ${ok} gambar` }).catch(() => {});
  }
  toast(`Flow selesai: ${ok} berhasil${fail ? `, ${fail} gagal (klik ↻ untuk ulang)` : ''}`, fail ? 'err' : 'ok');
  return { ok, fail, stopped: flowStop };
}

$('#sendAllBtn').addEventListener('click', () => {
  const only = $('#onlyMissing').checked;
  runFlow(S.scenes.filter((s) => !only || !s.image));
});
$('#stopFlowBtn').addEventListener('click', () => {
  flowStop = true;
  toast('Berhenti setelah scene yang sedang diproses selesai.');
});

// ---------------------------------------------------------------- step 5: render

function renderSummary() {
  const { w, h: hh } = outputSize(S.ratio, S.res);
  const a = currentAudio();
  const dur = a ? audioLib.duration(a) : S.scenes.at(-1)?.end || 0;
  const imgs = S.scenes.filter((s) => s.image).length;
  $('#renderSummary').replaceChildren(
    h('div', {}, '🎞️ ', h('b', {}, `${w}×${hh}`), ` · ${S.fps} fps · durasi `, h('b', {}, fmtTime(dur))),
    h('div', {}, '🖼️ ', h('b', {}, `${imgs}/${S.scenes.length}`), ' gambar scene', imgs < S.scenes.length ? ' (scene kosong memakai gambar terdekat)' : ''),
    h('div', {}, '🔊 ', a ? h('b', {}, audioTrim ? 'Voiceover (jeda sudah dipotong)' : 'Voiceover') : 'Tanpa audio'),
  );
}

$('#resyncBtn').addEventListener('click', () => { resyncScenes(); renderSummary(); });
$('#resyncBtn3').addEventListener('click', () => resyncScenes());

$('#subtitles').addEventListener('change', (e) => { S.subtitles = e.target.checked; save(); });

function safeName(s) {
  return (s || 'video').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
}

$('#renderBtn').addEventListener('click', async () => {
  if (!S.scenes.some((s) => s.image)) return toast('Belum ada gambar scene (langkah 4).', 'err');
  const name = `${safeName(S.title || S.rawTitle)}.mp4`;

  // Pilih lokasi simpan dulu (harus langsung dari klik pengguna).
  let fileHandle = null;
  if (window.showSaveFilePicker) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: name, startIn: 'downloads',
        types: [{ description: 'Video MP4', accept: { 'video/mp4': ['.mp4'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      fileHandle = null; // tidak didukung di konteks ini → unduh biasa
    }
  }

  try {
    const out = await renderVideo(fileHandle);
    let url;
    if (out.blob) {
      url = URL.createObjectURL(out.blob);
      h('a', { href: url, download: name }).click();
    } else {
      url = URL.createObjectURL(await fileHandle.getFile());
    }
    const v = $('#resultVideo');
    v.src = url;
    v.classList.remove('hidden');
    $('#renderInfo').textContent = `✅ Video jadi dalam ${out.elapsed.toFixed(0)} detik (${fmtTime(out.duration)}, ${out.width}×${out.height}${out.encoder === 'software' ? ', encoder software' : ''}) — tersimpan sebagai "${fileHandle?.name || name}".`;
    toast('Render selesai ✓', 'ok');
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || errMsg(e), 'err');
  }
});

// Kotak error render yang jelas: apa masalahnya, apa yang bisa dilakukan, dan detail teknis.
function showRenderError(e) {
  const info = $('#renderInfo');
  if (e.name === 'AbortError') { info.textContent = 'Render dibatalkan.'; return; }
  const detail = [e.detail, e.name !== 'RenderError' ? `${e.name}: ${e.message}` : ''].filter(Boolean).join(' · ');
  const known = e.name === 'RenderError';
  info.replaceChildren(h('div', { class: 'errbox' },
    h('b', {}, `❌ Render gagal: ${known ? e.message : 'terjadi kesalahan yang tidak terduga.'}`),
    h('div', {}, e.hint || (known ? '' : 'Coba muat ulang panel Klipin lalu render lagi. Kalau tetap gagal, kirim detail di bawah ini ke pembuat Klipin.')),
    detail && h('details', {}, h('summary', {}, 'Detail teknis'),
      h('code', {}, `${detail} · Chrome ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '?'} · ${navigator.platform}`),
      h('button', { class: 'btn', onclick: (ev) => { navigator.clipboard.writeText(ev.target.previousSibling.textContent); toast('Detail disalin', 'ok'); } }, 'Salin'))));
}

// Render MP4 (dipakai tombol & AI agent). Tanpa fileHandle → hasilnya blob di memori.
async function renderVideo(fileHandle = null, onProgress = () => {}) {
  if (!S.scenes.some((s) => s.image)) throw new Error('Belum ada gambar scene (langkah 4).');
  const btn = $('#renderBtn');
  btn.disabled = true;
  $('#cancelRenderBtn').classList.remove('hidden');
  $('#resultVideo').classList.add('hidden');
  renderAbort = new AbortController();
  try {
    return await renderMp4({
      scenes: S.scenes, audio: currentAudio(), pauses: audioPauses(), ratio: S.ratio, res: S.res, fps: S.fps, subtitles: S.subtitles,
      fileHandle, signal: renderAbort.signal,
      onProgress: ({ phase, pct, elapsed }) => {
        setProgress('#renderProgress', pct);
        const txt = phase === 'Render' ? `Render ${Math.round(pct * 100)}%${elapsed ? ` · ${elapsed.toFixed(0)} detik` : ''}` : phase;
        $('#renderInfo').textContent = txt;
        onProgress(txt);
      },
    });
  } catch (e) {
    console.error('[Klipin] render', e);
    showRenderError(e);
    throw e;
  } finally {
    setProgress('#renderProgress', null);
    btn.disabled = false;
    $('#cancelRenderBtn').classList.add('hidden');
  }
}
$('#cancelRenderBtn').addEventListener('click', () => renderAbort?.abort());

// ---------------------------------------------------------------- step 6: paket YouTube
// S.yt = { titles, title, desc, tags, thumbTexts, thumbPrompt, bgs: [dataURL], thumb: { text, pos, color, bg } }
// thumb.bg: 'g<n>' = latar buatan Flow/upload (S.yt.bgs[n]), 's<i>' = gambar scene nomor i.

const THUMB_W = 1280, THUMB_H = 720;
const THUMB_COLORS = { yellow: '#ffd400', white: '#ffffff', red: '#ff2d2d' };

function ensureYt() {
  S.yt ||= { titles: [], title: '', desc: '', tags: '', thumbTexts: [], thumbPrompt: '', bgs: [], thumb: {} };
  S.yt.thumb = { text: '', pos: 'left', color: 'yellow', bg: '', ...S.yt.thumb };
  return S.yt;
}

// Bab YouTube: mulai 0:00, minimal 3 bab, tiap bab ≥ 10 detik.
function chaptersText(chapters) {
  const byI = new Map(S.scenes.map((x) => [x.i, x]));
  const list = [];
  for (const c of [...chapters].sort((a, b) => a.scene - b.scene)) {
    const sc = byI.get(Number(c.scene));
    if (!sc) continue;
    const t = list.length ? Math.floor(sc.start) : 0;
    if (list.length && t - list.at(-1).t < 10) continue;
    list.push({ t, title: String(c.title).trim() });
  }
  return list.length >= 3 ? list.map((c) => `${fmtTime(c.t)} ${c.title}`).join('\n') : '';
}

function fitTags(tags, max = 480) { // batas YouTube 500 karakter total
  const out = [];
  let len = 0;
  for (const t of tags) {
    if (len + t.length + 1 > max) break;
    out.push(t);
    len += t.length + 1;
  }
  return out.join(', ');
}

$('#ytGenBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Menyusun paket YouTube…', async () => {
  await makeYoutubePack();
  toast('Paket YouTube siap ✓', 'ok');
}));

async function makeYoutubePack() {
  if (!S.script.trim() && !S.scenes.length) throw new Error('Naskah masih kosong (langkah 2).');
  const scenes = S.scenes.map((x) => ({ i: x.i, t: fmtTime(x.start), text: x.text }));
  const out = await llm.youtubePack(settings, {
    title: S.title || S.rawTitle, script: S.script || S.scenes.map((x) => x.text).join(' '), scenes, lang: S.lang, ratio: S.ratio,
  });
  const yt = ensureYt();
  const chap = chaptersText(out.chapters);
  yt.titles = out.titles;
  yt.title = out.titles[0] || S.title;
  yt.desc = [
    out.description,
    chap && `${S.lang === 'en' ? '⏱️ Chapters' : '⏱️ Bab'}\n${chap}`,
    out.hashtags.join(' '),
  ].filter(Boolean).join('\n\n');
  yt.tags = fitTags(out.tags);
  yt.thumbTexts = out.thumbTexts;
  yt.thumbPrompt = out.thumbPrompt;
  if (!yt.thumb.text || !yt.thumbTexts.includes(yt.thumb.text)) yt.thumb.text = out.thumbTexts[0] || '';
  renderYt();
  save();
  return yt;
}

function renderYt() {
  const yt = ensureYt();
  $('#ytOut').classList.toggle('hidden', !yt.titles.length && !yt.desc);
  const opt = (t) => h('label', { class: 'opt' },
    h('input', { type: 'radio', name: 'ytTitle', checked: yt.title === t, onchange: () => { yt.title = t; save(); } }),
    h('span', {}, t),
    h('span', { class: `len ${t.length > 100 ? 'over' : ''}` }, t.length));
  $('#ytTitles').replaceChildren(...yt.titles.map(opt));
  $('#ytDesc').value = yt.desc;
  $('#ytTags').value = yt.tags;
  $('#thumbPrompt').value = yt.thumbPrompt;
  $('#thumbText').value = yt.thumb.text;
  renderThumbTexts();
  updateYtMeta();
  renderThumbBgs();
  thumbSegs.forEach((f) => f());
  drawThumb();
}

function renderThumbTexts() {
  const yt = ensureYt();
  $('#ytThumbTexts').replaceChildren(...yt.thumbTexts.map((t) => h('button', {
    class: `chip ${yt.thumb.text === t ? 'active' : ''}`,
    onclick: () => { yt.thumb.text = t; $('#thumbText').value = t; renderThumbTexts(); drawThumb(); save(); },
  }, t)));
}

function updateYtMeta() {
  const yt = ensureYt();
  $('#ytDescMeta').textContent = `${yt.desc.length} / 5000`;
  $('#ytTagsMeta').textContent = `${yt.tags.length} / 500`;
}

$('#ytDesc').addEventListener('input', (e) => { ensureYt().desc = e.target.value; updateYtMeta(); save(); });
$('#ytTags').addEventListener('input', (e) => { ensureYt().tags = e.target.value; updateYtMeta(); save(); });
$('#thumbPrompt').addEventListener('input', (e) => { ensureYt().thumbPrompt = e.target.value; save(); });
$('#thumbText').addEventListener('input', (e) => { ensureYt().thumb.text = e.target.value; renderThumbTexts(); drawThumb(); save(); });
$('#ytCopyTitle').addEventListener('click', () => copy(ensureYt().title, 'Judul'));
$('#ytCopyDesc').addEventListener('click', () => copy(ensureYt().desc, 'Deskripsi'));
$('#ytCopyTags').addEventListener('click', () => copy(ensureYt().tags, 'Tag'));

function thumbBgList() {
  const yt = ensureYt();
  return [
    ...yt.bgs.map((src, n) => ({ key: `g${n}`, src, label: 'latar' })),
    ...S.scenes.filter((x) => x.image).map((x) => ({ key: `s${x.i}`, src: x.image, label: `scene ${x.i}` })),
  ];
}

function currentBg() {
  const list = thumbBgList();
  return list.find((b) => b.key === ensureYt().thumb.bg) || list[0] || null;
}

function renderThumbBgs() {
  const cur = currentBg();
  $('#thumbBgs').replaceChildren(...thumbBgList().map((b) => h('button', {
    class: b.key === cur?.key ? 'active' : '', title: b.label,
    onclick: () => { ensureYt().thumb.bg = b.key; renderThumbBgs(); drawThumb(); save(); },
  }, h('img', { src: b.src, alt: b.label }), h('span', {}, b.label))));
}

const imgCache = new Map();
function loadImg(src) {
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    }));
  }
  return imgCache.get(src);
}

// Bungkus teks jadi ≤3 baris dengan ukuran huruf sebesar mungkin yang muat di kotak.
function layoutThumbText(ctx, text, boxW, boxH) {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  for (let size = 190; size >= 48; size -= 6) {
    ctx.font = `900 ${size}px Impact, "Anton", "Arial Black", "Helvetica Neue", sans-serif`;
    const lines = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width <= boxW || !line) line = next;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    const lh = size * 1.02;
    if (lines.length <= 3 && lines.every((l) => ctx.measureText(l).width <= boxW) && lines.length * lh <= boxH) {
      return { size, lines, lh };
    }
  }
  return { size: 48, lines: [text.toUpperCase()], lh: 50 };
}

let drawSeq = 0;
async function drawThumb(canvas = $('#thumbCanvas')) {
  const onScreen = canvas === $('#thumbCanvas');
  const seq = onScreen ? ++drawSeq : drawSeq;
  const yt = ensureYt();
  const { text, pos, color } = yt.thumb;
  const bg = currentBg();
  const im = bg ? await loadImg(bg.src).catch(() => null) : null;
  if (onScreen && seq !== drawSeq) return; // ada gambar yang lebih baru
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  if (im) { // cover-crop; untuk "kiri", subjek digeser ke kanan agar teks tidak menutupinya
    const k = Math.max(W / im.width, H / im.height);
    const dw = im.width * k, dh = im.height * k;
    const fx = pos === 'left' ? 0.65 : pos === 'right' ? 0.35 : 0.5;
    ctx.drawImage(im, (W - dw) * fx, (H - dh) * 0.4, dw, dh);
  }
  if (!text.trim()) return;

  // gelapkan sisi teks supaya terbaca
  const g = pos === 'bottom' ? ctx.createLinearGradient(0, H, 0, H * 0.35)
    : pos === 'left' ? ctx.createLinearGradient(0, 0, W * 0.7, 0) : ctx.createLinearGradient(W, 0, W * 0.3, 0);
  g.addColorStop(0, 'rgba(0,0,0,.78)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const pad = 56;
  const boxW = pos === 'bottom' ? W - pad * 2 : W * 0.56;
  const boxH = pos === 'bottom' ? H * 0.45 : H - pad * 2;
  const { size, lines, lh } = layoutThumbText(ctx, text, boxW, boxH);
  const blockH = lines.length * lh;
  const y0 = pos === 'bottom' ? H - pad - blockH : (H - blockH) / 2;
  ctx.textBaseline = 'top';
  ctx.textAlign = pos === 'right' ? 'right' : pos === 'bottom' ? 'center' : 'left';
  const x = pos === 'right' ? W - pad : pos === 'bottom' ? W / 2 : pad;
  ctx.lineJoin = 'round';
  lines.forEach((l, k) => {
    const y = y0 + k * lh;
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 6;
    ctx.lineWidth = Math.max(8, size * 0.12);
    ctx.strokeStyle = '#000';
    ctx.strokeText(l, x, y);
    ctx.shadowColor = 'transparent';
    // baris pertama berwarna aksen, sisanya putih (kecuali aksen = putih)
    ctx.fillStyle = k === 0 || color === 'white' ? THUMB_COLORS[color] : '#ffffff';
    ctx.fillText(l, x, y);
  });
}

async function addThumbBg(src) {
  const yt = ensureYt();
  yt.bgs.unshift(await normalizeImage(src, 1600));
  yt.bgs = yt.bgs.slice(0, 6);
  yt.thumb.bg = 'g0';
  renderThumbBgs();
  drawThumb();
  save();
}

$('#thumbUploadBtn').addEventListener('click', () => {
  imgPicker.onchange = async () => {
    const f = imgPicker.files[0];
    imgPicker.value = '';
    if (f) await addThumbBg(f);
  };
  imgPicker.click();
});

$('#thumbFlowBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Membuat latar di Flow…', async () => {
  const n = await thumbBgFromFlow();
  toast(`${n} latar thumbnail dari Flow ✓`, 'ok');
}));

async function thumbBgFromFlow() {
  const prompt = ensureYt().thumbPrompt.trim();
  if (!prompt) throw new Error('Prompt latar thumbnail masih kosong — klik "Buat Judul, Deskripsi & Thumbnail" dulu.');
  const c = await checkFlow();
  if (!c.ok) throw new Error(`Flow: ${c.reason}`);
  await configureFlow(c.tab.id, '16:9');
  const res = await chrome.tabs.sendMessage(c.tab.id, { type: 'TUYUL_FLOW_GENERATE', prompt, label: 'Thumbnail', count: 1 })
    .finally(() => S.ratio !== '16:9' && configureFlow(c.tab.id)); // kembalikan rasio proyek
  if (!res?.ok) throw new Error(res?.error || 'Flow gagal membuat gambar.');
  const outs = res.images?.length ? res.images : [res];
  for (const o of outs.reverse()) await addThumbBg(o.image || o.url).catch(() => {});
  return outs.length;
}

async function thumbBlob() {
  const c = new OffscreenCanvas(THUMB_W, THUMB_H);
  await drawThumb(c);
  let blob;
  for (const q of [0.92, 0.85, 0.75, 0.65]) { // YouTube: maks 2 MB
    blob = await c.convertToBlob({ type: 'image/jpeg', quality: q });
    if (blob.size < 2e6) break;
  }
  return blob;
}

$('#thumbDlBtn').addEventListener('click', async () => {
  const blob = await thumbBlob();
  const url = URL.createObjectURL(blob);
  h('a', { href: url, download: `${safeName(ensureYt().title || S.title)} - thumbnail.jpg` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Thumbnail diunduh ✓', 'ok');
});

let thumbSegs = [];

// ---------------------------------------------------------------- settings

function updateStatusLine() {
  const ready = llm.providers(settings).filter((p) => p.ready);
  $('#statusLine').textContent = ready.length
    ? `AI: ${ready.map((p) => p.name).join(' + ')}${settings.fallback && ready.length > 1 ? ' · cadangan aktif' : ''}`
    : '⚠︎ Isi API key di ⚙︎ Pengaturan';
}

function applySettings(next) {
  settings = next;
  elevenCache = null;
  updateStatusLine();
  renderTtsEngines(true);
}

const settingsUI = mountSettings($('#settingsRoot'), {
  onSaved: (next) => { applySettings(next); $('#settingsDlg').close(); },
  onCancel: () => $('#settingsDlg').close(),
});

function openSettings() {
  settingsUI.load(settings);
  $('#settingsDlg').showModal();
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#openOptionsLink').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

// Perubahan dari halaman Options langsung terpakai di side panel.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) llm.loadSettings().then(applySettings);
});

$('#newProjectBtn').addEventListener('click', async () => {
  if (!confirm('Mulai proyek baru? Judul, naskah, audio, scene & gambar saat ini akan dihapus.')) return;
  await resetProject();
});

async function resetProject() {
  const keep = {
    lang: S.lang, visualStyle: S.visualStyle, ratio: S.ratio, ttsEngine: S.ttsEngine, ttsVoices: S.ttsVoices,
    res: S.res, fps: S.fps, subtitles: S.subtitles,
  };
  S = { ...structuredClone(DEFAULT_STATE), ...keep };
  audioRaw = audioTrim = null;
  await Promise.all([kvSet('state', S), kvDel('audioRaw'), kvDel('audioTrim')]);
  initUI();
  go(1);
}

// ---------------------------------------------------------------- AI agent (MCP)
// Tool yang dipanggil Klipin MCP server (mcp/server.mjs). Memakai fungsi yang sama dengan tombol UI,
// tanpa dialog konfirmasi; layar ikut pindah ke langkah yang sedang dikerjakan.

const pickId = (list, id, what) => {
  if (id == null || id === '') return null;
  const hit = list.find((x) => String(x.id) === String(id));
  if (!hit) throw new Error(`${what} "${id}" tidak dikenal. Pilihan: ${list.map((x) => x.id).join(', ')}`);
  return hit.id;
};
const progressBtn = (progress) => ({ set textContent(v) { progress(v); } }); // buildPrompts menulis status ke "tombol"

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: `Klipin/${filename}`, conflictAction: 'uniquify', saveAs: false });
    for (let i = 0; i < 600; i++) { // tunggu sampai file selesai ditulis (maks ±5 menit)
      const [d] = await chrome.downloads.search({ id });
      if (d?.state === 'complete') return d.filename;
      if (d?.state === 'interrupted') throw new Error(`Gagal menyimpan file (${d.error})`);
      await new Promise((r) => setTimeout(r, 500));
    }
    return `Downloads/Klipin/${filename}`;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function statusText() {
  const a = currentAudio();
  const imgs = S.scenes.filter((x) => x.image).length;
  const ready = llm.providers(settings).filter((p) => p.ready).map((p) => p.name);
  const tts = llm.ttsEngines(settings).filter((e) => e.ready).map((e) => e.id);
  const words = S.script.trim() ? S.script.trim().split(/\s+/).length : 0;
  return [
    `Judul: ${S.title || '—'}${S.rawTitle && S.rawTitle !== S.title ? ` (ide: ${S.rawTitle})` : ''}`,
    `Bahasa: ${S.lang} · format: ${S.format} · gaya narasi: ${S.narrStyle} · durasi target: ${S.minutes} menit`,
    `Naskah: ${words ? `${words} kata` : 'belum ada'}`,
    `Audio: ${a ? `${fmtTime(audioLib.duration(a))}${audioTrim ? ' (jeda sudah dipotong)' : ''}` : 'belum ada'}`,
    `Gaya visual: ${S.visualStyle} · rasio ${S.ratio} · ±${S.sceneSec} detik/scene`,
    `Scene: ${S.scenes.length} · prompt ${S.scenes.filter((x) => x.prompt).length} · gambar ${imgs}/${S.scenes.length}`,
    `Paket YouTube: ${S.yt?.desc ? 'sudah' : 'belum'}`,
    `AI siap: ${ready.join(', ') || 'BELUM ADA — pengguna perlu mengisi API key di ⚙︎ Klipin'} · TTS API: ${tts.join(', ') || 'tidak ada'}`,
  ].join('\n');
}

const agentTools = {
  async status() {
    const flow = await connectFlow();
    return { text: `${statusText()}\nGoogle Flow: ${flow.ok ? 'terhubung' : flow.reason}` };
  },

  async options() {
    const ttsLines = llm.ttsEngines(settings).map((e) => `${e.id}${e.ready ? '' : ' (belum dikonfigurasi)'}`);
    return {
      text: [
        `format: ${FORMATS.map((f) => `${f.id} (${f.label})`).join(', ')}`,
        `narration_style: ${NARRATION_STYLES.map((n) => `${n.id} (${n.label})`).join(', ')}`,
        `visual_style: ${VISUAL_STYLES.map((v) => `${v.id} (${v.label})`).join(', ')}`,
        `ratio: ${RATIOS.map((r) => r.id).join(', ')}`,
        `minutes: ${DURATIONS.join(', ')}`,
        `TTS engine: ${ttsLines.join(', ')}`,
        `Suara Gemini: ${VOICES.map((v) => `${v.name} (${v.gender === 'L' ? 'pria' : 'wanita'}, ${v.desc})`).join('; ')}`,
        `Suara OpenAI: ${llm.OPENAI_VOICES.map((v) => v.id).join(', ')}`,
      ].join('\n'),
    };
  },

  async new_project({ idea, lang }) {
    await resetProject();
    if (lang) S.lang = lang === 'en' ? 'en' : 'id';
    if (idea) S.rawTitle = S.title = String(idea).trim();
    initUI();
    go(1);
    return { text: `Proyek baru dibuat.${idea ? ` Ide: ${idea}` : ''}` };
  },

  async titles({ idea, lang }) {
    go(1);
    if (lang) S.lang = lang === 'en' ? 'en' : 'id';
    if (idea) S.rawTitle = String(idea).trim();
    const raw = S.rawTitle.trim() || S.title;
    if (!raw) throw new Error('Beri `idea` (ide/judul mentah).');
    S.titleOptions = await llm.expandTitle(settings, raw, S.lang);
    S.title = S.titleOptions[0] || raw;
    $('#rawTitle').value = S.rawTitle;
    renderTitleOptions();
    save();
    return { text: `Pilihan judul (yang pertama dipilih):\n${S.titleOptions.map((t, k) => `${k + 1}. ${t}`).join('\n')}` };
  },

  async set_title({ title }) {
    S.title = String(title || '').trim();
    if (!S.title) throw new Error('Judul kosong.');
    if (!S.rawTitle) S.rawTitle = S.title;
    renderTitleOptions();
    save();
    return { text: `Judul: ${S.title}` };
  },

  async write_script({ format, narration_style, minutes, lang, script }, progress) {
    go(2);
    S.format = pickId(FORMATS, format, 'format') || S.format;
    const ns = pickId(NARRATION_STYLES, narration_style, 'narration_style');
    if (ns && ns !== S.narrStyle) { S.narrStyle = ns; S.styleInstrEdited = false; }
    if (minutes) S.minutes = Number(minutes);
    if (lang) S.lang = lang === 'en' ? 'en' : 'id';
    if (script) {
      S.script = String(script).trim();
    } else {
      const title = S.title || S.rawTitle;
      if (!title) throw new Error('Judul masih kosong — panggil klipin_titles atau klipin_set_title dulu.');
      progress('menulis naskah…');
      S.script = await llm.writeScript(settings, {
        title, format: fmtStyle(), style: narrStyle(), minutes: S.minutes, lang: S.lang, wpm: WPM[S.lang] || 135,
      });
    }
    initUI();
    save();
    const words = S.script.split(/\s+/).length;
    return { text: `Naskah (${words} kata, ±${(words / (WPM[S.lang] || 135)).toFixed(1)} menit):\n\n${S.script}\n\nStyle instruction suara: ${S.styleInstr}` };
  },

  async voice({ engine, voice }, progress) {
    go(2);
    if (!S.script.trim()) throw new Error('Naskah masih kosong — panggil klipin_write_script dulu.');
    if (engine) S.ttsEngine = pickId(llm.ttsEngines(settings), engine, 'engine');
    const eng = ttsEngine();
    if (!eng.ready) throw new Error(`${eng.name} belum dikonfigurasi (API key di ⚙︎ Klipin). Alternatif gratis: buat suara di Google AI Studio (${AI_STUDIO_TTS_URL}) lalu klipin_load_audio.`);
    if (voice) S.ttsVoices[eng.kind] = String(voice);
    renderTtsEngines();
    const out = await llm.synthesize(settings, {
      engine: eng.id, text: S.script, styleInstruction: S.styleInstr, voice: S.ttsVoices[eng.kind],
      onProgress: (i, n) => { setProgress('#ttsProgress', i / n); progress(`suara bagian ${i}/${n}`); },
    }).finally(() => setProgress('#ttsProgress', null));
    await setAudio(out);
    save();
    return { text: `Suara selesai (${eng.name}, ${S.ttsVoices[eng.kind]}): ${fmtTime(audioLib.duration(out))}.` };
  },

  async load_audio({ name, base64 }) {
    go(2);
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const a = await audioLib.decodeFile(new File([bytes], name || 'audio'));
    await setAudio(a);
    save();
    return { text: `Audio "${name}" dimuat: ${fmtTime(audioLib.duration(a))}.` };
  },

  async scenes({ visual_style, ratio, scene_seconds, source }, progress) {
    go(3);
    S.visualStyle = pickId(VISUAL_STYLES, visual_style, 'visual_style') || S.visualStyle;
    if (ratio) S.ratio = pickId(RATIOS, ratio, 'ratio');
    if (scene_seconds) S.sceneSec = Math.max(3, Math.min(20, Number(scene_seconds)));
    initUI();
    if (source === 'transcript') await scenesFromTranscriptNow(progressBtn(progress));
    else await scenesFromScriptNow(progressBtn(progress));
    setProgress('#sceneProgress', null);
    const list = S.scenes.map((x) => `${x.i}. [${fmtTime(x.start)}–${fmtTime(x.end)}] ${x.text.slice(0, 90)}${x.text.length > 90 ? '…' : ''}\n   prompt: ${x.prompt}`);
    return { text: `${S.scenes.length} scene (gaya ${S.visualStyle}, rasio ${S.ratio}):\n${list.join('\n')}` };
  },

  async edit_scene({ scene, prompt }) {
    const sc = S.scenes.find((x) => x.i === Number(scene));
    if (!sc) throw new Error(`Scene ${scene} tidak ada (1–${S.scenes.length}).`);
    sc.prompt = String(prompt).trim();
    renderScenes();
    save();
    return { text: `Prompt scene ${sc.i} diganti. Panggil klipin_images dengan scenes: [${sc.i}] untuk membuat ulang gambarnya.` };
  },

  async images({ scenes, only_missing }, progress) {
    go(4);
    const nums = Array.isArray(scenes) && scenes.length ? new Set(scenes.map(Number)) : null;
    const targets = S.scenes.filter((x) => (nums ? nums.has(x.i) : only_missing === false || !x.image));
    if (!S.scenes.length) throw new Error('Belum ada scene — panggil klipin_scenes dulu.');
    if (!targets.length) return { text: 'Semua scene sudah punya gambar.' };
    const c = await checkFlow();
    if (!c.ok) throw new Error(`Google Flow: ${c.reason}. Minta pengguna membuka ${FLOW_URL}, masuk/buat sebuah project, lalu ulangi.`);
    const r = await runFlow(targets, progress);
    const failed = S.scenes.filter((x) => x.status === 'error').map((x) => `${x.i} (${x.error})`);
    return { text: `Gambar: ${r?.ok ?? 0} berhasil, ${r?.fail ?? 0} gagal. Total ${S.scenes.filter((x) => x.image).length}/${S.scenes.length} scene punya gambar.${failed.length ? `\nGagal: ${failed.join(', ')}` : ''}` };
  },

  async render({ resolution, fps, subtitles }, progress) {
    go(5);
    if (resolution) S.res = Number(resolution) === 720 ? 720 : 1080;
    if (fps) S.fps = Number(fps) === 24 ? 24 : 30;
    if (subtitles != null) S.subtitles = !!subtitles;
    initUI();
    renderSummary();
    const out = await renderVideo(null, progress);
    progress('menyimpan file…');
    const file = await downloadBlob(out.blob, `${safeName(S.title || S.rawTitle)}.mp4`);
    const v = $('#resultVideo');
    v.src = URL.createObjectURL(out.blob);
    v.classList.remove('hidden');
    $('#renderInfo').textContent = `✅ Video jadi (${fmtTime(out.duration)}) — ${file}`;
    return { text: `Video selesai dalam ${out.elapsed.toFixed(0)} detik: ${fmtTime(out.duration)}, ${out.width}×${out.height}.\nTersimpan di: ${file}` };
  },

  async youtube(_args, progress) {
    go(6);
    progress('menyusun judul, deskripsi, tag…');
    const yt = await makeYoutubePack();
    return {
      text: `JUDUL (pilih satu):\n${yt.titles.map((t, k) => `${k + 1}. ${t}`).join('\n')}\n\nDESKRIPSI:\n${yt.desc}\n\nTAG:\n${yt.tags}\n\nTEKS THUMBNAIL: ${yt.thumbTexts.join(' | ')}\nPROMPT LATAR THUMBNAIL: ${yt.thumbPrompt}`,
    };
  },

  async thumbnail({ text, background, position, color }, progress) {
    go(6);
    const yt = ensureYt();
    if (text) yt.thumb.text = String(text);
    if (!yt.thumb.text) yt.thumb.text = yt.thumbTexts[0] || (S.title || '').split(/\s+/).slice(0, 4).join(' ');
    if (position) yt.thumb.pos = ['left', 'right', 'bottom'].includes(position) ? position : yt.thumb.pos;
    if (color) yt.thumb.color = THUMB_COLORS[color] ? color : yt.thumb.color;
    const m = /^scene:(\d+)$/.exec(String(background || ''));
    if (m) {
      if (!S.scenes.find((x) => x.i === Number(m[1]) && x.image)) throw new Error(`Scene ${m[1]} belum punya gambar.`);
      yt.thumb.bg = `s${m[1]}`;
    } else if (background === 'flow') {
      if (!yt.thumbPrompt) throw new Error('Belum ada prompt latar — panggil klipin_youtube dulu.');
      progress('membuat latar di Google Flow…');
      await thumbBgFromFlow();
    }
    renderYt();
    const blob = await thumbBlob();
    const file = await downloadBlob(blob, `${safeName(yt.title || S.title)} - thumbnail.jpg`);
    // pratinjau kecil untuk dilihat agent
    const c = new OffscreenCanvas(THUMB_W, THUMB_H);
    await drawThumb(c);
    const small = new OffscreenCanvas(640, 360);
    small.getContext('2d').drawImage(c, 0, 0, 640, 360);
    const prev = await small.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const b64 = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.readAsDataURL(prev);
    });
    save();
    return {
      text: `Thumbnail tersimpan di: ${file}\nTeks: "${yt.thumb.text}" · posisi ${yt.thumb.pos} · warna ${yt.thumb.color} · latar ${currentBg()?.label || 'kosong'}`,
      image: { data: b64, mimeType: 'image/jpeg' },
    };
  },
};

// ---- status koneksi agent di panel
const AGENT_STATES = {
  off: ['Mati', ''],
  offline: ['Menunggu AI agent…', 'Belum ada AI agent yang terhubung. Pasang Klipin MCP di Claude/Cursor (lihat langkah di bawah).'],
  online: ['Terhubung ✓', 'AI agent terhubung. Minta agent-mu, mis. "buatkan video Klipin tentang budidaya lele 3 menit".'],
  standby: ['Dipakai jendela lain', 'AI agent sedang terhubung ke panel Klipin lain (tab/jendela lain).'],
  working: ['Bekerja…', 'AI agent sedang menjalankan Klipin.'],
};
const agentBridge = startAgentBridge(agentTools, (state, info) => {
  const btn = $('#agentBtn');
  btn.dataset.state = state;
  btn.title = `AI agent: ${AGENT_STATES[state][0]}`;
  $('#agentState').textContent = AGENT_STATES[state][0] + (state === 'working' && info ? ` (${info.replace(/^klipin_/, '')})` : '');
  $('#agentState').className = `pill ${state === 'online' || state === 'working' ? 'ok' : ''}`;
  $('#agentHint').textContent = AGENT_STATES[state][1];
});
// dinyalakan di akhir init(), setelah proyek tersimpan selesai dimuat
// ---------------------------------------------------------------- update

async function showUpdate(force = false) {
  const bar = $('#updateBar');
  let u;
  try {
    const self = await chrome.management?.getSelf?.().catch(() => null);
    if (self && self.installType !== 'development') return; // dari Chrome Web Store → update otomatis oleh Chrome
    u = await checkUpdate({ force });
  } catch (e) {
    if (force) toast(`Gagal cek update: ${errMsg(e)}`, 'err');
    return;
  }
  if (!u) { if (force) toast(`Klipin sudah versi terbaru (${chrome.runtime.getManifest().version}) ✓`, 'ok'); return; }
  const { updSkip } = await chrome.storage.local.get('updSkip');
  if (!force && updSkip === u.version) return;
  const steps = h('ol', { class: 'hidden' },
    h('li', {}, 'Buka file ZIP yang baru diunduh (folder Downloads/Klipin), lalu ekstrak.'),
    h('li', {}, 'Salin semua isi folder "klipin" hasil ekstrak ke folder Klipin lama-mu. Pilih "Ganti/Replace" untuk semua file.'),
    h('li', {}, 'Klik "Muat ulang Klipin" di bawah. Kalau Chrome meminta izin baru, klik Izinkan.'));
  bar.replaceChildren(
    h('div', { class: 'row' }, h('b', {}, `🔔 Klipin ${u.version} tersedia`), h('span', {}, `(kamu: ${u.current})`),
      h('button', { class: 'x', title: 'Ingatkan lagi saat ada versi berikutnya', onclick: () => { chrome.storage.local.set({ updSkip: u.version }); bar.classList.add('hidden'); } }, '✕')),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          const id = await downloadUpdate(u);
          steps.classList.remove('hidden');
          toast('ZIP update sedang diunduh ✓', 'ok');
          chrome.downloads.onChanged.addListener(function done(d) {
            if (d.id === id && d.state?.current === 'complete') { chrome.downloads.onChanged.removeListener(done); chrome.downloads.show(id); }
          });
        } catch (e) { toast(`Gagal mengunduh: ${errMsg(e)}`, 'err'); }
      } }, '⬇ Download update'),
      h('button', { class: 'btn', onclick: () => chrome.tabs.create({ url: u.page }) }, 'Apa yang baru?'),
      h('button', { class: 'btn', title: 'Pakai setelah file lama ditimpa', onclick: () => chrome.runtime.reload() }, '↻ Muat ulang Klipin')),
    steps);
  bar.classList.remove('hidden');
}

async function startAgent() {
  const { agentBridge: on = true } = await chrome.storage.local.get('agentBridge');
  $('#agentToggle').checked = on;
  agentBridge.setEnabled(on);
}
$('#agentToggle').addEventListener('change', (e) => {
  chrome.storage.local.set({ agentBridge: e.target.checked });
  agentBridge.setEnabled(e.target.checked);
});
$('#agentBtn').addEventListener('click', () => $('#agentDlg').showModal());
$('#agentCloseBtn').addEventListener('click', () => $('#agentDlg').close());

// ---------------------------------------------------------------- init

let segSyncs = [];
function initUI() {
  $('#rawTitle').value = S.rawTitle;
  renderIdeaCats();
  renderTitleOptions();

  fillSelect($('#format'), FORMATS.map((f) => [f.id, f.label]), S.format);
  fillSelect($('#narrStyle'), NARRATION_STYLES.map((n) => [n.id, n.label]), S.narrStyle);
  fillSelect($('#minutes'), DURATIONS.map((m) => [m, `± ${m} menit`]), S.minutes);
  $('#formatHint').textContent = fmtStyle().hint;
  $('#script').value = S.script;
  updateScriptMeta();
  refreshStyleInstr();
  renderTtsEngines(true);
  showAudio();

  renderVisualStyles();
  $('#sceneSec').value = String(S.sceneSec);
  $('#maxPause').value = String(S.maxPause);
  showTrim();
  $('#subtitles').checked = S.subtitles;
  segSyncs.forEach((f) => f());
}

async function init() {
  settings = await llm.loadSettings();
  const saved = await kvGet('state').catch(() => null);
  if (saved) {
    S = { ...structuredClone(DEFAULT_STATE), ...saved };
    S.ttsVoices = { ...DEFAULT_STATE.ttsVoices, ...saved.ttsVoices };
    if (saved.voice && !saved.ttsVoices) S.ttsVoices.gemini = saved.voice; // proyek versi lama
  }
  llm.setNotifier((msg) => toast(msg));
  audioRaw = (await kvGet('audioRaw').catch(() => null)) || null;
  audioTrim = (await kvGet('audioTrim').catch(() => null)) || null;
  S.scenes.forEach((s) => { if (s.status === 'working') s.status = 'idle'; });

  segSyncs = [
    setupSeg($('#langSeg'), () => S.lang, (v) => { S.lang = v; refreshStyleInstr(); updateScriptMeta(); }),
    setupSeg($('#resSeg'), () => S.res, (v) => { S.res = Number(v); renderSummary(); }),
    setupSeg($('#fpsSeg'), () => S.fps, (v) => { S.fps = Number(v); renderSummary(); }),
  ];
  $('#ratioSeg').replaceChildren(...RATIOS.map((r) => h('button', { 'data-v': r.id }, r.id)));
  segSyncs.push(setupSeg($('#ratioSeg'), () => S.ratio, (v) => { S.ratio = v; }));
  thumbSegs = [
    setupSeg($('#thumbPosSeg'), () => ensureYt().thumb.pos, (v) => { ensureYt().thumb.pos = v; drawThumb(); }),
    setupSeg($('#thumbColorSeg'), () => ensureYt().thumb.color, (v) => { ensureYt().thumb.color = v; drawThumb(); }),
  ];

  $$('#stepper button').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.step))));
  $$('[data-next]').forEach((b) => b.addEventListener('click', () => go(S.step + 1)));
  $$('[data-prev]').forEach((b) => b.addEventListener('click', () => go(S.step - 1)));

  initUI();
  updateStatusLine();
  go(S.step || 1);
  // proyek lama: waktu scene dibuat dengan cara lama (tidak sinkron) → selaraskan sekali
  if (S.scenes.length && (audioTrim || audioRaw) && S.syncV !== SYNC_V) {
    resyncScenes(true);
    setTimeout(() => toast('Waktu scene disinkronkan ulang dengan audio (versi baru).', 'ok'), 800);
  }
  if (!llm.providers(settings).some((p) => p.ready)) openSettings();
  startAgent();
  $('#verBtn').textContent = `v${chrome.runtime.getManifest().version}`;
  $('#verBtn').addEventListener('click', () => showUpdate(true));
  showUpdate();
}

init();
