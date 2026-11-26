#!/usr/bin/env node
// Klipin MCP server — menghubungkan AI agent apa pun (Claude, ChatGPT/Codex, Gemini, Cursor, LM Studio, …) dengan
// extension Klipin di Chrome. Tanpa dependensi: cukup Node.js 18+.
//
//   AI agent ──stdio atau HTTP /mcp──▶ server ini ──http://127.0.0.1:47816──▶ panel Klipin di Chrome
//
// Panel Klipin mengambil tugas lewat long-poll dan mengirim hasilnya kembali. Endpoint panel hanya
// menerima permintaan dari extension (header khusus + Origin extension + Host localhost), jadi situs
// web lain tidak bisa memakainya. Kalau beberapa agent menjalankan server ini sekaligus, yang
// pertama memegang port dan sisanya meneruskan panggilan ke sana.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.KLIPIN_PORT) || 47816;
const VERSION = '1.11.2';
const CALL_WAIT_MS = Number(process.env.KLIPIN_CALL_WAIT_MS) || 50000; // batas tunggu satu panggilan tool (agent punya timeout sendiri)
const PANEL_ALIVE_MS = 8000;

const log = (...a) => process.stderr.write(`[klipin-mcp] ${a.join(' ')}\n`);

// Rahasia bersama antar-instance server (bukan untuk extension).
const SECRET_DIR = path.join(os.homedir(), '.klipin');
const SECRET_FILE = path.join(SECRET_DIR, 'secret');
function secret() {
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  fs.mkdirSync(SECRET_DIR, { recursive: true });
  const s = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

// ---------------------------------------------------------------- daftar tool

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const obj = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

export const TOOLS = [
  {
    name: 'klipin_status',
    description: 'Show the current Klipin project: title, script, audio, scenes/prompts/images, YouTube pack, Flow tab connection and which AI providers are configured. Call this first.',
    inputSchema: obj(),
  },
  {
    name: 'klipin_options',
    description: 'List valid ids for content formats, narration styles, visual styles, aspect ratios, durations and TTS voices.',
    inputSchema: obj(),
  },
  {
    name: 'klipin_new_project',
    description: 'Start a new empty project (clears title, script, audio, scenes and images; keeps language/style preferences).',
    inputSchema: obj({ idea: str('Optional raw idea/title for the new video'), lang: str('Language of the video', { enum: ['id', 'en'] }) }),
  },
  {
    name: 'klipin_titles',
    description: 'Generate 5 catchy YouTube title options from a raw idea and select the first one.',
    inputSchema: obj({ idea: str('Raw idea or rough title. Defaults to the project idea.'), lang: str('Language', { enum: ['id', 'en'] }) }),
  },
  {
    name: 'klipin_set_title',
    description: 'Set the final video title.',
    inputSchema: obj({ title: str('Final title') }, ['title']),
  },
  {
    name: 'klipin_write_script',
    description: 'Write the voice-over script with AI from the title (or set your own script with `script`). Returns the script.',
    inputSchema: obj({
      format: str('Content format id (see klipin_options)'),
      narration_style: str('Narration style id (see klipin_options)'),
      minutes: num('Target length in minutes (1, 2, 3, 5, 8, 10, 15)'),
      lang: str('Language', { enum: ['id', 'en'] }),
      loop: { type: 'boolean', description: 'Shorts only (minutes < 2): write the last sentence so it connects back to the first, for a seamless replay loop. Replaces the closing comment question. Default: keep the project setting (off).' },
      script: str('Use this exact script instead of generating one'),
    }),
  },
  {
    name: 'klipin_voice',
    description: 'Generate the voice-over directly via a TTS API (Gemini / OpenAI / ElevenLabs key needed in Klipin settings). Alternative: call klipin_aistudio_voice for free automation via Google AI Studio, or klipin_load_audio from a file.',
    inputSchema: obj({ engine: str('TTS engine id, e.g. "gemini"'), voice: str('Voice name/id, e.g. "Charon" (see klipin_options)') }),
  },
  {
    name: 'klipin_aistudio_voice',
    description: 'Generate the voice-over automatically for free using Google AI Studio (aistudio.google.com/generate-speech) in Chrome. Long-running: may return a job_id — then call klipin_wait.',
    inputSchema: obj({ voice: str('Voice name, e.g. "Charon", "Kore", "Puck" (see klipin_options)') }),
  },
  {
    name: 'klipin_load_audio',
    description: 'Load a voice-over audio file (wav/mp3/m4a/…) from this computer into the project, e.g. a file downloaded from Google AI Studio. Pass a folder (e.g. "~/Downloads") to load the newest audio file in it (downloaded in the last 30 minutes).',
    inputSchema: obj({ path: str('Absolute path to the audio file, or a folder to take its newest audio file (~ allowed)') }, ['path']),
  },
  {
    name: 'klipin_scenes',
    description: 'Trim silences, split the narration into timed scenes synced to the audio, and write an image prompt per scene. Replaces existing scenes.',
    inputSchema: obj({
      visual_style: str('Visual style id (see klipin_options)'),
      ratio: str('Aspect ratio', { enum: ['16:9', '9:16', '1:1'] }),
      scene_seconds: num('Approximate seconds per scene (3–12; 4–5 keeps viewers watching)'),
      source: str('"script" (default) or "transcript" (transcribe the audio when it differs from the script)', { enum: ['script', 'transcript'] }),
    }),
  },
  {
    name: 'klipin_edit_scene',
    description: 'Change the image prompt of one scene (then call klipin_images with that scene to regenerate it).',
    inputSchema: obj({ scene: num('Scene number (1-based)'), prompt: str('New image prompt (English)') }, ['scene', 'prompt']),
  },
  {
    name: 'klipin_images',
    description: 'Generate scene images in Google Flow (auto-creates a new Flow project if needed when Chrome is logged in). Long-running: returns a job_id if not finished — then call klipin_wait.',
    inputSchema: obj({
      scenes: { type: 'array', items: { type: 'number' }, description: 'Only these scene numbers (regenerates them)' },
      only_missing: { type: 'boolean', description: 'Only scenes without an image (default true when `scenes` is not given)' },
    }),
  },
  {
    name: 'klipin_render',
    description: 'Render the final MP4 (images + voice-over + subtitles) and save it to the Downloads/Klipin folder. Long-running: may return a job_id — then call klipin_wait.',
    inputSchema: obj({
      resolution: num('720 or 1080 (default)'),
      fps: num('24 or 30 (default)'),
      subtitles: { type: 'boolean', description: 'Burn subtitles into the video (default true)' },
      hook_text: str('Big text shown in the first 2 seconds (the frame people see while scrolling): the core number/contrast of the opening line, 2–5 words or "A | B". Omit = the AI suggests it from the script; "off" = no hook text'),
      callouts: { type: 'boolean', description: 'Show key numbers on screen as note cards while the narrator says them (default true; picked by the AI from the scene narration)' },
    }),
  },
  {
    name: 'klipin_youtube',
    description: 'Create the YouTube upload pack: 5 titles, description with auto chapters/timestamps and hashtags, tags, thumbnail text ideas and a thumbnail background prompt.',
    inputSchema: obj(),
  },
  {
    name: 'klipin_thumb_concepts',
    description: 'Ask the AI for thumbnail concepts that fit the project (story format, narration style, visual style): one concept per thumbnail type, each with an idea, a 2–4 word text and a Flow image prompt following the user\'s thumbnail rules. Types: kontras (split: two opposite results, text "A | B"), reaksi (shocked character), angka (big number), misteri (hidden object), momen (climax moment), tokoh (portrait), daftar (hidden number one). Omit types to use the ones recommended for the format (see klipin_options).',
    inputSchema: obj({ types: { type: 'array', items: { type: 'string' }, description: '1–4 thumbnail type ids' } }),
  },
  {
    name: 'klipin_thumbnail',
    description: 'Compose a YouTube thumbnail sized to the project ratio (16:9 → 1280x720, 9:16 → 1080x1920, 1:1 → 1080x1080) (background image + big text), save it as JPG to Downloads/Klipin and return a preview.',
    inputSchema: obj({
      concept: { type: 'integer', description: 'Use concept N from klipin_thumb_concepts (its text, layout, color and image; generates the image in Google Flow if it has none — 1 Flow credit)' },
      text: str('2–4 word thumbnail text (default: first suggestion from klipin_youtube); for the split layout write "A | B"'),
      background: str('"scene:N" to use scene N\'s image, "flow" to generate a new background in Google Flow, or omit to keep the current one'),
      position: str('Text position ("split" = two sides, text "A | B")', { enum: ['left', 'right', 'bottom', 'split'] }),
      color: str('Text accent color', { enum: ['yellow', 'white', 'red'] }),
    }),
  },
  {
    name: 'klipin_youtube_attach',
    description: 'Put the last rendered MP4 (kind "video") or thumbnail (kind "image") into the file input of the YouTube Studio tab (studio.youtube.com) — no file size limit. Open the upload dialog (Create → Upload videos) or the thumbnail section first. Klipin does not fill in or publish anything.',
    inputSchema: obj({ kind: str('"video" (default) or "image"', { enum: ['video', 'image'] }), file: str('Absolute path instead of the last Klipin output') }),
  },
  {
    name: 'klipin_run_pipeline',
    description: 'Run the complete end-to-end Klipin pipeline automatically (title -> script -> voice -> storyboard -> Flow images -> render MP4 -> publish pack & thumbnail) and save everything into Downloads/Klipin/<project>/. Long-running: returns a job_id — then call klipin_wait.',
    inputSchema: obj({
      topic: str('Raw topic or idea for the video (omit to resume the current project)'),
      preset: str('Project preset ("shorts" = 9:16 1 min, "youtube" = 16:9 5 min, "feed" = 1:1 1 min)', { enum: ['shorts', 'youtube', 'feed'] }),
      format: str('Content format id (see klipin_options)'),
      narration_style: str('Narration style id (see klipin_options)'),
      visual_style: str('Visual style id (see klipin_options)'),
      minutes: num('Target length in minutes'),
      lang: str('Language', { enum: ['id', 'en'] }),
      loop: { type: 'boolean', description: 'Shorts loop ending connecting back to the opening line' },
      voice_source: str('Voice generator: "auto" (API if configured else AI Studio), "api", or "aistudio"', { enum: ['auto', 'api', 'aistudio'] }),
      publish_pack: { type: 'boolean', description: 'Generate titles, description, thumbnail & metadata bundle (default true)' },
      auto_creative: { type: 'boolean', description: 'Automatically choose best format, narration style, visual style, loop & voice from the topic when omitted (default true)' },
    }),
  },
  {
    name: 'klipin_wait',
    description: 'Wait (up to ~50 s) for a long-running job (images, render, voice, pipeline) and report its progress/result.',
    inputSchema: obj({ job_id: str('job_id returned earlier') }, ['job_id']),
  },
];

const INSTRUCTIONS = `Klipin makes faceless YouTube videos and Shorts/Reels inside the user's Chrome (extension "Klipin").
Fastest full-auto flow: call klipin_run_pipeline (with topic + preset="shorts" or "youtube"), then keep calling klipin_wait until done.
Granular flow: klipin_status → klipin_titles (or klipin_set_title) → klipin_write_script → voice-over
(klipin_voice if a TTS API key is set, or klipin_aistudio_voice for free Google AI Studio automation, or klipin_load_audio)
→ klipin_scenes → klipin_images (auto-opens/creates a Google Flow project if needed) → klipin_render → klipin_youtube
→ klipin_thumb_concepts → klipin_thumbnail concept=N.
Long tasks return a job_id: keep calling klipin_wait until done. Answer the user in their language (often Indonesian).`;

// Tool yang boleh jalan bersamaan dengan tugas lain (hanya membaca).
const CONCURRENT = new Set(['klipin_status', 'klipin_options']);

// ---------------------------------------------------------------- antrean tugas (instance utama)

export const jobs = new Map();
const queue = [];
const held = new Set(); // long-poll panel yang sedang menunggu
const audioTokens = new Map(); // token → { file, name, exp }
let panel = { client: null, seen: 0 };

const panelAlive = () => held.size > 0 || Date.now() - panel.seen < PANEL_ALIVE_MS;
const runningJob = () => [...jobs.values()].find((j) => j.status === 'running' && !CONCURRENT.has(j.tool));

function newJob(tool, args) {
  const id = `k${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const job = { id, tool, args, status: 'queued', progress: '', result: null, created: Date.now(), waiters: [] };
  jobs.set(id, job);
  queue.push(job);
  dispatch();
  return job;
}

function nextJob() {
  const busy = !!runningJob();
  const k = queue.findIndex((j) => CONCURRENT.has(j.tool) || !busy);
  return k < 0 ? null : queue.splice(k, 1)[0];
}

function dispatch() {
  for (const p of [...held]) {
    const job = nextJob();
    if (!job) return;
    held.delete(p);
    clearTimeout(p.timer);
    job.status = 'running';
    job.started = Date.now();
    const payload = { job: { id: job.id, tool: job.tool, args: job.args } };
    if (job.tool === 'klipin_load_audio' && job.args?.base64) job.args = null; // jangan tahan base64 besar di memori
    send(p.res, 200, payload, p.origin);
  }
}

export function finish(job, result) {
  if (job.status === 'done') return;
  if (job.args?.token) audioTokens.delete(job.args.token);
  job.args = null;
  job.status = 'done';
  job.result = result;
  job.waiters.splice(0).forEach((w) => w());
  setTimeout(() => jobs.delete(job.id), 30 * 60000).unref();
  dispatch();
}

// tugas yang sedang jalan di panel yang sudah ditutup → gagal (jangan menggantung selamanya)
function startJobSweeper() {
  setInterval(() => {
    const now = Date.now();
    for (const [tok, info] of audioTokens) {
      if (info.exp < now) audioTokens.delete(tok);
    }
    if (panelAlive()) return;
    for (const j of jobs.values()) {
      if (j.status === 'running' && now - panel.seen > 30000) {
        finish(j, { ok: false, error: 'Panel Klipin ditutup sebelum tugas selesai. Buka lagi panel Klipin lalu ulangi.' });
      }
    }
  }, 5000).unref();
}

function waitJob(job, ms = CALL_WAIT_MS) {
  return new Promise((resolve) => {
    if (job.status === 'done') return resolve();
    const t = setTimeout(resolve, ms);
    job.waiters.push(() => { clearTimeout(t); resolve(); });
  });
}

function toContent(job) {
  if (job.status !== 'done') {
    const where = job.status === 'queued'
      ? runningJob() && !CONCURRENT.has(job.tool)
        ? 'Menunggu tugas lain selesai.'
        : panelAlive()
        ? 'Menunggu panel Klipin mengambil tugas…'
        : 'Panel Klipin belum terhubung. Minta pengguna membuka Chrome dan klik ikon Klipin (Klipin juga mencoba membukanya sendiri dalam ±30 detik).'
      : `Sedang berjalan${job.progress ? `: ${job.progress}` : '…'}`;
    return { content: [{ type: 'text', text: `⏳ ${where}\njob_id: ${job.id} — panggil klipin_wait dengan job_id ini untuk menunggu hasilnya.` }] };
  }
  const r = job.result || {};
  if (!r.ok) return { content: [{ type: 'text', text: `❌ ${r.error || 'Gagal.'}` }], isError: true };
  const content = [{ type: 'text', text: r.text || 'OK' }];
  if (r.image?.data) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType || 'image/jpeg' });
  return { content };
}

export const expandHome = (p) => {
  const s = String(p || '');
  return s === '~' || s.startsWith('~/') || s.startsWith('~\\') ? path.join(os.homedir(), s.slice(1)) : s;
};
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|flac|webm|opus)$/i;

// Folder → file audio terbaru di dalamnya (30 menit terakhir). Nama file download AI Studio berisi jam,
// jadi agent tidak bisa menebaknya. Dipanggil sebelum diteruskan ke server lain (yang mungkin versi lama).
export function resolveAudioPath(p) {
  const file = path.resolve(expandHome(p));
  try {
    if (!fs.statSync(file).isDirectory()) return file;
  } catch {
    return file;
  }
  let newest;
  try {
    newest = fs.readdirSync(file).filter((f) => AUDIO_EXT.test(f))
      .map((f) => {
        const full = path.join(file, f);
        try { return { f: full, t: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter((x) => x && Date.now() - x.t < 30 * 60 * 1000)
      .sort((a, b) => b.t - a.t)[0];
  } catch (e) {
    // macOS (TCC) sering menolak membaca ISI folder ~/Downloads untuk proses launchd (EPERM scandir), padahal
    // membaca file bernama pasti tetap boleh. Download AI Studio selalu bernama
    // "Generated Audio <Bulan> <tgl>, <tahun> - <jam>_<menit><AM|PM>.wav" (jam lokal saat diunduh), jadi tebak
    // nama per menit untuk 30 menit terakhir dan cek lewat stat saja.
    if (e?.code !== 'EPERM' && e?.code !== 'EACCES') throw e;
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const SUFFIXES = ['', ' (1)', ' (2)', ' (3)'];
    for (let m = 0; m <= 30 && !newest; m++) {
      const d = new Date(Date.now() - m * 60 * 1000);
      const h12 = d.getHours() % 12 || 12;
      const base = `Generated Audio ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} - ${h12}_${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'AM' : 'PM'}`;
      for (const suf of SUFFIXES) {
        const cand = path.join(file, `${base}${suf}.wav`);
        try { if (fs.statSync(cand).isFile()) { newest = { f: cand }; break; } } catch { /* belum ada */ }
      }
    }
    if (!newest) return path.join(file, '(folder tidak bisa dibaca macOS, EPERM, dan tidak ada file "Generated Audio" dalam 30 menit terakhir).wav');
  }
  return newest ? newest.f : path.join(file, '(tidak ada file audio baru dalam 30 menit terakhir).wav');
}

// forwarded = dari server Klipin lain (bisa versi lebih baru dengan tool yang belum dikenal di sini)
export async function runTool(name, args = {}, forwarded = false) {
  if (!TOOLS.some((t) => t.name === name) && !(forwarded && /^klipin_\w+$/.test(name))) return { content: [{ type: 'text', text: `Tool tidak dikenal: ${name}` }], isError: true };
  if (name === 'klipin_wait') {
    const job = jobs.get(String(args.job_id || ''));
    if (!job) return { content: [{ type: 'text', text: 'job_id tidak ditemukan (mungkin sudah kedaluwarsa). Cek klipin_status.' }], isError: true };
    await waitJob(job);
    return toContent(job);
  }
  if (name === 'klipin_load_audio') {
    const file = resolveAudioPath(args.path);
    if (!AUDIO_EXT.test(file)) return { content: [{ type: 'text', text: 'File harus audio (wav, mp3, m4a, ogg, flac, webm).' }], isError: true };
    let st;
    try { st = fs.statSync(file); } catch { return { content: [{ type: 'text', text: `File tidak ditemukan: ${file}` }], isError: true }; }
    if (st.size > 150 * 1024 * 1024) return { content: [{ type: 'text', text: 'File audio terlalu besar (maks 150 MB).' }], isError: true };
    const token = crypto.randomBytes(16).toString('hex');
    audioTokens.set(token, { file, name: path.basename(file), exp: Date.now() + 10 * 60 * 1000 });
    args = { name: path.basename(file), token };
  }
  const job = newJob(name, args);
  await waitJob(job);
  return toContent(job);
}

// ---------------------------------------------------------------- HTTP (panel + instance lain)

function send(res, code, body, origin) {
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (origin) Object.assign(h, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  res.writeHead(code, h);
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body terlalu besar')); req.destroy(); } else parts.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function allowedExtOrigin(origin) {
  if (!origin) return '';
  if (process.env.KLIPIN_DEV_ORIGIN && origin === process.env.KLIPIN_DEV_ORIGIN) return origin;
  if (process.env.KLIPIN_EXT_ID) {
    return origin === `chrome-extension://${process.env.KLIPIN_EXT_ID}` ? origin : '';
  }
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : '';
}

export const mcpToken = (sharedSecret) => crypto.createHmac('sha256', String(sharedSecret)).update('klipin-mcp-http').digest('hex').slice(0, 40);

export function makeServer(sharedSecret, port = PORT) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const origin = req.headers.origin || '';
    const extOrigin = allowedExtOrigin(origin);
    // Tolak DNS rebinding: Host harus localhost.
    const hostOk = port === 0
      ? /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '')
      : new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`).test(req.headers.host || '');
    if (!hostOk) return send(res, 403, { error: 'host' });

    if (req.method === 'OPTIONS') {
      if (!extOrigin) return send(res, 403, { error: 'origin' });
      res.writeHead(204, {
        'Access-Control-Allow-Origin': extOrigin, 'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'content-type, x-klipin-client', 'Access-Control-Max-Age': '600', Vary: 'Origin',
      });
      return res.end();
    }

    // panggilan dari instance server lain (agent kedua)
    if (url.pathname === '/call' || url.pathname === '/hello') {
      if (req.headers['x-klipin-secret'] !== sharedSecret) return send(res, 403, { error: 'secret' });
      if (url.pathname === '/hello') return send(res, 200, { klipin: VERSION });
      try {
        const { name, args } = await readBody(req, 200 * 1024 * 1024);
        return send(res, 200, await runTool(name, args, true));
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // MCP lewat HTTP (Streamable HTTP) untuk klien non-stdio: ChatGPT/OpenAI Agents, Gemini, LM Studio, n8n, dll.
    // Wajib header Authorization: Bearer <token> (lihat `node server.mjs --token`) dan tanpa Origin browser.
    if (url.pathname === '/mcp') {
      if (origin) return send(res, 403, { error: 'origin' });
      const auth = String(req.headers.authorization || '');
      const want = `Bearer ${mcpToken(sharedSecret)}`;
      const a = Buffer.from(auth); const b = Buffer.from(want);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'butuh Authorization: Bearer <token>' });
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, DELETE' }); return res.end(); }
      let body;
      try { body = await readBody(req, 20 * 1024 * 1024); } catch (e) { return send(res, 400, { error: e.message }); }
      const msgs = Array.isArray(body) ? body : [body];
      const replies = (await Promise.all(msgs.map((m) => rpc(m)))).filter(Boolean);
      if (!replies.length) { res.writeHead(202); return res.end(); }
      return send(res, 200, Array.isArray(body) ? replies : replies[0]);
    }

    // endpoint status untuk background service worker (boleh tanpa Origin)
    const client = req.headers['x-klipin-client'];
    if (!client) return send(res, 403, { error: 'forbidden' });

    if (url.pathname === '/state' && req.method === 'GET') {
      if (origin && !extOrigin) return send(res, 403, { error: 'origin' });
      return send(res, 200, { pending: queue.length, alive: panelAlive(), version: VERSION }, extOrigin);
    }

    // endpoint panel & audio: header klien khusus wajib (situs web tidak bisa mengirimnya lintas origin tanpa preflight).
    // Chrome TIDAK menyertakan Origin pada GET dari halaman extension ke host yang diizinkan, jadi tanpa Origin boleh;
    // kalau ada Origin, harus origin extension yang sah.
    if (origin && !extOrigin) return send(res, 403, { error: 'origin' });

    if (url.pathname.startsWith('/audio/') && req.method === 'GET') {
      const tok = url.pathname.slice('/audio/'.length);
      const entry = audioTokens.get(tok);
      if (!entry || entry.exp < Date.now()) {
        audioTokens.delete(tok);
        return send(res, 404, { error: 'audio token invalid or expired' }, extOrigin);
      }
      audioTokens.delete(tok);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': extOrigin,
        Vary: 'Origin',
      });
      fs.createReadStream(entry.file).on('error', () => res.destroy()).pipe(res);
      return;
    }

    if (url.pathname === '/poll' && req.method === 'GET') {
      if (panel.client && panel.client !== client && panelAlive()) return send(res, 200, { standby: true }, extOrigin);
      panel = { client, seen: Date.now() };
      const job = nextJob();
      if (job) {
        job.status = 'running';
        job.started = Date.now();
        return send(res, 200, { job: { id: job.id, tool: job.tool, args: job.args } }, extOrigin);
      }
      const p = { res, origin: extOrigin };
      p.timer = setTimeout(() => { held.delete(p); panel.seen = Date.now(); send(res, 200, {}, extOrigin); }, 20000);
      req.on('close', () => { if (held.delete(p)) { clearTimeout(p.timer); panel.seen = Date.now(); } });
      held.add(p);
      return;
    }
    if ((url.pathname === '/progress' || url.pathname === '/result') && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }, extOrigin); }
      panel.seen = Date.now();
      const job = jobs.get(body.id);
      if (job && url.pathname === '/progress') job.progress = String(body.text || '').slice(0, 300);
      if (job && url.pathname === '/result') finish(job, body);
      return send(res, 200, { ok: true }, extOrigin);
    }
    send(res, 404, { error: 'not found' }, extOrigin);
  });
}

// ---------------------------------------------------------------- peran: utama (pegang port) / penerus

let primary = false;
let starting = null;

function becomePrimary(sharedSecret) {
  return new Promise((resolve) => {
    const srv = makeServer(sharedSecret);
    srv.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? false : (log('server error', e.message), false)));
    srv.listen(PORT, '127.0.0.1', () => { log(`menunggu panel Klipin di http://127.0.0.1:${PORT}`); resolve(true); });
  });
}

async function forward(sharedSecret, name, args) {
  const res = await fetch(`http://127.0.0.1:${PORT}/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-klipin-secret': sharedSecret },
    body: JSON.stringify({ name, args }),
  });
  if (!res.ok) throw new Error(`server Klipin lain menolak (${res.status})`);
  return res.json();
}

let SECRET = null;
async function callTool(name, args) {
  SECRET ||= secret();
  if (name === 'klipin_load_audio') args = { ...args, path: resolveAudioPath(args?.path) };
  if (!primary) {
    starting ||= becomePrimary(SECRET).then((ok) => { primary = ok; starting = null; });
    await starting;
  }
  if (primary) return runTool(name, args);
  try {
    return await forward(SECRET, name, args);
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Port ${PORT} dipakai program lain dan bukan server Klipin (${e.message}). Tutup program itu atau set KLIPIN_PORT.` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------- MCP (JSON-RPC lewat stdio)

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

// Pelonggar argumen: model kecil sering mengirim angka/boolean/array sebagai string.
export function coerceArgs(name, args) {
  const props = TOOLS.find((t) => t.name === name)?.inputSchema?.properties;
  if (!props || !args || typeof args !== 'object') return args || {};
  const out = { ...args };
  for (const [k, sch] of Object.entries(props)) {
    let v = out[k];
    if (v === undefined || v === null) { delete out[k]; continue; }
    if (sch.type === 'number' && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
    else if (sch.type === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v.trim())) v = v.trim().toLowerCase() === 'true';
    else if (sch.type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) v = String(v);
    else if (sch.type === 'array' && typeof v === 'string') {
      try { const j = JSON.parse(v); v = Array.isArray(j) ? j : [j]; } catch { v = v.split(',').map((x) => x.trim()).filter(Boolean); }
      if (sch.items?.type === 'number') v = v.map((x) => (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x)) ? Number(x) : x));
    }
    out[k] = v;
  }
  return out;
}

// Satu pesan JSON-RPC → balasan (atau undefined untuk notifikasi). Dipakai stdio dan HTTP.
export async function rpc(msg) {
  const { id, method, params } = msg || {};
  const ok = (result) => (id !== undefined ? { jsonrpc: '2.0', id, result } : undefined);
  const bad = (code, message) => (id !== undefined ? { jsonrpc: '2.0', id, error: { code, message } } : undefined);
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'klipin', title: 'Klipin', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call':
        return ok(await callTool(params?.name, coerceArgs(params?.name, params?.arguments || {})));
      case 'resources/list': return ok({ resources: [] });
      case 'prompts/list': return ok({ prompts: [] });
      default:
        if (method?.startsWith('notifications/')) return undefined;
        return bad(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log('error', e.stack || e.message);
    return bad(-32603, e.message);
  }
}

async function handle(msg) {
  const r = await rpc(msg);
  if (r) write(r);
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const HTTP_ONLY = process.argv.includes('--http');
if (isEntrypoint && process.argv.includes('--token')) {
  console.log(mcpToken(secret()));
  process.exit(0);
}
if (isEntrypoint) {
  SECRET = secret();
  startJobSweeper();
  let buf = '';
  if (HTTP_ONLY) process.stdin.pause();
  process.stdin.setEncoding('utf8');
  if (!HTTP_ONLY) process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log('JSON tidak valid dari klien'); continue; }
      handle(msg);
    }
  });
  if (!HTTP_ONLY) process.stdin.on('end', () => process.exit(0));

  // Pegang port sejak awal supaya panel bisa langsung terhubung.
  starting = becomePrimary(SECRET).then((ok) => { primary = ok; starting = null; if (!ok) log('port sudah dipakai — meneruskan ke server Klipin yang sudah jalan'); else if (HTTP_ONLY) log(`MCP HTTP: http://127.0.0.1:${PORT}/mcp  (header Authorization: Bearer ${mcpToken(SECRET)})`); });
}
