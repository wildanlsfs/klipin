// Pengolahan audio voiceover: decode, potong jeda/diam, encode WAV, resample.
// Representasi internal: { samples: Float32Array (mono), sampleRate }.

export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const ab = await ctx.decodeAudioData(buf);
    return { samples: mixToMono(ab), sampleRate: ab.sampleRate };
  } finally {
    ctx.close();
  }
}

function mixToMono(ab) {
  if (ab.numberOfChannels === 1) return ab.getChannelData(0).slice();
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out;
}

export function duration(audio) {
  return audio.samples.length / audio.sampleRate;
}

// Level suara per jendela 10 ms + penanda diam (ambang adaptif dari puncak file).
function silenceMap({ samples, sampleRate }, thresholdDb = -42) {
  const win = Math.round(sampleRate * 0.01);
  const nWin = Math.ceil(samples.length / win);
  const db = new Float32Array(nWin);
  let peak = -100;
  for (let w = 0; w < nWin; w++) {
    let sum = 0;
    const s = w * win, e = Math.min(samples.length, s + win);
    for (let i = s; i < e; i++) sum += samples[i] * samples[i];
    db[w] = 10 * Math.log10(sum / Math.max(1, e - s) + 1e-12);
    if (db[w] > peak) peak = db[w];
  }
  const thr = Math.max(thresholdDb, peak - 38);
  return { win, nWin, silent: Array.from(db, (v) => v < thr) };
}

/**
 * Jeda bicara (diam ≥ minPause detik, bukan di ujung file) — dipakai untuk menyelaraskan
 * kalimat/subtitle dengan suara. Hasil: [{ start, end, t (tengah), dur }] urut waktu.
 */
const pauseCache = new WeakMap();
export function findPauses(audio, { minPause = 0.08 } = {}) {
  if (pauseCache.has(audio)) return pauseCache.get(audio);
  const { nWin, silent } = silenceMap(audio);
  const minWin = Math.round(minPause / 0.01);
  const out = [];
  let runStart = -1;
  for (let w = 0; w <= nWin; w++) {
    if (w < nWin && silent[w]) { if (runStart < 0) runStart = w; continue; }
    if (runStart > 0 && w < nWin && w - runStart >= minWin) {
      const start = runStart * 0.01, end = w * 0.01;
      out.push({ start, end, t: (start + end) / 2, dur: end - start });
    }
    runStart = -1;
  }
  pauseCache.set(audio, out);
  return out;
}

/**
 * Petakan jeda dari audio asli ke audio hasil potong jeda. Durasi jeda ASLI tetap dipakai
 * sebagai "kekuatan" jeda — setelah dipotong semua jeda panjang jadi sama pendek, sehingga
 * akhir kalimat tidak bisa lagi dibedakan dari koma kalau dideteksi dari audio hasil potong.
 */
export function mapPausesThroughCuts(pauses, cuts) {
  const removedBefore = (x) => {
    let r = 0;
    for (const [a, b] of cuts) {
      if (b <= x) r += b - a;
      else if (a < x) r += x - a;
      else break;
    }
    return r;
  };
  return pauses.map((p) => {
    const start = p.start - removedBefore(p.start);
    const end = p.end - removedBefore(p.end);
    return { start, end, t: (start + end) / 2, dur: p.dur };
  });
}

/**
 * Potong bagian diam yang lebih panjang dari `maxPause` detik menjadi `maxPause`.
 * Ambang diam dihitung adaptif dari level suara (dB) di file itu sendiri.
 */
export function trimSilence(audio, { maxPause = 0.35, thresholdDb = -42, edgeKeepSec = 0.15 } = {}) {
  const { samples, sampleRate } = audio;
  const { win, nWin, silent } = silenceMap(audio, thresholdDb);

  // Kumpulkan rentang diam (dalam jendela) yang lebih panjang dari maxPause.
  const keepWin = Math.round(maxPause / 0.01);
  const edgeKeep = Math.max(1, Math.round(edgeKeepSec / 0.01));
  const cuts = [];
  let runStart = -1;
  for (let w = 0; w <= nWin; w++) {
    if (w < nWin && silent[w]) { if (runStart < 0) runStart = w; continue; }
    if (runStart >= 0) {
      const len = w - runStart;
      if (runStart === 0) {
        if (len > edgeKeep) cuts.push([0, w - edgeKeep]);
      } else if (w === nWin) {
        if (len > edgeKeep) cuts.push([runStart + edgeKeep, nWin]);
      } else if (len > keepWin) {
        const half = Math.floor(keepWin / 2);
        cuts.push([runStart + half, w - (keepWin - half)]);
      }
      runStart = -1;
    }
  }
  if (!cuts.length) return { audio, removed: 0, cuts: [] };

  const fade = Math.round(sampleRate * 0.005);
  const pieces = [];
  let pos = 0;
  for (const [a, b] of cuts) {
    const sa = Math.min(samples.length, a * win), sb = Math.min(samples.length, b * win);
    if (sa > pos) pieces.push(samples.subarray(pos, sa));
    pos = sb;
  }
  if (pos < samples.length) pieces.push(samples.subarray(pos));

  const total = pieces.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of pieces) {
    out.set(p, off);
    // fade kecil di sambungan supaya tidak "klik"
    for (let i = 0; i < fade && i < p.length; i++) {
      const g = i / fade;
      out[off + i] *= g;
      out[off + p.length - 1 - i] *= g;
    }
    off += p.length;
  }
  const dur = samples.length / sampleRate;
  return {
    audio: { samples: out, sampleRate },
    removed: (samples.length - total) / sampleRate,
    cuts: cuts.map(([a, b]) => [Math.min(dur, a * 0.01), Math.min(dur, b * 0.01)]), // detik, di audio asli
  };
}

/**
 * Normalisasi kenyaringan audio (RMS pada bagian bersuara + batas puncak agar tidak clipping).
 */
export function normalizeLoudness(audio, { targetRmsDb = -16, peakLimitDb = -1, maxGainDb = 18 } = {}) {
  const { samples, sampleRate } = audio || {};
  if (!samples?.length) return audio;
  const { win, nWin, silent } = silenceMap(audio);
  let sumSq = 0, activeN = 0, peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-6) return audio;
  for (let w = 0; w < nWin; w++) {
    if (silent[w]) continue;
    const s = w * win, e = Math.min(samples.length, s + win);
    for (let i = s; i < e; i++) sumSq += samples[i] * samples[i];
    activeN += e - s;
  }
  const rms = activeN ? Math.sqrt(sumSq / activeN) : peak * 0.5;
  if (!Number.isFinite(rms) || rms < 1e-6) return audio;
  const rmsDb = 20 * Math.log10(rms);
  const gainDb = Math.min(maxGainDb, targetRmsDb - rmsDb);
  const peakLimit = Math.pow(10, peakLimitDb / 20);
  const gain = Math.min(Math.pow(10, gainDb / 20), peakLimit / peak);
  if (!Number.isFinite(gain) || Math.abs(gain - 1) < 0.03) return audio;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-peakLimit, Math.min(peakLimit, samples[i] * gain));
  return { ...audio, samples: out, sampleRate };
}

export function encodeWav({ samples, sampleRate }) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export async function resample(audio, targetRate) {
  if (audio.sampleRate === targetRate) return audio;
  const length = Math.ceil(audio.samples.length * targetRate / audio.sampleRate);
  const ctx = new OfflineAudioContext(1, length, targetRate);
  const src = ctx.createBufferSource();
  const ab = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
  ab.copyToChannel(audio.samples, 0);
  src.buffer = ab;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return { samples: rendered.getChannelData(0).slice(), sampleRate: targetRate };
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Potongan WAV 16 kHz (±90 detik per potong) untuk dikirim ke transkrip AI. Batas potongan digeser ke titik paling
// sunyi (±6 detik dari target) supaya tidak memotong kata. Potongan pendek = tiap panggilan cepat, bisa paralel, dan
// kalau satu macet hanya potongan itu yang diulang.
export async function wavChunksForTranscription(audio, chunkSec = 90) {
  const a16 = await resample(audio, 16000);
  const n = a16.samples.length;
  const rate = 16000, frame = 800, win = 6 * rate; // frame 50 ms
  const cuts = [0];
  while (n - cuts[cuts.length - 1] > (chunkSec + 10) * rate) {
    const target = cuts[cuts.length - 1] + chunkSec * rate;
    let best = target, bestE = Infinity;
    for (let c = target - win; c <= target + win; c += frame) {
      let e = 0;
      for (let k = c; k < c + frame; k++) e += Math.abs(a16.samples[k]);
      if (e < bestE) { bestE = e; best = c + (frame >> 1); }
    }
    cuts.push(best);
  }
  cuts.push(n);
  const chunks = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const part = a16.samples.subarray(cuts[k], cuts[k + 1]);
    const blob = encodeWav({ samples: part, sampleRate: rate });
    chunks.push({
      blob,
      base64: await blobToBase64(blob),
      offset: cuts[k] / rate,
      duration: part.length / rate,
    });
  }
  return chunks;
}
