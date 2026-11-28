import {
  IDEA_BANK, FORMATS, NARRATION_STYLES, DURATIONS, WPM, RATIOS, VIDEO_PRESETS, VOICES,
  AI_STUDIO_TTS_URL, FLOW_URL, THUMB_TYPES, VISUAL_STYLE_CATS, STYLE_PREVIEW_SUBJECT,
} from './data.js';
import * as llm from './llm.js';
import * as audioLib from './audio.js';
import { scenesFromScript, scenesFromTranscript, retimeScenes, subtitleCues, fmtTime } from './scenes.js';
import { renderMp4, outputSize, drawFrame, DEFAULT_TAIL_SEC } from './render.js';
import { kvGet, kvSet, kvDel, mediaGet, mediaSet, mediaClearProject, saveStateClean, loadStateHydrated } from './store.js';
import { h, toast, errMsg, fillSelect } from './dom.js';
import { checkUpdate, downloadUpdate } from './update.js';
import { mountSettings } from './settings-ui.js';
import { startAgentBridge, AGENT_URL } from './agent.js';
import { connectFlow, ensureFlowProject, normalizeImage, cropToJpeg, runFlowBatch, generateConceptImages, generateThumbBgInFlow, isFlowUrl } from './flow-client.js';
import { synthesizeViaAiStudio } from './aistudio-client.js';
import { THUMB_COLORS, thumbSize, thumbType, layoutPos, thumbBgList, currentBg, drawThumb, thumbBlob, clearImgCache } from './thumbnail.js';
import { runFullPipeline, applyPresetToState, safeName, buildMetadataText, buildMetadataJson, loadQueue, saveQueue, runQueue } from './pipeline.js';
import { createAgentTools } from './agent-tools.js';

// ---------------------------------------------------------------- state

const DEFAULT_STATE = {
  step: 1,
  preset: 'shorts',
  rawTitle: '',
  titleOptions: [],
  title: '',
  format: 'misteri',
  narrStyle: 'dokumenter',
  minutes: 1,
  loop: false,
  lang: 'id',
  script: '',
  styleInstr: '',
  styleInstrEdited: false,
  ttsEngine: 'aistudio',
  ttsVoices: { gemini: 'Charon', openai: 'onyx', eleven: '' },
  visualStyle: 'stickman',
  creativeEdited: false,
  creativeReason: '',
  ratio: '9:16',
  sceneSec: 4,
  maxPause: 0.35,
  scenes: [],
  res: 1080,
  fps: 30,
  subtitles: true,
  hook: { on: true, text: '', auto: '' },
  callouts: { on: true, list: [], auto: '' },
  yt: null,
};

let S = structuredClone(DEFAULT_STATE);
let settings = { ...llm.DEFAULT_SETTINGS };
let audioRaw = null;
let audioTrim = null;
let flowStop = false;
let renderAbort = null;
let autoAbort = null;
let queueAbort = null;
let resultVideoUrl = '';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveStateClean(S).catch((e) => console.warn('save', e)), 400);
  updateStepper();
}

async function busy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.warn(e);
      toast(errMsg(e), 'err');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

function setProgress(id, pct) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('hidden', pct == null);
  if (pct != null) el.firstElementChild.style.width = `${Math.round(pct * 100)}%`;
}

const currentAudio = () => audioTrim || audioRaw;
const SYNC_V = 3;

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
const visualStyle = () => { const all = llm.visualStyles(settings); return all.find((v) => v.id === S.visualStyle) || all[0]; };
const getFlowParallel = () => Math.min(5, Math.max(1, Number($('#flowPar').value) || 1));

// ---------------------------------------------------------------- navigation

function updateStepper() {
  const done = {
    1: !!(S.title || S.rawTitle),
    2: !!S.script && !!audioRaw,
    3: S.scenes.length > 0 && S.scenes.every((s) => s.prompt && s.image),
    4: !!S.lastVideo,
    5: !!S.yt?.desc,
  };
  $$('#stepper button').forEach((b) => {
    const n = Number(b.dataset.step);
    b.classList.toggle('active', n === S.step);
    b.classList.toggle('done', !!done[n] && n !== S.step);
  });
}

async function go(step) {
  const target = Math.max(1, Math.min(5, Number(step) || 1));
  if (target === 2 && !S.title) {
    S.title = S.rawTitle.trim();
    if (!S.title) return toast('Tulis atau pilih topik/judul dulu.', 'err');
  }
  if (target === 3 && audioRaw && !audioTrim) doTrim({ quiet: true, normalize: true });
  S.step = target;
  $$('.step').forEach((s) => s.classList.toggle('active', Number(s.dataset.step) === target));
  renderStep(target);
  window.scrollTo({ top: 0 });
  save();
}

function renderStep(step) {
  if (step === 1) renderPresets();
  if (step === 2) {
    $('#pickedTitle').textContent = S.title || S.rawTitle || '—';
    refreshStyleInstr();
  }
  if (step === 3) { renderStoryboard(); checkFlow(); }
  if (step === 4) { renderSummary(); initPreviewSlider(); }
  if (step === 5) renderYt();
}

// ---------------------------------------------------------------- step 1: brief & preset

function renderPresets() {
  $('#presetChips').replaceChildren(...VIDEO_PRESETS.map((p) =>
    h('button', {
      class: `preset ${S.preset === p.id ? 'active' : ''}`,
      onclick: () => {
        applyPresetToState(S, p.id);
        initUI();
        save();
        toast(`Preset ${p.label} aktif`, 'ok');
      },
    }, h('b', {}, p.label), h('small', {}, p.desc))));
}

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
        toast('Topik dipilih. Klik "Buat Otomatis" atau lanjut bertahap.');
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
  if (!S.creativeEdited) S.creativeReason = '';
  renderCreativeReason();
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

let activeStyleCat = 'all';
const customStylePreviews = new Map();
const styleGenStatus = new Map();
let previewedStyle = null;

function stylePreviewSrc(v) {
  return customStylePreviews.get(v.id) || v.preview || '';
}

async function loadStylePreviews() {
  const all = llm.visualStyles(settings);
  await Promise.all(all.map(async (v) => {
    const saved = await mediaGet(`style-preview:${v.id}`).catch(() => null);
    if (typeof saved === 'string' && saved.startsWith('data:image/')) customStylePreviews.set(v.id, saved);
  }));
  renderVisualStyles();
}

function renderCreativeReason() {
  const el = $('#creativeReason');
  if (!el) return;
  el.textContent = S.creativeReason ? `✨ Pilihan AI: ${S.creativeReason}` : '';
  el.classList.toggle('hidden', !S.creativeReason);
}

function openStylePreview(v) {
  previewedStyle = v;
  const src = stylePreviewSrc(v);
  const img = $('#stylePrevImg');
  img.onerror = () => img.classList.add('hidden');
  img.onload = () => img.classList.remove('hidden');
  img.src = src;
  img.classList.toggle('hidden', !src);
  $('#stylePrevTitle').textContent = `${v.emoji} ${v.label}`;
  $('#stylePrevBestFor').textContent = v.bestFor ? `Cocok untuk: ${v.bestFor}` : 'Gaya visual custom';
  $('#stylePrevPrompt').textContent = v.prompt;
  $('#stylePreviewDlg').showModal();
}

async function saveStylePreview(styleObj, rawImgUrl) {
  const { blob, dataUrl } = await cropToJpeg(rawImgUrl, 320, 200, 0.86);
  customStylePreviews.set(styleObj.id, dataUrl);
  await mediaSet(`style-preview:${styleObj.id}`, dataUrl);
  await downloadBlob(blob, `style-previews/${styleObj.id}.jpg`, { conflictAction: 'overwrite' }).catch(() => {});
  return dataUrl;
}

$('#stylePrevCloseBtn').addEventListener('click', () => $('#stylePreviewDlg').close());
$('#stylePrevUseBtn').addEventListener('click', () => {
  if (!previewedStyle) return;
  S.visualStyle = previewedStyle.id;
  S.creativeEdited = true;
  renderVisualStyles();
  save();
  $('#stylePreviewDlg').close();
});
$('#stylePrevFlowBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Membuat contoh di Flow…', async () => {
  if (!previewedStyle) return;
  const prompt = `${previewedStyle.prompt}, ${STYLE_PREVIEW_SUBJECT}`;
  const imgs = await generateThumbBgInFlow({ prompt, ratio: '16:9', autoCreate: true });
  if (imgs[0]) {
    const dataUrl = await saveStylePreview(previewedStyle, imgs[0]);
    $('#stylePrevImg').src = dataUrl;
    $('#stylePrevImg').classList.remove('hidden');
    renderVisualStyles();
    toast(`Contoh gaya "${previewedStyle.label}" disimpan & diunduh ✓`, 'ok');
  }
}));

function renderVisualStyles() {
  const all = llm.visualStyles(settings);
  $('#styleCats').replaceChildren(...VISUAL_STYLE_CATS.map((c) =>
    h('button', {
      class: `chip ${activeStyleCat === c.id ? 'active' : ''}`,
      onclick: () => { activeStyleCat = c.id; renderVisualStyles(); },
    }, c.label)));

  const list = activeStyleCat === 'all' ? all : all.filter((v) => (v.cat || 'ilustrasi') === activeStyleCat);
  $('#visualStyles').replaceChildren(...list.map((v) => {
    const src = stylePreviewSrc(v);
    const st = styleGenStatus.get(v.id) || '';
    const emojiEl = h('span', { class: `style-emoji ${src ? 'hidden' : ''}` }, v.emoji);
    const imgEl = src ? h('img', {
      src, alt: v.label, loading: 'lazy',
      onerror: (ev) => { ev.currentTarget.classList.add('hidden'); emojiEl.classList.remove('hidden'); },
    }) : null;
    const badge = st === 'working'
      ? h('span', { class: 'style-badge working' }, '⏳ Flow…')
      : st === 'error'
      ? h('span', { class: 'style-badge error' }, '⚠︎ Gagal')
      : null;
    return h('div', {
      class: `style-card ${S.visualStyle === v.id ? 'active' : ''} ${st}`,
      onclick: () => { S.visualStyle = v.id; S.creativeEdited = true; renderVisualStyles(); save(); },
    },
    h('div', { class: 'style-thumb' },
      imgEl,
      emojiEl,
      badge,
      h('button', {
        class: 'style-zoom', title: 'Lihat contoh besar',
        onclick: (ev) => { ev.stopPropagation(); openStylePreview(v); },
      }, '🔍')),
    h('div', { class: 'style-info' },
      h('b', {}, `${v.emoji} ${v.label}`),
      h('small', {}, v.bestFor || 'Gaya custom')));
  }));
}

$('#genStylePreviewsBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Flow…', async () => {
  const all = llm.visualStyles(settings);
  const missing = [];
  for (const v of all) {
    if (customStylePreviews.has(v.id)) continue;
    const hasFile = v.preview ? await fetch(v.preview).then((r) => r.ok).catch(() => false) : false;
    if (!hasFile) missing.push(v);
  }
  if (!missing.length) return toast('Semua contoh gaya sudah ada ✓', 'ok');

  flowStop = false;
  styleGenStatus.clear();
  const targets = missing.map((v, k) => ({
    i: k + 1,
    style: v,
    prompt: `${v.prompt}, ${STYLE_PREVIEW_SUBJECT}`,
    image: null,
    status: 'idle',
  }));
  let doneCount = 0;
  let savedCount = 0;
  const activeNames = () => targets.filter((t) => t.status === 'working').map((t) => t.style.label);
  const syncStyleBar = (sub) => {
    const names = activeNames();
    showAutoBar(true, {
      title: `🌊 Membuat contoh gaya (${doneCount}/${targets.length})`,
      sub: sub || (names.length ? `Sedang buat: ${names.join(', ')}` : 'Menyiapkan Google Flow…'),
      pct: doneCount / Math.max(1, targets.length),
    });
  };
  setProgress('#styleGenProgress', 0);
  syncStyleBar('Membuka / menyiapkan Google Flow…');
  try {
    const r = await runFlowBatch({
      targets,
      totalScenes: targets.length,
      ratio: '16:9',
      parallel: getFlowParallel(),
      settings,
      autoCreate: true,
      shouldStop: () => flowStop,
      onSceneUpdate: async (sc) => {
        if (sc.status === 'working') styleGenStatus.set(sc.style.id, 'working');
        else if (sc.status === 'error') styleGenStatus.set(sc.style.id, 'error');
        else styleGenStatus.delete(sc.style.id);

        if (sc.image && !sc._savedPreview) {
          sc._savedPreview = true;
          styleGenStatus.delete(sc.style.id);
          await saveStylePreview(sc.style, sc.image).catch(() => {});
          savedCount++;
        }
        renderVisualStyles();
        syncStyleBar();
      },
      onBatchProgress: (done, tot) => {
        doneCount = done;
        setProgress('#styleGenProgress', done / Math.max(1, tot));
        syncStyleBar();
      },
      onStatus: (msg) => syncStyleBar(msg),
    });
    toast(`${savedCount} contoh gaya dibuat & diunduh ke Downloads/Klipin/style-previews/ ✓${r.fail ? ` (${r.fail} gagal)` : ''}`, r.fail ? 'err' : 'ok');
  } finally {
    styleGenStatus.clear();
    renderVisualStyles();
    setProgress('#styleGenProgress', null);
    showAutoBar(false);
  }
}));

$('#autoCreativeBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Memilih…', async () => {
  const topic = (S.rawTitle || S.title).trim();
  if (!topic) throw new Error('Tulis topik/ide video dulu di atas.');
  const pick = await llm.suggestCreativeBrief(settings, {
    topic, preset: S.preset || 'shorts', minutes: S.minutes, lang: S.lang,
  });
  S.format = pick.format;
  if (pick.narrStyle !== S.narrStyle) { S.narrStyle = pick.narrStyle; S.styleInstrEdited = false; }
  S.visualStyle = pick.visualStyle;
  S.loop = pick.loop;
  S.ttsVoices.gemini = pick.voice;
  S.creativeReason = pick.reason;
  S.creativeEdited = false;
  activeStyleCat = 'all';
  initUI();
  save();
  toast('Arahan kreatif dipilihkan AI ✓', 'ok');
}));

const showLoop = () => { $('#loopRow').hidden = S.minutes >= 2; $('#loop').checked = !!S.loop; };
$('#format').addEventListener('change', (e) => { S.format = e.target.value; S.creativeEdited = true; $('#formatHint').textContent = fmtStyle().hint; save(); });
$('#narrStyle').addEventListener('change', (e) => { S.narrStyle = e.target.value; S.creativeEdited = true; S.styleInstrEdited = false; refreshStyleInstr(); save(); });
$('#minutes').addEventListener('change', (e) => { S.minutes = Number(e.target.value); S.preset = ''; renderPresets(); showLoop(); refreshStyleInstr(); save(); });
$('#loop').addEventListener('change', (e) => { S.loop = e.target.checked; S.creativeEdited = true; refreshStyleInstr(); save(); });

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
  if (!S.styleInstrEdited) {
    S.styleInstr = (narrStyle().tts[S.lang] || narrStyle().tts.id) + (S.loop && S.minutes < 2 ? llm.LOOP_STYLE_TAIL[S.lang] || llm.LOOP_STYLE_TAIL.id : '');
  }
  $('#styleInstr').value = S.styleInstr;
}

function updateScriptMeta() {
  const words = S.script.trim() ? S.script.trim().split(/\s+/).length : 0;
  const est = words / (WPM[S.lang] || 150);
  $('#scriptMeta').textContent = words ? `${words} kata · ±${est.toFixed(1)} menit` : '';
}

const voiceCache = new Map();
const voiceLoading = new Set();

function allTtsEngines() {
  return [
    { id: 'aistudio', kind: 'gemini', name: '✨ AI Studio Auto (Gratis)', ready: true },
    ...llm.ttsEngines(settings),
  ];
}

function ttsEngine() {
  const all = allTtsEngines();
  return all.find((e) => e.id === S.ttsEngine) || all[0];
}

function canLoadVoicesFromApi(eng) {
  if (eng.kind === 'eleven') return eng.ready;
  if (eng.kind === 'openai') return eng.ready;
  return !!settings.gemini.key;
}

function renderTtsEngines(autoPick = false) {
  const engines = allTtsEngines();
  const cur = engines.find((e) => e.id === S.ttsEngine);
  if (!cur || (autoPick && !cur.ready)) {
    const apiReady = engines.find((e) => e.id !== 'aistudio' && e.ready);
    S.ttsEngine = (apiReady || engines[0]).id;
  }
  $('#ttsEngineSeg').replaceChildren(...engines.map((e) =>
    h('button', {
      class: `${e.id === S.ttsEngine ? 'active' : ''} ${e.ready ? '' : 'off'}`,
      title: e.ready ? '' : 'Belum dikonfigurasi di ⚙︎ Pengaturan',
      onclick: () => { S.ttsEngine = e.id; renderTtsEngines(); save(); },
    }, e.name)));
  renderVoices();
}

async function fetchVoicesFor(eng, { force = false, notify = false } = {}) {
  if (!force && voiceCache.has(eng.id)) return voiceCache.get(eng.id);
  if (voiceLoading.has(eng.id)) return null;
  voiceLoading.add(eng.id);
  let res = null;
  try {
    res = await llm.listVoices(settings, eng.id);
    voiceCache.set(eng.id, res);
    if (notify) toast(res.note || 'Daftar suara diperbarui ✓', res.source === 'api' ? 'ok' : '');
  } catch (e) {
    res = { voices: [], source: 'error', errorMsg: errMsg(e) };
    voiceCache.set(eng.id, res);
    if (notify) toast(`Gagal memuat suara: ${res.errorMsg}`, 'err');
  } finally {
    voiceLoading.delete(eng.id);
    if (ttsEngine().id === eng.id) renderVoices();
  }
  return res;
}

function renderVoices() {
  const eng = ttsEngine();
  const kind = eng.kind;
  const canRefresh = canLoadVoicesFromApi(eng);
  $('#refreshVoicesBtn').classList.toggle('hidden', !canRefresh);
  $('#ttsAutoBtn').textContent = eng.id === 'aistudio'
    ? '⚡ Buat Suara Otomatis via AI Studio (Gratis)'
    : `⚡ Buat Suara Langsung via ${eng.name}`;
  $('#ttsAutoBtn').disabled = !eng.ready;
  $('#ttsAutoBtn').title = eng.ready ? '' : `${eng.name} belum dikonfigurasi — isi API key di ⚙︎ Pengaturan`;

  if (canRefresh && !voiceCache.has(eng.id) && !voiceLoading.has(eng.id)) {
    fetchVoicesFor(eng);
  }
  const cached = voiceCache.get(eng.id);
  const loading = voiceLoading.has(eng.id);

  const baseHint = eng.id === 'aistudio'
    ? 'Otomatis membuka Google AI Studio di Chrome, memilih suara, mengisi naskah, menekan Run, dan mengambil audionya.'
    : !eng.ready
    ? `${eng.name} belum dikonfigurasi — isi di ⚙︎ Pengaturan atau pilih AI Studio Auto (Gratis).`
    : kind === 'gemini' ? 'Menggunakan Gemini TTS API.'
    : kind === 'eleven' ? 'Gaya baca ElevenLabs mengikuti karakter suara.'
    : /gpt-4o/.test(settings.compat.find((c) => c.id === eng.id)?.ttsModel || '') ? 'Style instruction ikut dikirim ke model.' : 'Model ini mengabaikan style instruction.';
  $('#ttsHint').textContent = baseHint + (loading ? ' · Memeriksa suara dari API…' : cached?.note ? ` · ${cached.note}` : '');

  $('#customVoiceInput').placeholder = kind === 'gemini'
    ? 'Nama/ID suara Gemini baru (mis. Achird, voice_…)'
    : kind === 'openai'
    ? 'Nama/ID suara OpenAI baru (mis. marin, cedar, voice_…)'
    : 'Voice ID ElevenLabs…';

  const pick = (id) => { S.ttsVoices[kind] = id; renderVoices(); save(); };
  const btn = (v) => h('button', {
    class: `voice ${v.custom ? 'custom ' : ''}${S.ttsVoices[kind] === v.id ? 'active' : ''}`,
    onclick: () => pick(v.id),
  }, h('b', {}, `${v.name} `), h('span', { class: 'meta' }, v.gender === 'L' ? '♂' : v.gender === 'P' ? '♀' : ''), h('small', {}, v.desc || ''));

  const defaults = kind === 'gemini' ? VOICES.map((v) => ({ ...v, id: v.name }))
    : kind === 'openai' ? llm.OPENAI_VOICES
    : [];

  if (kind === 'eleven') {
    if (!eng.ready) return $('#voices').replaceChildren();
    if (!cached && loading) return $('#voices').replaceChildren(h('div', { class: 'hint' }, 'Memuat daftar suara ElevenLabs…'));
    if (cached?.source === 'error') {
      return $('#voices').replaceChildren(h('div', { class: 'hint' }, `Gagal memuat suara: ${cached.errorMsg}`));
    }
  }

  let list = (cached?.voices?.length ? cached.voices : defaults).slice();
  const activeVoice = String(S.ttsVoices[kind] || '').trim();
  if (kind === 'eleven' && !activeVoice && list[0]) S.ttsVoices.eleven = list[0].id;
  if (activeVoice && !list.some((v) => v.id === activeVoice)) {
    list = [{ id: activeVoice, name: activeVoice, gender: '', desc: 'Suara custom / manual', custom: true }, ...list];
  }
  $('#voices').replaceChildren(...list.map(btn));
}

function applyCustomVoice() {
  const val = $('#customVoiceInput').value.trim();
  if (!val) return toast('Ketik nama atau ID suara dulu.', 'err');
  const eng = ttsEngine();
  S.ttsVoices[eng.kind] = val;
  $('#customVoiceInput').value = '';
  renderVoices();
  save();
  toast(`Suara "${val}" dipilih ✓`, 'ok');
}

$('#refreshVoicesBtn').addEventListener('click', () => {
  const eng = ttsEngine();
  voiceCache.delete(eng.id);
  renderVoices();
  fetchVoicesFor(eng, { force: true, notify: true });
});
$('#applyCustomVoiceBtn').addEventListener('click', applyCustomVoice);
$('#customVoiceInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyCustomVoice(); }
});
$('#script').addEventListener('input', (e) => { S.script = e.target.value; updateScriptMeta(); save(); });
$('#styleInstr').addEventListener('input', (e) => { S.styleInstr = e.target.value; S.styleInstrEdited = true; save(); });

$('#writeScriptBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Menulis naskah…', async () => {
  const title = S.title || S.rawTitle;
  if (!title) throw new Error('Judul masih kosong.');
  if (S.script.trim() && !confirm('Naskah yang ada akan diganti. Lanjut?')) return;
  const stEl = $('#scriptStatus');
  stEl.classList.remove('hidden');
  try {
    S.script = await llm.writeScript(settings, {
      title, format: fmtStyle(), style: narrStyle(), minutes: S.minutes, lang: S.lang,
      wpm: WPM[S.lang] || 150, loop: S.loop,
      onProgress: (msg) => { stEl.textContent = `⏳ ${msg}`; },
    });
    $('#script').value = S.script;
    updateScriptMeta();
    save();
    toast('Naskah selesai ✓', 'ok');
  } finally {
    stEl.classList.add('hidden');
  }
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

$('#ttsAutoBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Membuat suara…', async () => {
  if (!S.script.trim()) throw new Error('Naskah masih kosong.');
  const eng = ttsEngine();
  let out;
  if (eng.id === 'aistudio') {
    out = await synthesizeViaAiStudio({
      script: S.script,
      styleInstr: S.styleInstr,
      voice: S.ttsVoices.gemini,
      onProgress: (i, n, msg) => {
        setProgress('#ttsProgress', n ? i / n : null);
        if (msg) $('#ttsHint').textContent = msg;
      },
    });
  } else {
    out = await llm.synthesize(settings, {
      engine: eng.id, text: S.script, styleInstruction: S.styleInstr, voice: S.ttsVoices[eng.kind],
      onProgress: (i, n) => setProgress('#ttsProgress', i / n),
    });
  }
  setProgress('#ttsProgress', null);
  await setAudio(out);
  doTrim({ quiet: true, normalize: true });
  toast('Suara siap & otomatis dirapikan ✓', 'ok');
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
  pauseMemo = null;
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
    doTrim({ quiet: true, normalize: true });
    toast('Audio siap & dirapikan ✓', 'ok');
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

// ---------------------------------------------------------------- step 3: storyboard (scene + gambar)

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

function resyncScenes(quiet = false) {
  const a = currentAudio();
  if (!a || !S.scenes.length) {
    if (!quiet) toast(!a ? 'Belum ada audio.' : 'Belum ada scene.', 'err');
    return false;
  }
  retimeScenes(S.scenes, audioLib.duration(a), audioPauses());
  S.syncV = SYNC_V;
  renderStoryboard();
  save();
  if (!quiet) toast('Waktu scene & subtitle disinkronkan dengan audio ✓', 'ok');
  return true;
}

function doTrim({ quiet = false, normalize = true } = {}) {
  if (!audioRaw) {
    if (!quiet) toast('Belum ada audio. Buat atau upload di langkah Naskah.', 'err');
    return;
  }
  const edgeKeepSec = S.loop && S.minutes < 2 ? 0.025 : 0.15;
  const { audio, removed, cuts } = audioLib.trimSilence(audioRaw, { maxPause: Number(S.maxPause), edgeKeepSec });
  const finalAudio = normalize ? audioLib.normalizeLoudness(audio) : audio;
  audioTrim = cuts.length ? { ...finalAudio, cuts } : finalAudio;
  pauseMemo = null;
  kvSet('audioTrim', audioTrim);
  if (S.scenes.length) resyncScenes(true);
  showTrim();
  save();
  if (!quiet) toast(`Jeda dipotong: −${removed.toFixed(1)} detik${normalize ? ' + loudness diratakan' : ''}`, 'ok');
}

$('#maxPause').addEventListener('input', (e) => { S.maxPause = Number(e.target.value); showTrim(); save(); });
$('#trimBtn').addEventListener('click', () => doTrim({ quiet: false, normalize: true }));
$('#sceneSec').addEventListener('change', (e) => { S.sceneSec = Number(e.target.value); save(); });

function sbCardClass(s) {
  const ratioCls = S.ratio === '9:16' ? 'portrait' : S.ratio === '1:1' ? 'square' : '';
  const stCls = s.status === 'working' ? 'working' : s.status === 'error' ? 'error' : s.prompt && s.image ? 'ready' : '';
  return `sb-card ${ratioCls} ${stCls}`.trim();
}

function storyboardCardEl(s) {
  const status = s.status === 'working' ? '⏳ Flow…' : s.status === 'error' ? `⚠︎ ${s.error || 'gagal'}` : 'belum ada gambar';
  return h('div', { class: sbCardClass(s), id: `sb-${s.i}` },
    h('div', { class: 'sb-thumb' },
      s.image ? h('img', { src: s.image, alt: `Scene ${s.i}` }) : h('div', { class: 'st' }, status),
      h('span', { class: 'n' }, s.i),
      h('div', { class: 'acts' },
        h('button', { title: 'Buat ulang di Flow', onclick: () => runFlowForTargets([s]) }, '↻'),
        h('button', { title: 'Upload gambar sendiri', onclick: () => pickImageFor(s) }, '⬆'),
        s.image && s.alts?.length > 0 && h('button', { title: `Ganti gambar lain (${s.alts.length + 1})`, onclick: () => swapAlt(s) }, `⇄${s.alts.length + 1}`),
        s.image && h('button', { title: 'Hapus gambar', onclick: () => { s.image = null; s.alts = []; s.status = 'idle'; updateStoryboardCard(s); save(); } }, '✕'))),
    h('div', { class: 'sb-body' },
      h('header', {}, h('span', {}, `SCENE ${s.i}`), h('span', {}, `${fmtTime(s.start)} – ${fmtTime(s.end)}`)),
      h('div', { class: 'txt' }, s.text),
      h('textarea', {
        rows: 2, placeholder: 'prompt gambar…',
        oninput: (e) => { s.prompt = e.target.value; save(); },
      }, s.prompt)));
}

function updateStoryboardCard(s) {
  const old = document.getElementById(`sb-${s.i}`);
  if (old) old.replaceWith(storyboardCardEl(s));
  renderStoryboardMeta();
}

function renderStoryboardMeta() {
  if (!S.scenes.length) {
    $('#sceneInfo').textContent = 'Belum ada storyboard.';
    $('#flowInfo').textContent = '';
    updateStepper();
    return;
  }
  const dur = S.scenes[S.scenes.length - 1].end;
  const readyImg = S.scenes.filter((s) => s.image).length;
  $('#sceneInfo').textContent = `${S.scenes.length} scene · total ${fmtTime(dur)}`;
  $('#flowInfo').textContent = `${readyImg}/${S.scenes.length} gambar siap`;
  updateStepper();
}

function renderStoryboard() {
  const list = $('#storyboardList');
  if (!S.scenes.length) {
    renderStoryboardMeta();
    return list.replaceChildren();
  }
  list.replaceChildren(...S.scenes.map(storyboardCardEl));
  renderStoryboardMeta();
}

function swapAlt(s) {
  s.alts.push(s.image);
  s.image = s.alts.shift();
  updateStoryboardCard(s);
  save();
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
    updateStoryboardCard(scene);
    save();
  };
  imgPicker.click();
}

{
  const list = $('#storyboardList');
  list.addEventListener('dragover', (e) => { e.preventDefault(); list.classList.add('over'); });
  list.addEventListener('dragleave', () => list.classList.remove('over'));
  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('over');
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const empty = S.scenes.filter((s) => !s.image);
    for (let k = 0; k < files.length && k < empty.length; k++) {
      empty[k].image = await normalizeImage(files[k]);
      empty[k].status = 'done';
      updateStoryboardCard(empty[k]);
    }
    save();
    if (files.length) toast(`${Math.min(files.length, empty.length)} gambar dimasukkan ✓`, 'ok');
  });
}

async function buildPrompts(onProgress) {
  const vs = visualStyle();
  const title = S.title || S.rawTitle;
  setProgress('#sceneProgress', 0);
  onProgress?.('Menyiapkan konsistensi karakter…');
  const note = await llm.characterBible(settings, { title, script: S.script || S.scenes.map((s) => s.text).join(' '), visualStyle: vs });
  const BATCH = 8;
  for (let b = 0; b < S.scenes.length; b += BATCH) {
    const batch = S.scenes.slice(b, b + BATCH);
    onProgress?.(`Membuat prompt scene ${b + 1}–${b + batch.length}/${S.scenes.length}…`);
    batch.forEach((s) => document.getElementById(`sb-${s.i}`)?.classList.add('working'));
    const out = await llm.scenePrompts(settings, { title, visualStyle: vs, ratio: S.ratio, scenes: batch, characterNote: note });
    for (const o of out) {
      const sc = S.scenes.find((s) => s.i === Number(o.i));
      if (sc && o.prompt) sc.prompt = String(o.prompt).trim();
    }
    batch.forEach((s) => { if (!s.prompt) s.prompt = `${vs.prompt}. Scene illustrating: ${s.text}`; });
    setProgress('#sceneProgress', (b + batch.length) / S.scenes.length);
    renderStoryboard();
    save();
  }
  setProgress('#sceneProgress', null);
}

function confirmReplaceScenes() {
  return !S.scenes.some((s) => s.image) || confirm('Scene & gambar yang sudah ada akan diganti. Lanjut?');
}

async function scenesFromScriptNow(onProgress) {
  if (!S.script.trim()) throw new Error('Naskah masih kosong (langkah 2).');
  if (audioRaw && !audioTrim) doTrim({ quiet: true, normalize: true });
  const a = currentAudio();
  const total = a ? audioLib.duration(a) : (S.script.split(/\s+/).length / (WPM[S.lang] || 150)) * 60;
  if (!a) toast('Belum ada audio — durasi scene diperkirakan dari panjang naskah.');
  S.scenes = scenesFromScript(S.script, total, S.sceneSec, audioPauses());
  S.syncV = SYNC_V;
  renderStoryboard();
  await buildPrompts(onProgress);
}

async function scenesFromTranscriptNow(onProgress) {
  if (!audioRaw) throw new Error('Buat atau upload audio dulu (langkah 2).');
  if (!audioTrim) doTrim({ quiet: true, normalize: true });
  const a = currentAudio();
  onProgress?.('Menyiapkan audio untuk transkrip…');
  const chunks = await audioLib.wavChunksForTranscription(a);
  setProgress('#sceneProgress', 0);
  const segs = await llm.transcribe(settings, {
    chunks, lang: S.lang,
    onProgress: (i, n) => { onProgress?.(`Mentranskrip audio ${i}/${n}…`); setProgress('#sceneProgress', i / n); },
  });
  if (!segs.length) throw new Error('Transkrip kosong.');
  S.scenes = scenesFromTranscript(segs, audioLib.duration(a), S.sceneSec, audioPauses());
  S.syncV = SYNC_V;
  renderStoryboard();
  await buildPrompts(onProgress);
}

$('#buildStoryboardBtn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  busy(btn, '⏳ Menyusun storyboard…', async () => {
    if (!S.script.trim()) throw new Error('Naskah masih kosong (langkah 2).');
    if (!confirmReplaceScenes()) return;
    await scenesFromScriptNow((msg) => { btn.textContent = `⏳ ${msg}`; });
    toast(`${S.scenes.length} scene siap ✓`, 'ok');
  }).finally(() => setProgress('#sceneProgress', null));
});

$('#transcribeBtn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  busy(btn, '⏳ Mentranskrip audio…', async () => {
    if (!audioRaw) throw new Error('Upload atau buat audio dulu (langkah 2).');
    if (!confirmReplaceScenes()) return;
    await scenesFromTranscriptNow((msg) => { btn.textContent = `⏳ ${msg}`; });
    toast(`${S.scenes.length} scene dari transkrip siap ✓`, 'ok');
  }).finally(() => setProgress('#sceneProgress', null));
});

$('#resyncBtn3').addEventListener('click', () => resyncScenes());

async function checkFlow() {
  const pill = $('#flowStatus');
  pill.textContent = 'memeriksa…';
  pill.className = 'pill';
  const c = await connectFlow();
  pill.textContent = c.ok ? 'terhubung ✓' : c.reason;
  pill.className = `pill ${c.ok ? 'ok' : 'err'}`;
  return c;
}

$('#openFlowBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Menyiapkan Flow…', async () => {
  const c = await ensureFlowProject({ autoCreate: true });
  await checkFlow();
  if (!c.ok) throw new Error(c.reason);
  toast('Project Google Flow siap ✓', 'ok');
}));
$('#checkFlowBtn').addEventListener('click', checkFlow);

let flowRecheck;
const recheckFlowSoon = () => {
  if (S.step !== 3 || !$('#stopFlowBtn').classList.contains('hidden')) return;
  clearTimeout(flowRecheck);
  flowRecheck = setTimeout(checkFlow, 600);
};
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if ((info.status === 'complete' || info.url) && isFlowUrl(tab.url)) recheckFlowSoon();
});
chrome.tabs.onActivated.addListener(recheckFlowSoon);
chrome.tabs.onRemoved.addListener(recheckFlowSoon);

chrome.storage.local.get('flowParallel').then(({ flowParallel: v }) => { if (v) $('#flowPar').value = String(v); });
$('#flowPar').addEventListener('change', () => chrome.storage.local.set({ flowParallel: getFlowParallel() }));

async function runFlowForTargets(targets) {
  if (!targets.length) return toast('Semua scene sudah punya gambar.', 'ok');
  flowStop = false;
  $('#sendAllBtn').disabled = true;
  $('#stopFlowBtn').classList.remove('hidden');
  try {
    const r = await runFlowBatch({
      targets,
      totalScenes: S.scenes.length,
      ratio: S.ratio,
      parallel: getFlowParallel(),
      settings,
      visualStyle: visualStyle(),
      autoCreate: true,
      shouldStop: () => flowStop,
      onSceneUpdate: (sc) => {
        updateStoryboardCard(sc);
        document.getElementById(`sb-${sc.i}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        save();
      },
      onBatchProgress: (done, tot) => setProgress('#flowProgress', done / Math.max(1, tot)),
      onStatus: (msg) => toast(msg),
    });
    toast(`Flow selesai: ${r.ok} berhasil${r.fail ? `, ${r.fail} gagal (klik ↻ untuk ulang)` : ''}`, r.fail ? 'err' : 'ok');
    return r;
  } catch (e) {
    toast(errMsg(e), 'err');
  } finally {
    setProgress('#flowProgress', null);
    $('#sendAllBtn').disabled = false;
    $('#stopFlowBtn').classList.add('hidden');
    checkFlow();
  }
}

$('#sendAllBtn').addEventListener('click', () => {
  const only = $('#onlyMissing').checked;
  runFlowForTargets(S.scenes.filter((s) => !only || !s.image));
});
$('#stopFlowBtn').addEventListener('click', () => {
  flowStop = true;
  toast('Berhenti setelah scene yang sedang diproses selesai.');
});

// ---------------------------------------------------------------- step 4: preview & render

let previewBitmapCache = new Map();
let previewSeq = 0;

function clearPreviewCache() {
  previewBitmapCache.forEach((b) => b.close?.());
  previewBitmapCache.clear();
}

async function getPreviewBitmap(src) {
  if (!src) return null;
  if (!previewBitmapCache.has(src)) {
    const bmp = await createImageBitmap(await (await fetch(src)).blob()).catch(() => null);
    if (bmp) previewBitmapCache.set(src, bmp);
  }
  return previewBitmapCache.get(src) || null;
}

function initPreviewSlider() {
  const a = currentAudio();
  const dur = Math.max(0.5, a ? audioLib.duration(a) : S.scenes.at(-1)?.end || 10);
  const range = $('#previewRange');
  range.max = String(dur.toFixed(1));
  if (Number(range.value) > dur) range.value = '0';
  renderPreview();
}

async function renderPreview() {
  const seq = ++previewSeq;
  const canvas = $('#previewCanvas');
  if (!canvas) return;
  const { w, h: hh } = outputSize(S.ratio, 720);
  if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
  const a = currentAudio();
  const dur = Math.max(0.1, a ? audioLib.duration(a) : S.scenes.at(-1)?.end || 0);
  const t = Math.min(dur, Math.max(0, Number($('#previewRange').value) || 0));
  $('#previewTime').textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;

  const timeline = await Promise.all(S.scenes.map(async (s, idx) => ({
    start: s.start, end: s.end, k: idx, bmp: await getPreviewBitmap(s.image),
  })));
  if (seq !== previewSeq) return;
  const cues = S.subtitles ? subtitleCues(S.scenes, audioPauses()) : [];
  const hook = S.hook?.on && S.hook.text?.trim() ? { text: S.hook.text, sec: 2 } : null;
  const byI = new Map(S.scenes.map((x) => [x.i, x]));
  const callouts = S.callouts?.on ? (S.callouts.list || []).map((c) => {
    const sc = byI.get(c.i);
    return sc && { text: c.text, start: Math.max(sc.start + 0.15, hook ? hook.sec : 0), end: sc.end };
  }).filter(Boolean) : [];

  drawFrame(canvas.getContext('2d'), {
    w, h: hh, t, timeline, cues, hook, callouts,
    showSafeZone: $('#previewSafeZone').checked,
  });
}

$('#previewRange').addEventListener('input', renderPreview);
$('#previewSafeZone').addEventListener('change', renderPreview);

function renderSummary() {
  const { w, h: hh } = outputSize(S.ratio, S.res);
  const a = currentAudio();
  const dur = a ? audioLib.duration(a) : S.scenes.at(-1)?.end || 0;
  const imgs = S.scenes.filter((s) => s.image).length;
  $('#renderSummary').replaceChildren(
    h('div', {}, '🎞️ ', h('b', {}, `${w}×${hh}`), ` · ${S.fps} fps · durasi `, h('b', {}, fmtTime(dur))),
    h('div', {}, '🖼️ ', h('b', {}, `${imgs}/${S.scenes.length}`), ' gambar scene', imgs < S.scenes.length ? ' (scene kosong memakai gambar terdekat)' : ''),
    h('div', {}, '🔊 ', a ? h('b', {}, audioTrim ? 'Voiceover (jeda dipotong & loudness diratakan)' : 'Voiceover') : 'Tanpa audio'),
  );
}

$('#resyncBtn').addEventListener('click', () => { resyncScenes(); renderSummary(); initPreviewSlider(); });

$('#subtitles').addEventListener('change', (e) => { S.subtitles = e.target.checked; save(); renderPreview(); });
$('#hookOn').addEventListener('change', (e) => { S.hook.on = e.target.checked; $('#hookBox').classList.toggle('hidden', !S.hook.on); save(); renderPreview(); });
$('#hookText').addEventListener('input', (e) => { S.hook.text = e.target.value; S.hook.auto = ''; save(); renderPreview(); });
$('#calloutOn').addEventListener('change', (e) => { S.callouts.on = e.target.checked; $('#calloutBox').classList.toggle('hidden', !S.callouts.on); save(); renderPreview(); });
$('#calloutText').addEventListener('input', (e) => { S.callouts.list = parseCallouts(e.target.value); S.callouts.auto = ''; save(); renderPreview(); });

$('#calloutSuggestBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳', async () => {
  const n = (await suggestCallouts()).length;
  renderPreview();
  toast(`${n} angka penting ✓`, 'ok');
}));
$('#hookSuggestBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳', async () => {
  await suggestHook();
  renderPreview();
  toast('Teks hook diusulkan ✓', 'ok');
}));

const hookKey = () => (S.script || S.scenes.map((x) => x.text).join(' ')).slice(0, 300);
async function suggestHook() {
  const text = await llm.hookText(settings, { title: S.title || S.rawTitle, script: S.script || S.scenes.map((x) => x.text).join(' '), lang: S.lang });
  S.hook.text = text;
  S.hook.auto = hookKey();
  $('#hookText').value = text;
  save();
  return text;
}

const calloutKey = () => S.scenes.map((x) => x.text).join('|').slice(0, 600);
const calloutLines = (list) => list.map((c) => `${c.i}: ${c.text}`).join('\n');
function parseCallouts(txt) {
  return txt.split('\n').map((l) => /^\s*(\d+)\s*[:.)-]\s*(.+)$/.exec(l)).filter(Boolean)
    .map((m) => ({ i: Number(m[1]), text: m[2].trim() }));
}
async function suggestCallouts() {
  if (!S.scenes.length) throw new Error('Belum ada scene (langkah 3).');
  const list = await llm.sceneCallouts(settings, { title: S.title || S.rawTitle, scenes: S.scenes, lang: S.lang });
  S.callouts.list = list;
  S.callouts.auto = calloutKey();
  $('#calloutText').value = calloutLines(list);
  save();
  return list;
}

async function calloutsForRender(hook) {
  if (!S.callouts.on) return [];
  if (!S.callouts.list.length || (S.callouts.auto && S.callouts.auto !== calloutKey())) {
    try { await suggestCallouts(); } catch (e) { console.warn('[Klipin] angka di layar', e); return []; }
  }
  const byI = new Map(S.scenes.map((x) => [x.i, x]));
  return S.callouts.list.map((c) => {
    const sc = byI.get(c.i);
    return sc && { text: c.text, start: Math.max(sc.start + 0.15, hook ? hook.sec : 0), end: sc.end };
  }).filter(Boolean);
}

async function hookForRender() {
  if (!S.hook.on) return null;
  if (!S.hook.text.trim() || (S.hook.auto && S.hook.auto !== hookKey())) {
    try { await suggestHook(); } catch (e) { console.warn('[Klipin] teks hook', e); return null; }
  }
  return { text: S.hook.text, sec: 2 };
}

function showRenderedVideo(blobOrUrl, infoText) {
  const v = $('#resultVideo');
  if (resultVideoUrl) URL.revokeObjectURL(resultVideoUrl);
  resultVideoUrl = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  v.src = resultVideoUrl;
  v.classList.remove('hidden');
  $('#renderInfo').textContent = infoText;
}

$('#renderBtn').addEventListener('click', async () => {
  if (!S.scenes.some((s) => s.image)) return toast('Belum ada gambar scene (langkah 3).', 'err');
  const name = `${safeName(S.title || S.rawTitle)}.mp4`;

  let fileHandle = null;
  if (window.showSaveFilePicker) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: name, startIn: 'downloads',
        types: [{ description: 'Video MP4', accept: { 'video/mp4': ['.mp4'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      fileHandle = null;
    }
  }

  try {
    const out = await renderVideo(fileHandle);
    let url;
    if (out.blob) {
      const savedPath = await downloadBlob(out.blob, `${safeName(S.title || S.rawTitle)}/${name}`);
      S.lastVideo = savedPath;
      save();
      url = out.blob;
    } else {
      url = URL.createObjectURL(await fileHandle.getFile());
    }
    showRenderedVideo(url, `✅ Video jadi dalam ${out.elapsed.toFixed(0)} detik (${fmtTime(out.duration)}, ${out.width}×${out.height}${out.encoder === 'software' ? ', encoder software' : ''}) — tersimpan sebagai "${fileHandle?.name || name}".`);
    toast('Render selesai ✓', 'ok');
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || errMsg(e), 'err');
  }
});

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

async function renderVideo(fileHandle = null, onProgress = () => {}) {
  if (!S.scenes.some((s) => s.image)) throw new Error('Belum ada gambar scene (langkah 3).');
  const btn = $('#renderBtn');
  btn.disabled = true;
  $('#cancelRenderBtn').classList.remove('hidden');
  $('#resultVideo').classList.add('hidden');
  renderAbort = new AbortController();
  try {
    $('#renderInfo').textContent = S.hook.on ? 'Menyiapkan teks hook…' : '';
    const hook = await hookForRender();
    if (S.callouts.on) $('#renderInfo').textContent = 'Menyiapkan angka penting di layar…';
    const callouts = await calloutsForRender(hook);
    renderPreview();
    return await renderMp4({
      scenes: S.scenes, audio: currentAudio(), pauses: audioPauses(), ratio: S.ratio, res: S.res, fps: S.fps, subtitles: S.subtitles, hook, callouts,
      tailSec: S.loop && S.minutes < 2 ? 0 : DEFAULT_TAIL_SEC,
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

// ---------------------------------------------------------------- step 5: publish & thumbnail

function ensureYt() {
  S.yt ||= { titles: [], title: '', desc: '', tags: '', thumbTexts: [], thumbPrompt: '', bgs: [], thumb: {} };
  S.yt.thumb = { text: '', pos: 'left', color: 'yellow', bg: '', ...S.yt.thumb };
  S.yt.thumbTypes ||= [];
  S.yt.concepts ||= [];
  S.yt.conceptSel ??= -1;
  return S.yt;
}

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

function fitTags(tags, max = 480) {
  const out = [];
  let len = 0;
  for (const t of tags) {
    if (len + t.length + 1 > max) break;
    out.push(t);
    len += t.length + 1;
  }
  return out.join(', ');
}

$('#ytGenBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Menyusun paket publish…', async () => {
  await makeYoutubePack();
  await makeThumbConcepts();
  toast('Paket publish & konsep thumbnail siap ✓', 'ok');
}));

async function makeYoutubePack() {
  if (!S.script.trim() && !S.scenes.length) throw new Error('Naskah masih kosong (langkah 2).');
  const scenes = S.scenes.map((x) => ({ i: x.i, t: fmtTime(x.start), text: x.text }));
  const out = await llm.youtubePack(settings, {
    title: S.title || S.rawTitle, script: S.script || S.scenes.map((x) => x.text).join(' '), scenes, lang: S.lang, ratio: S.ratio,
  });
  const yt = ensureYt();
  const chap = S.minutes >= 2 ? chaptersText(out.chapters) : '';
  yt.titles = S.title && !out.titles.includes(S.title) ? [S.title, ...out.titles].slice(0, 5) : out.titles;
  yt.title = S.title || out.titles[0] || '';
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
  renderThumbTypes();
  renderConcepts();
  drawThumb($('#thumbCanvas'), S, yt.thumb, { onSize: (w, hh) => { $('#thumbSizeMeta').textContent = `${w}×${hh}`; } });
}

function renderThumbTexts() {
  const yt = ensureYt();
  $('#ytThumbTexts').replaceChildren(...yt.thumbTexts.map((t) => h('button', {
    class: `chip ${yt.thumb.text === t ? 'active' : ''}`,
    onclick: () => { yt.thumb.text = t; $('#thumbText').value = t; renderThumbTexts(); drawThumb($('#thumbCanvas'), S, yt.thumb); save(); },
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
$('#thumbText').addEventListener('input', (e) => { ensureYt().thumb.text = e.target.value; renderThumbTexts(); drawThumb($('#thumbCanvas'), S, ensureYt().thumb); save(); });
$('#ytCopyTitle').addEventListener('click', () => copy(ensureYt().title, 'Judul'));
$('#ytCopyDesc').addEventListener('click', () => copy(ensureYt().desc, 'Deskripsi'));
$('#ytCopyTags').addEventListener('click', () => copy(ensureYt().tags, 'Tag'));

function renderThumbBgs() {
  const cur = currentBg(S);
  $('#thumbBgs').replaceChildren(...thumbBgList(S).map((b) => h('button', {
    class: b.key === cur?.key ? 'active' : '', title: b.label,
    onclick: () => { ensureYt().thumb.bg = b.key; renderThumbBgs(); drawThumb($('#thumbCanvas'), S, ensureYt().thumb); save(); },
  }, h('img', { src: b.src, alt: b.label }), h('span', {}, b.label))));
}

async function addThumbBg(src) {
  const yt = ensureYt();
  yt.bgs.unshift(await normalizeImage(src, 1600));
  yt.bgs = yt.bgs.slice(0, 6);
  yt.thumb.bg = 'g0';
  renderThumbBgs();
  drawThumb($('#thumbCanvas'), S, yt.thumb);
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

const recommendedTypes = () => THUMB_TYPES.filter((t) => t.formats.includes(S.format)).map((t) => t.id);

function selectedTypes() {
  const yt = ensureYt();
  if (!yt.thumbTypes.length) yt.thumbTypes = (recommendedTypes().length ? recommendedTypes() : ['kontras', 'reaksi', 'angka']).slice(0, 3);
  return yt.thumbTypes;
}

function renderThumbTypes() {
  const yt = ensureYt();
  const sel = selectedTypes();
  const rec = recommendedTypes();
  $('#thumbTypesMeta').textContent = `⭐ cocok untuk "${fmtStyle().label}" · pilih 1–4`;
  $('#thumbTypes').replaceChildren(...THUMB_TYPES.map((t) => h('button', {
    class: `chip ${sel.includes(t.id) ? 'active' : ''} ${rec.includes(t.id) ? 'rec' : ''}`,
    title: t.hint,
    onclick: () => {
      yt.thumbTypes = sel.includes(t.id) ? sel.filter((x) => x !== t.id) : [...sel, t.id].slice(-4);
      if (!yt.thumbTypes.length) yt.thumbTypes = [t.id];
      renderThumbTypes();
      save();
    },
  }, `${t.emoji} ${t.label}`)));
  $('#thumbTypeHint').textContent = yt.thumbTypes.map((id) => `${thumbType(id).emoji} ${thumbType(id).hint}`).join(' ');
}

const conceptSpec = (c, k) => ({ text: c.text, pos: layoutPos(thumbType(c.type)), color: c.color, bg: c.image ? `c${k}` : ensureYt().thumb.bg });

function renderConcepts() {
  const yt = ensureYt();
  const tall = S.ratio === '9:16';
  $('#thumbConceptFlowBtn').classList.toggle('hidden', !yt.concepts.some((c) => !c.image));
  $('#thumbConceptFlowBtn').textContent = `🌊 Buat gambar ${yt.concepts.filter((c) => !c.image).length} konsep di Flow`;
  $('#thumbConcepts').replaceChildren(...yt.concepts.map((c, k) => {
    const t = thumbType(c.type);
    const { w, h: hh } = thumbSize(S.ratio);
    const cv = h('canvas', { width: w, height: hh });
    drawThumb(cv, S, conceptSpec(c, k)).catch(() => {});
    const text = h('input', {
      type: 'text', value: c.text, title: t.layout === 'split' ? 'Tulis dua sisi: A | B' : 'Teks thumbnail',
      onclick: (e) => e.stopPropagation(),
      oninput: (e) => {
        c.text = e.target.value;
        drawThumb(cv, S, conceptSpec(c, k));
        if (yt.conceptSel === k) {
          yt.thumb.text = c.text;
          $('#thumbText').value = c.text;
          renderThumbTexts();
          drawThumb($('#thumbCanvas'), S, yt.thumb);
        }
        save();
      },
    });
    return h('div', { class: `concept ${tall ? 'tall' : ''} ${yt.conceptSel === k ? 'active' : ''}`, onclick: () => applyConcept(k) },
      cv,
      h('div', {},
        h('b', {}, `${t.emoji} ${t.label}`),
        h('p', {}, c.idea),
        text,
        h('div', { class: 'row' },
          h('button', {
            class: 'btn', title: c.prompt,
            onclick: (e) => {
              e.stopPropagation();
              busy(e.currentTarget, '⏳ Flow…', async () => {
                await generateConceptImages({ concepts: yt.concepts, ks: [k], ratio: S.ratio, autoCreate: true, onDoneOne: () => { renderConcepts(); save(); } });
                applyConcept(k);
              });
            },
          }, c.image ? '🔄 Gambar ulang' : '🌊 Buat gambar'),
          h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); applyConcept(k); } }, yt.conceptSel === k ? '✓ Dipakai' : 'Pakai'))));
  }));
}

function applyConcept(k) {
  const yt = ensureYt();
  const c = yt.concepts[k];
  if (!c) return;
  yt.conceptSel = k;
  yt.thumb = { ...yt.thumb, ...conceptSpec(c, k) };
  yt.thumbPrompt = c.prompt;
  $('#thumbText').value = yt.thumb.text;
  $('#thumbPrompt').value = yt.thumbPrompt;
  thumbSegs.forEach((f) => f());
  renderThumbTexts();
  renderThumbBgs();
  renderConcepts();
  drawThumb($('#thumbCanvas'), S, yt.thumb);
  save();
}

async function makeThumbConcepts(types = selectedTypes()) {
  if (!S.script.trim() && !S.scenes.length) throw new Error('Naskah masih kosong (langkah 2).');
  const yt = ensureYt();
  const concepts = await llm.thumbConcepts(settings, {
    title: yt.title || S.title || S.rawTitle,
    script: S.script || S.scenes.map((x) => x.text).join(' '),
    format: fmtStyle(), narrStyle: narrStyle(), visualStyle: visualStyle(), ratio: S.ratio, lang: S.lang, types,
  });
  if (!concepts.length) throw new Error('AI tidak mengembalikan konsep thumbnail. Coba lagi.');
  yt.concepts = concepts;
  yt.conceptSel = -1;
  renderConcepts();
  applyConcept(0);
  return concepts;
}

$('#thumbConceptBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Menyusun konsep…', async () => {
  const n = (await makeThumbConcepts()).length;
  toast(`${n} konsep thumbnail ✓ — klik "Buat gambar" untuk latarnya`, 'ok');
}));

$('#thumbConceptFlowBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Membuat gambar di Flow…', async () => {
  const yt = ensureYt();
  const todo = yt.concepts.map((c, k) => (!c.image ? k : -1)).filter((k) => k >= 0);
  const n = await generateConceptImages({
    concepts: yt.concepts, ks: todo, ratio: S.ratio, autoCreate: true,
    onDoneOne: () => { renderConcepts(); save(); },
  });
  if (yt.conceptSel >= 0) applyConcept(yt.conceptSel);
  toast(`${n} gambar konsep dari Flow ✓`, 'ok');
}));

$('#thumbDlBtn').addEventListener('click', async () => {
  const blob = await thumbBlob(S);
  const file = await downloadBlob(blob, `${safeName(ensureYt().title || S.title)}/${safeName(ensureYt().title || S.title)} - thumbnail.jpg`);
  S.lastThumb = file;
  save();
  toast(`Thumbnail tersimpan di ${file} ✓`, 'ok');
});

$('#exportBundleBtn').addEventListener('click', async () => {
  const base = safeName(ensureYt().title || S.title);
  await downloadBlob(new Blob([buildMetadataText(S)], { type: 'text/plain;charset=utf-8' }), `${base}/${base} - metadata.txt`);
  await downloadBlob(new Blob([buildMetadataJson(S)], { type: 'application/json;charset=utf-8' }), `${base}/${base} - metadata.json`);
  toast(`Metadata tersimpan di Downloads/Klipin/${base}/ ✓`, 'ok');
});

$('#ytAttachVideoBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Mengirim…', async () => {
  const r = await agentTools.youtube_attach({ kind: 'video' });
  toast(r.text, 'ok');
}));
$('#ytAttachThumbBtn').addEventListener('click', (e) => busy(e.currentTarget, '⏳ Mengirim…', async () => {
  const r = await agentTools.youtube_attach({ kind: 'image' });
  toast(r.text, 'ok');
}));

let thumbSegs = [];

// ---------------------------------------------------------------- Full Auto & Batch Queue

let autoTimer = null;
let autoStartedAt = 0;

function showAutoBar(show, opts = {}) {
  const bar = $('#autoBar');
  bar.classList.toggle('hidden', !show);
  if (!show) {
    clearInterval(autoTimer);
    autoTimer = null;
    autoStartedAt = 0;
    $('#autoStages').replaceChildren();
    $('#autoSub').textContent = '';
    return;
  }
  if (!autoStartedAt) {
    autoStartedAt = Date.now();
    $('#autoElapsed').textContent = '0:00';
    clearInterval(autoTimer);
    autoTimer = setInterval(() => {
      $('#autoElapsed').textContent = fmtTime((Date.now() - autoStartedAt) / 1000);
    }, 1000);
  }
  const { title = '⚡ Otomasi berjalan…', sub = '', pct = 0, stages = null } = typeof opts === 'string' ? { title: opts } : opts;
  $('#autoTitle').textContent = title;
  $('#autoSub').textContent = sub;
  $('#autoSub').classList.toggle('hidden', !sub);
  $('#autoPct').textContent = pct == null ? '' : `${Math.round(pct * 100)}%`;
  setProgress('#autoProgress', pct);
  if (Array.isArray(stages)) {
    const ico = { done: '✓', running: '⚡', error: '✕', skipped: '–', pending: '·' };
    $('#autoStages').replaceChildren(...stages.map((s) =>
      h('span', { class: `st-pill ${s.status}` }, `${ico[s.status] || '·'} ${s.label}`)));
  } else {
    $('#autoStages').replaceChildren();
  }
}

$('#autoStopBtn').addEventListener('click', () => {
  autoAbort?.abort();
  queueAbort?.abort();
  flowStop = true;
  renderAbort?.abort();
  toast('Menghentikan otomasi…');
});

function pipelineCtx() {
  return {
    getState: () => S,
    getSettings: () => settings,
    getAudioRaw: () => audioRaw,
    getAudioTrim: () => audioTrim,
    currentAudio,
    audioPauses,
    fmtStyle,
    narrStyle,
    visualStyle,
    ttsEngine,
    getFlowParallel,
    ensureYt,
    selectedTypes,
    recommendedTypes,
    connectFlow,
    setAudio,
    doTrim,
    save,
    go,
    initUI,
    renderStep,
    renderTtsEngines,
    refreshStyleInstr,
    renderStoryboard,
    updateStoryboardCard,
    renderSummary,
    renderYt,
    setProgress,
    scenesFromScriptNow,
    scenesFromTranscriptNow,
    makeYoutubePack,
    makeThumbConcepts,
    applyConcept,
    renderVideo,
    showRenderedVideo,
    downloadBlob,
    resetProject,
    agentUrl: AGENT_URL,
    getAgentClientId: () => agentBridge.getClientId(),
  };
}

$('#autoStartBtn').addEventListener('click', async () => {
  if (!S.rawTitle.trim() && !S.title.trim()) return toast('Tulis topik/ide video dulu di Langkah 1.', 'err');
  autoAbort = new AbortController();
  $('#autoStartBtn').disabled = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  showAutoBar(true, { title: '⚡ Memulai otomasi penuh…', sub: 'Menyiapkan pipeline…', pct: 0.02 });
  try {
    const res = await runFullPipeline(pipelineCtx(), {
      publish_pack: true,
      signal: autoAbort.signal,
      onStage: (st) => showAutoBar(true, {
        title: `⚡ [${st.index}/${st.total}] ${st.title}`,
        sub: st.text,
        pct: st.pct,
        stages: st.stages,
      }),
    });
    const warn = res.warnings?.length ? ` (${res.warnings[0]})` : '';
    toast(`Otomasi selesai: ${res.title} ✓${warn}`, res.warnings?.length ? '' : 'ok');
  } catch (e) {
    if (e.name === 'AbortError') toast('Otomasi dihentikan — progres tersimpan, bisa dilanjutkan lagi.');
    else toast(errMsg(e), 'err');
  } finally {
    autoAbort = null;
    showAutoBar(false);
    $('#autoStartBtn').disabled = false;
  }
});

// ---- Antrean Batch
async function renderQueueList() {
  const list = await loadQueue();
  const box = $('#queueList');
  if (!list.length) return box.replaceChildren(h('div', { class: 'hint' }, 'Antrean masih kosong.'));
  const icon = { pending: '⏳', running: '⚡', done: '✅', error: '❌' };
  box.replaceChildren(...list.map((item, idx) =>
    h('div', { class: 'q-item' },
      h('span', {}, icon[item.status] || '⏳'),
      h('div', { class: 'q-txt', title: item.error || item.output || item.topic }, item.topic),
      h('span', { class: 'q-meta' }, item.preset || 'shorts'),
      item.status !== 'running' && h('button', {
        class: 'icon-btn', title: 'Hapus',
        onclick: async () => {
          list.splice(idx, 1);
          await saveQueue(list);
          renderQueueList();
        },
      }, '✕'))));
}

$('#queueBtn').addEventListener('click', async () => {
  await renderQueueList();
  $('#queueDlg').showModal();
});
$('#queueCloseBtn').addEventListener('click', () => $('#queueDlg').close());

$('#queueAddBtn').addEventListener('click', async () => {
  const lines = $('#queueTopics').value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return toast('Masukkan minimal satu topik.', 'err');
  const list = await loadQueue();
  const preset = $('#queuePreset').value;
  const voiceSource = $('#queueVoiceSource').value;
  for (const topic of lines) {
    list.push({ id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, topic, preset, voiceSource, status: 'pending' });
  }
  await saveQueue(list);
  $('#queueTopics').value = '';
  renderQueueList();
  toast(`${lines.length} topik masuk antrean ✓`, 'ok');
});

$('#queueClearDoneBtn').addEventListener('click', async () => {
  const list = (await loadQueue()).filter((x) => x.status !== 'done');
  await saveQueue(list);
  renderQueueList();
});

$('#queueRunBtn').addEventListener('click', async () => {
  const list = await loadQueue();
  if (!list.some((x) => x.status !== 'done')) return toast('Tidak ada item antrean yang menunggu.', 'err');
  queueAbort = new AbortController();
  $('#queueRunBtn').classList.add('hidden');
  $('#queueStopBtn').classList.remove('hidden');
  $('#queueDlg').close();
  try {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await runQueue(pipelineCtx(), {
      signal: queueAbort.signal,
      onUpdate: renderQueueList,
      onStage: (st) => showAutoBar(true, {
        title: `📋 Batch ${st.queueIndex}/${st.queueTotal} · ${st.topic.slice(0, 28)}`,
        sub: `[${st.index}/${st.total}] ${st.title}: ${st.text}`,
        pct: st.pct,
        stages: st.stages,
      }),
    });
    toast('Antrean batch selesai ✓', 'ok');
  } catch (e) {
    toast(errMsg(e), 'err');
  } finally {
    queueAbort = null;
    showAutoBar(false);
    $('#queueRunBtn').classList.remove('hidden');
    $('#queueStopBtn').classList.add('hidden');
    renderQueueList();
  }
});

$('#queueStopBtn').addEventListener('click', () => {
  queueAbort?.abort();
  flowStop = true;
  renderAbort?.abort();
});

// ---------------------------------------------------------------- settings & reset

function updateStatusLine() {
  const ready = llm.providers(settings).filter((p) => p.ready);
  $('#statusLine').textContent = ready.length
    ? `AI: ${ready.map((p) => p.name).join(' + ')}${settings.fallback && ready.length > 1 ? ' · cadangan aktif' : ''}`
    : '⚠︎ Isi API key di ⚙︎ Pengaturan';
}

function applySettings(next) {
  settings = next;
  llm.resetBlockedModels();
  voiceCache.clear();
  updateStatusLine();
  renderTtsEngines(true);
  renderVisualStyles();
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) llm.loadSettings().then(applySettings);
});

$('#newProjectBtn').addEventListener('click', async () => {
  if (!confirm('Mulai proyek baru? Judul, naskah, audio, scene & gambar saat ini akan dihapus.')) return;
  await resetProject();
});

async function resetProject() {
  clearImgCache();
  clearPreviewCache();
  const keep = {
    preset: S.preset, lang: S.lang, visualStyle: S.visualStyle, ratio: S.ratio, minutes: S.minutes, sceneSec: S.sceneSec,
    ttsEngine: S.ttsEngine, ttsVoices: S.ttsVoices, res: S.res, fps: S.fps, subtitles: S.subtitles,
    hook: { ...DEFAULT_STATE.hook, on: S.hook?.on !== false },
    callouts: { ...DEFAULT_STATE.callouts, on: S.callouts?.on !== false },
  };
  S = { ...structuredClone(DEFAULT_STATE), ...keep };
  audioRaw = audioTrim = null;
  pauseMemo = null;
  await Promise.all([saveStateClean(S), kvDel('audioRaw'), kvDel('audioTrim'), mediaClearProject()]);
  initUI();
  go(1);
}

// ---------------------------------------------------------------- AI agent (MCP)

async function downloadBlob(blob, filename, { conflictAction = 'uniquify' } = {}) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: `Klipin/${filename}`, conflictAction, saveAs: false });
    for (let i = 0; i < 600; i++) {
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

const agentTools = createAgentTools(pipelineCtx());

const AGENT_STATES = {
  off: ['Mati', ''],
  offline: ['Menunggu AI agent…', 'Belum ada AI agent yang terhubung. Pasang Klipin MCP di Claude/Cursor (lihat langkah di bawah).'],
  online: ['Terhubung ✓', 'AI agent terhubung. Minta agent-mu, mis. "buatkan Shorts Klipin tentang budidaya lele".'],
  standby: ['Dipakai jendela lain', 'AI agent sedang terhubung ke panel Klipin lain (tab/jendela lain).'],
  working: ['Bekerja…', 'AI agent sedang menjalankan Klipin.'],
};

const agentBridge = startAgentBridge(agentTools, (state, info) => {
  const btn = $('#agentBtn');
  btn.dataset.state = state;
  const [toolName, progText] = String(info || '').split('|');
  const shortTool = toolName.replace(/^klipin_/, '');
  btn.title = `AI agent: ${AGENT_STATES[state][0]}`;
  $('#agentState').textContent = AGENT_STATES[state][0] + (state === 'working' && shortTool ? ` (${shortTool})` : '');
  $('#agentState').className = `pill ${state === 'online' || state === 'working' ? 'ok' : ''}`;
  $('#agentHint').textContent = AGENT_STATES[state][1];
  if (state === 'working') {
    showAutoBar(true, {
      title: `🤖 AI Agent: ${shortTool || 'bekerja'}`,
      sub: progText || 'Menjalankan tugas…',
      pct: null,
    });
  } else if (!autoAbort && !queueAbort) {
    showAutoBar(false);
  }
});

// ---------------------------------------------------------------- update

async function showUpdate(force = false) {
  const bar = $('#updateBar');
  let u;
  try {
    const self = await chrome.management?.getSelf?.().catch(() => null);
    if (self && self.installType !== 'development') return;
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
  renderPresets();
  $('#rawTitle').value = S.rawTitle;
  renderIdeaCats();
  renderTitleOptions();

  fillSelect($('#format'), FORMATS.map((f) => [f.id, f.label]), S.format);
  fillSelect($('#narrStyle'), NARRATION_STYLES.map((n) => [n.id, n.label]), S.narrStyle);
  fillSelect($('#minutes'), DURATIONS.map((m) => [m, `± ${m} menit`]), S.minutes);
  fillSelect($('#queuePreset'), VIDEO_PRESETS.map((p) => [p.id, p.label]), S.preset || 'shorts');
  showLoop();
  $('#formatHint').textContent = fmtStyle().hint;
  $('#script').value = S.script;
  updateScriptMeta();
  refreshStyleInstr();
  renderTtsEngines(true);
  showAudio();

  renderVisualStyles();
  renderCreativeReason();
  $('#sceneSec').value = String(S.sceneSec);
  $('#maxPause').value = String(S.maxPause);
  showTrim();
  $('#subtitles').checked = S.subtitles;
  S.hook = { ...DEFAULT_STATE.hook, ...S.hook };
  $('#hookOn').checked = S.hook.on;
  $('#hookText').value = S.hook.text;
  $('#hookBox').classList.toggle('hidden', !S.hook.on);
  S.callouts = { ...DEFAULT_STATE.callouts, ...S.callouts };
  $('#calloutOn').checked = S.callouts.on;
  $('#calloutText').value = calloutLines(S.callouts.list);
  $('#calloutBox').classList.toggle('hidden', !S.callouts.on);
  segSyncs.forEach((f) => f());
}

async function init() {
  chrome.tabs.getCurrent?.().then((t) => t && chrome.tabs.update(t.id, { autoDiscardable: false })).catch(() => {});
  settings = await llm.loadSettings();
  const saved = await loadStateHydrated().catch(() => null);
  if (saved) {
    S = { ...structuredClone(DEFAULT_STATE), ...saved };
    S.ttsVoices = { ...DEFAULT_STATE.ttsVoices, ...saved.ttsVoices };
    if (saved.voice && !saved.ttsVoices) S.ttsVoices.gemini = saved.voice;
    if (S.step > 5) S.step = 5;
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
  segSyncs.push(setupSeg($('#ratioSeg'), () => S.ratio, (v) => { S.ratio = v; S.preset = ''; renderPresets(); renderStoryboard(); }));
  thumbSegs = [
    setupSeg($('#thumbPosSeg'), () => ensureYt().thumb.pos, (v) => { ensureYt().thumb.pos = v; drawThumb($('#thumbCanvas'), S, ensureYt().thumb); }),
    setupSeg($('#thumbColorSeg'), () => ensureYt().thumb.color, (v) => { ensureYt().thumb.color = v; drawThumb($('#thumbCanvas'), S, ensureYt().thumb); }),
  ];

  $$('#stepper button').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.step))));
  $$('[data-next]').forEach((b) => b.addEventListener('click', () => go(S.step + 1)));
  $$('[data-prev]').forEach((b) => b.addEventListener('click', () => go(S.step - 1)));

  initUI();
  renderCreativeReason();
  updateStatusLine();
  loadStylePreviews();
  go(S.step || 1);
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
