// Render MP4 di browser: WebCodecs (H.264 + AAC/Opus) + mp4-muxer.
// Tidak real-time — frame di-encode secepat GPU/CPU mampu.

import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from '../lib/mp4-muxer.mjs';
import { resample, findPauses } from './audio.js';
import { subtitleCues } from './scenes.js';

const AUDIO_RATE = 48000;
const FADE = 0.4; // detik crossfade antar scene

export function outputSize(ratio, res) {
  const short = res === 720 ? 720 : 1080;
  const even = (n) => Math.round(n / 2) * 2;
  if (ratio === '9:16') return { w: short, h: even((short * 16) / 9) };
  if (ratio === '1:1') return { w: short, h: short };
  return { w: even((short * 16) / 9), h: short };
}

// Error yang ditampilkan ke pengguna: pesan jelas + saran, detail teknis terpisah.
export class RenderError extends Error {
  constructor(message, { hint = '', detail = '', stalled = false } = {}) {
    super(message);
    this.name = 'RenderError';
    this.hint = hint;
    this.detail = detail;
    this.stalled = stalled;
  }
}

const withTimeout = (promise, ms, onTimeout) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(onTimeout()), ms)),
]);

async function pickVideoConfig(w, h, fps, hardwareAcceleration = 'no-preference') {
  if (typeof VideoEncoder === 'undefined') {
    throw new RenderError('Browser ini tidak bisa membuat video (WebCodecs tidak tersedia).', { hint: 'Pakai Google Chrome versi terbaru di komputer (bukan HP).' });
  }
  const bitrate = w * h >= 1920 * 1080 ? 8_000_000 : 4_000_000;
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033']) {
    const cfg = { codec, width: w, height: h, bitrate, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality', hardwareAcceleration };
    try {
      const ok = await withTimeout(VideoEncoder.isConfigSupported(cfg), 10000, () => new Error('timeout'));
      if (ok.supported) return cfg;
    } catch {}
  }
  throw new RenderError('Komputer ini tidak bisa meng-encode video H.264.', {
    hint: 'Update Chrome dan driver kartu grafis, atau coba resolusi 720p.',
  });
}

async function pickAudioConfig() {
  const candidates = [
    { mux: 'aac', cfg: { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 1, bitrate: 128_000 } },
    { mux: 'aac', cfg: { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 160_000 } },
    { mux: 'opus', cfg: { codec: 'opus', sampleRate: AUDIO_RATE, numberOfChannels: 1, bitrate: 128_000 } },
  ];
  for (const c of candidates) {
    try {
      if ((await AudioEncoder.isConfigSupported(c.cfg)).supported) return c;
    } catch {}
  }
  throw new Error('Browser ini tidak mendukung encode audio AAC/Opus.');
}

async function loadBitmap(src, label) {
  try {
    return await withTimeout((async () => createImageBitmap(await (await fetch(src)).blob()))(), 20000, () => new Error('timeout'));
  } catch (e) {
    throw new RenderError(`Gambar ${label} rusak atau tidak bisa dibaca.`, {
      hint: `Buka langkah 4, lalu buat ulang (↻) atau upload ulang gambar ${label}.`, detail: e.message,
    });
  }
}

function drawCover(ctx, img, w, h, zoom, panX, panY, alpha) {
  const scale = Math.max(w / img.width, h / img.height) * zoom;
  const dw = img.width * scale, dh = img.height * scale;
  const maxX = (dw - w) / 2, maxY = (dh - h) / 2;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, (w - dw) / 2 + panX * maxX, (h - dh) / 2 + panY * maxY, dw, dh);
  ctx.globalAlpha = 1;
}

// Gerakan kamera pelan (Ken Burns) — variasi berbeda tiap scene.
function kenBurns(i, p) {
  const e = p * p * (3 - 2 * p) * 0.6 + p * 0.4; // ease halus, tetap bergerak
  switch (i % 4) {
    case 0: return { zoom: 1.0 + 0.12 * e, panX: 0, panY: 0 };
    case 1: return { zoom: 1.12 - 0.12 * e, panX: 0, panY: 0 };
    case 2: return { zoom: 1.1, panX: -0.8 + 1.6 * e, panY: 0 };
    default: return { zoom: 1.04 + 0.08 * e, panX: 0, panY: 0.6 - 1.2 * e };
  }
}

function wrapLines(ctx, text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawSubtitle(ctx, text, w, h) {
  const vertical = h > w;
  const size = Math.round(vertical ? w * 0.062 : h * 0.052);
  ctx.font = `800 ${size}px "Inter", "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lines = wrapLines(ctx, text, w * 0.84);
  const lh = size * 1.25;
  const baseY = vertical ? h * 0.72 : h * 0.86;
  const y0 = baseY - ((lines.length - 1) * lh) / 2;
  lines.forEach((ln, k) => {
    const y = y0 + k * lh;
    ctx.lineWidth = size * 0.2;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(ln, w / 2, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(ln, w / 2, y);
  });
}

/**
 * @param {object} o
 * @param {Array} o.scenes   scene dengan .image (dataURL) dan .start/.end (detik)
 * @param {object|null} o.audio  { samples, sampleRate }
 * @param {FileSystemFileHandle|null} o.fileHandle  tujuan simpan (null → kembalikan Blob)
 */
const STALL_MS = 20000; // encoder tidak mengeluarkan apa pun selama ini → dianggap macet

export async function renderMp4({ scenes, audio, pauses, ratio, res, fps, subtitles, fileHandle, onProgress, signal }) {
  const { w, h } = outputSize(ratio, res);
  const usable = scenes.filter((s) => s.image);
  if (!usable.length) throw new RenderError('Belum ada gambar scene.', { hint: 'Buat gambar dulu di langkah 4.' });
  const total = audio ? audio.samples.length / audio.sampleRate : scenes[scenes.length - 1].end;

  // Scene tanpa gambar memakai gambar scene sebelumnya/berikutnya terdekat.
  const bitmaps = new Map();
  try {
    for (let k = 0; k < usable.length; k++) {
      if (signal?.aborted) throw new DOMException('Render dibatalkan', 'AbortError');
      onProgress?.({ phase: `Memuat gambar ${k + 1}/${usable.length}…`, pct: 0 });
      bitmaps.set(usable[k].i, await loadBitmap(usable[k].image, `scene ${usable[k].i}`));
    }
    const nearestWithImage = (idx) => {
      for (let d = 0; d < scenes.length; d++) {
        if (scenes[idx - d]?.image) return scenes[idx - d];
        if (scenes[idx + d]?.image) return scenes[idx + d];
      }
    };
    const timeline = scenes.map((s, idx) => ({ start: s.start, end: s.end, bmp: bitmaps.get(nearestWithImage(idx).i), k: idx }));
    const cues = subtitles ? subtitleCues(scenes, pauses || (audio ? findPauses(audio) : [])) : [];
    onProgress?.({ phase: 'Menyiapkan audio…', pct: 0 });
    const acfg = audio ? await pickAudioConfig() : null;
    const pcm = acfg ? (await resample(audio, AUDIO_RATE)).samples : null;
    const job = { w, h, fps, total, timeline, cues, acfg, pcm, fileHandle, onProgress, signal };

    // Encoder hardware (GPU) lebih cepat, tapi di sebagian laptop Windows driver-nya macet/error.
    // Kalau begitu, ulangi otomatis dengan encoder software.
    try {
      return await encodeOnce(job, 'no-preference');
    } catch (e) {
      if (e.name === 'AbortError' || !(e.stalled || e.encoder)) throw e;
      console.warn('[Klipin] encoder hardware gagal, coba software', e);
      onProgress?.({ phase: 'Encoder GPU bermasalah, mencoba encoder software…', pct: 0 });
      try {
        return await encodeOnce(job, 'prefer-software');
      } catch (e2) {
        if (e2.name === 'AbortError') throw e2;
        throw new RenderError(
          e2.stalled ? 'Proses render macet: encoder video di komputer ini tidak merespons.' : 'Encoder video di komputer ini gagal.',
          { hint: 'Tutup tab/aplikasi berat lain, update Chrome dan driver kartu grafis, lalu coba resolusi 720p.', detail: `${e.detail || e.message} | ${e2.detail || e2.message}` },
        );
      }
    }
  } finally {
    bitmaps.forEach((b) => b.close());
  }
}

async function encodeOnce({ w, h, fps, total, timeline, cues, acfg, pcm, fileHandle, onProgress, signal }, hardwareAcceleration) {
  onProgress?.({ phase: 'Menyiapkan encoder video…', pct: 0 });
  const vcfg = await pickVideoConfig(w, h, fps, hardwareAcceleration);

  let writable = null;
  let target;
  if (fileHandle) {
    try {
      writable = await fileHandle.createWritable();
    } catch (e) {
      throw new RenderError('Tidak bisa menulis file video ke lokasi yang dipilih.', { hint: 'Pilih folder lain (misalnya Downloads) atau tutup file itu kalau sedang dibuka aplikasi lain.', detail: e.message });
    }
    target = new FileSystemWritableFileStreamTarget(writable);
  } else {
    target = new ArrayBufferTarget();
  }
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    ...(acfg ? { audio: { codec: acfg.mux, numberOfChannels: acfg.cfg.numberOfChannels, sampleRate: AUDIO_RATE } } : {}),
    fastStart: fileHandle ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let encErr = null;
  let lastOut = performance.now();
  const fail = (what) => (e) => {
    encErr ||= Object.assign(new RenderError(`Encoder ${what} error.`, { detail: e?.message || String(e) }), { encoder: true });
  };
  const venc = new VideoEncoder({ output: (c, m) => { lastOut = performance.now(); muxer.addVideoChunk(c, m); }, error: fail('video') });
  try {
    venc.configure(vcfg);
  } catch (e) {
    fail('video')(e);
    throw encErr;
  }

  let aenc = null, aPos = 0;
  if (acfg) {
    aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: fail('audio') });
    aenc.configure(acfg.cfg);
  }
  const AUDIO_BLOCK = 4800; // 0.1 s
  const feedAudioUntil = (sec) => {
    if (!aenc) return;
    const limit = Math.min(pcm.length, Math.ceil(sec * AUDIO_RATE));
    const ch = acfg.cfg.numberOfChannels;
    while (aPos < limit) {
      const n = Math.min(AUDIO_BLOCK, pcm.length - aPos);
      const data = new Float32Array(n * ch);
      const mono = pcm.subarray(aPos, aPos + n);
      for (let c = 0; c < ch; c++) data.set(mono, c * n);
      const ad = new AudioData({
        format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: ch,
        timestamp: Math.round((aPos / AUDIO_RATE) * 1e6), data,
      });
      aenc.encode(ad);
      ad.close();
      aPos += n;
    }
  };
  const stallErr = () => Object.assign(new RenderError('Encoder video tidak merespons.', {
    detail: `tidak ada output ${STALL_MS / 1000} detik (${hardwareAcceleration})`, stalled: true,
  }), { stalled: true });

  const canvas = new OffscreenCanvas(w, h);
  // Smoothing default (bilinear) sengaja dipakai: 'high' memotong kecepatan render ±50%.
  const ctx = canvas.getContext('2d', { alpha: false });
  const nFrames = Math.ceil(total * fps);
  const t0 = performance.now();
  lastOut = t0;
  let si = 0, ci = 0;

  try {
    for (let f = 0; f < nFrames; f++) {
      if (signal?.aborted) throw new DOMException('Render dibatalkan', 'AbortError');
      if (encErr) throw encErr;
      const t = f / fps;
      while (si < timeline.length - 1 && t >= timeline[si].end) si++;
      const sc = timeline[si];

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      const p = Math.min(1, Math.max(0, (t - sc.start) / Math.max(0.001, sc.end - sc.start)));
      const into = t - sc.start;
      if (si > 0 && into < FADE) {
        const prev = timeline[si - 1];
        const pp = Math.min(1, (t - prev.start) / Math.max(0.001, prev.end - prev.start));
        const kb0 = kenBurns(prev.k, pp);
        drawCover(ctx, prev.bmp, w, h, kb0.zoom, kb0.panX, kb0.panY, 1);
      }
      const kb = kenBurns(sc.k, p);
      drawCover(ctx, sc.bmp, w, h, kb.zoom, kb.panX, kb.panY, si > 0 && into < FADE ? into / FADE : 1);

      if (cues.length) {
        while (ci < cues.length - 1 && t >= cues[ci].end) ci++;
        if (t >= cues[ci].start && t < cues[ci].end) drawSubtitle(ctx, cues[ci].text, w, h);
      }

      feedAudioUntil(t + 1);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();

      while (venc.encodeQueueSize > 6 && !encErr) {
        if (signal?.aborted) throw new DOMException('Render dibatalkan', 'AbortError');
        if (performance.now() - lastOut > STALL_MS) throw stallErr();
        await new Promise((r) => {
          venc.addEventListener('dequeue', r, { once: true });
          setTimeout(r, 200);
        });
      }
      if (f % 15 === 0) {
        onProgress?.({ phase: 'Render', pct: f / nFrames, elapsed: (performance.now() - t0) / 1000 });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    feedAudioUntil(Infinity);
    onProgress?.({ phase: 'Menyelesaikan file…', pct: 1 });
    await withTimeout(venc.flush(), STALL_MS * 2, stallErr);
    if (aenc) await withTimeout(aenc.flush(), STALL_MS, stallErr);
    if (encErr) throw encErr;
    muxer.finalize();
    if (writable) await writable.close();
  } catch (e) {
    try { venc.close(); aenc?.close(); } catch {}
    if (writable) await writable.abort().catch(() => {});
    throw e;
  }

  const elapsed = (performance.now() - t0) / 1000;
  onProgress?.({ phase: 'Selesai', pct: 1, elapsed });
  return {
    elapsed,
    width: w,
    height: h,
    duration: total,
    encoder: hardwareAcceleration === 'prefer-software' ? 'software' : 'hardware',
    blob: fileHandle ? null : new Blob([target.buffer], { type: 'video/mp4' }),
  };
}
