// Memecah naskah / transkrip menjadi scene bertimestamp.
// Scene: { i, text, start, end, prompt, image (dataURL|null), status }

export function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+(?=[A-Z0-9"“'(À-ɏ])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

// "Berat" ucapan sebuah teks ≈ jumlah huruf/angka yang dibaca (+ jeda koma).
// Teks dalam [..]/(..) dan markdown tidak dibaca narator.
export function spokenWeight(text) {
  const t = text.replace(/\[[^\]]*\]/g, ' ').replace(/[*_#>`~]/g, '');
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  const commas = (t.match(/[,;:—–]/g) || []).length;
  return letters + commas * 4 + 1;
}

const lowerBoundNum = (arr, v) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
};

const lowerBound = (arr, t) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; }
  return lo;
};

/**
 * Selaraskan urutan potongan teks ke rentang audio [t0, t1] memakai jeda nyata.
 * Batas antar-potongan ditempatkan di jeda (diam) yang posisinya paling cocok dengan
 * perkiraan dari panjang teks, dioptimalkan sekaligus (DP) sehingga selisih tidak menumpuk.
 * Return: array waktu batas, panjang weights.length + 1 (b[0] = t0, b[n] = t1).
 */
export function alignUnits(weights, t0, t1, pauses = [], prior = null) {
  const n = weights.length;
  const span = t1 - t0;
  const W = weights.reduce((a, b) => a + b, 0) || 1;
  let exp = weights.map((w) => (span * w) / W);
  const cum = [0];
  for (const w of weights) cum.push(cum[cum.length - 1] + w);
  let prop = cum.map((c) => t0 + (span * c) / W);
  if (n <= 1) return [t0, t1];
  // Perkiraan batas dari luar (mis. timestamp transkrip AI) dipakai sebagai titik awal pencarian
  // dan perkiraan durasi tiap potongan; tetap dikunci ke jeda nyata di audio.
  if (prior?.length === n + 1) {
    prop = prior.map((t, k) => (k === 0 ? t0 : k === n ? t1 : Math.min(t1, Math.max(t0, t))));
    exp = exp.map((e, i) => Math.max(0.2, (prop[i + 1] - prop[i] + e) / 2));
  }

  const inRange = pauses.filter((p) => p.t > t0 + 0.05 && p.t < t1 - 0.05);
  const win = Math.max(4, span * 0.12);
  // Akhir kalimat biasanya jeda terpanjang; nilai jeda menurut peringkat durasinya di rentang ini
  // (koma = jeda pendek → bobot kecil), jadi tahan terhadap narasi yang cepat-lambat.
  const sortedDur = inRange.map((p) => p.dur).sort((a, b) => a - b);
  const rank = (d) => (sortedDur.length > 1 ? lowerBoundNum(sortedDur, d) / (sortedDur.length - 1) : 1);
  // kandidat tiap batas: jeda di sekitar perkiraan + titik perkiraan itu sendiri (cadangan)
  const cands = [null];
  for (let k = 1; k < n; k++) {
    const list = [];
    for (let j = lowerBound(inRange, prop[k] - win); j < inRange.length && inRange[j].t <= prop[k] + win; j++) {
      const p = inRange[j];
      list.push({ t: p.t, bonus: -1 * rank(p.dur) - 3 * Math.min(p.dur, 0.6) / 0.6 });
    }
    list.push({ t: prop[k], bonus: 0.8 });
    cands.push(list);
  }
  const unitCost = (i, a, b) => {
    const d = b - a;
    if (d < 0.12) return Infinity;
    // rasio (bukan selisih detik): kalimat dibaca 1,5× lebih cepat/lambat dinilai wajar
    const r = Math.log((d + 0.3) / (exp[i] + 0.3));
    return r * r;
  };

  let prev = [{ t: t0, cost: 0, back: -1 }];
  const table = [prev];
  for (let k = 1; k < n; k++) {
    const cur = cands[k].map((c) => {
      let best = Infinity, back = -1;
      for (let j = 0; j < prev.length; j++) {
        const v = prev[j].cost + unitCost(k - 1, prev[j].t, c.t);
        if (v < best) { best = v; back = j; }
      }
      return { t: c.t, cost: best + c.bonus, back };
    });
    table.push(cur);
    prev = cur;
  }
  let best = Infinity, bi = -1;
  prev.forEach((c, j) => {
    const v = c.cost + unitCost(n - 1, c.t, t1);
    if (v < best) { best = v; bi = j; }
  });
  if (!Number.isFinite(best)) return prop; // terlalu rapat — pakai pembagian proporsional

  const b = new Array(n + 1);
  b[0] = t0; b[n] = t1;
  for (let k = n - 1; k >= 1; k--) {
    b[k] = table[k][bi].t;
    bi = table[k][bi].back;
  }
  return b;
}

/**
 * Hitung ulang start/end semua scene dari teksnya terhadap audio (lewat jeda kalimat).
 * Dipakai setelah membuat scene dari naskah, setelah potong jeda, dan tombol "sinkronkan ulang".
 */
export function retimeScenes(scenes, totalSec, pauses = []) {
  if (!scenes.length) return scenes;
  const units = [];
  scenes.forEach((s, si) => {
    const sents = splitSentences(s.text || '');
    (sents.length ? sents : [s.text || '…']).forEach((t) => units.push({ si, w: spokenWeight(t) }));
  });
  const b = alignUnits(units.map((u) => u.w), 0, totalSec, pauses);
  scenes.forEach((s) => { s.start = Infinity; s.end = 0; });
  units.forEach((u, k) => {
    const s = scenes[u.si];
    s.start = Math.min(s.start, b[k]);
    s.end = Math.max(s.end, b[k + 1]);
  });
  scenes[0].start = 0;
  scenes[scenes.length - 1].end = totalSec;
  return scenes;
}

// Kelompokkan kalimat supaya tiap scene ±targetSec detik.
function groupByLength(units, targetSec, secOf) {
  const groups = [];
  let cur = [];
  let acc = 0;
  for (const u of units) {
    const d = secOf(u);
    if (cur.length && acc + d > targetSec * 1.25) {
      groups.push(cur);
      cur = [];
      acc = 0;
    }
    cur.push(u);
    acc += d;
    if (acc >= targetSec) {
      groups.push(cur);
      cur = [];
      acc = 0;
    }
  }
  if (cur.length) {
    // gabungkan sisa yang terlalu pendek ke scene sebelumnya
    if (groups.length && acc < targetSec * 0.4) groups[groups.length - 1].push(...cur);
    else groups.push(cur);
  }
  return groups;
}

/**
 * Scene dari naskah. Kalimat dikelompokkan ±targetSec, lalu waktunya diselaraskan ke
 * jeda nyata di audio (kalau `pauses` ada) supaya gambar berganti tepat saat kalimatnya dibaca.
 */
export function scenesFromScript(script, totalSec, targetSec, pauses = []) {
  const sentences = splitSentences(script);
  const W = sentences.reduce((n, s) => n + spokenWeight(s), 0) || 1;
  const groups = groupByLength(sentences, targetSec, (s) => (spokenWeight(s) * totalSec) / W);
  const scenes = groups.map((g, idx) => ({ i: idx + 1, text: g.join(' '), start: 0, end: 0, prompt: '', image: null, status: 'idle' }));
  return retimeScenes(scenes, totalSec, pauses);
}

/**
 * Timestamp transkrip AI bisa meleset (Gemini sering bergeser beberapa detik, makin jauh makin besar),
 * jadi dipakai sebagai perkiraan saja. Kalau timestampnya tidak masuk akal (tidak urut, tidak menutup
 * audio), waktunya dihitung dari panjang teks. Batas kalimat lalu dikunci ke jeda nyata di audio.
 */
export function alignTranscript(segments, totalSec, pauses = []) {
  const segs = segments.filter((s) => s.text);
  if (!segs.length) return [];
  const starts = segs.map((s) => s.start);
  const ordered = starts.every((t, k) => k === 0 || t >= starts[k - 1]);
  const last = segs[segs.length - 1].end;
  const covers = Number.isFinite(last) && last > totalSec * 0.8 && last < totalSec * 1.2;
  const prior = ordered && covers ? [0, ...starts.slice(1), totalSec] : null;
  const b = alignUnits(segs.map((s) => spokenWeight(s.text)), 0, totalSec, pauses, prior);
  return segs.map((s, k) => ({ text: s.text, start: b[k], end: b[k + 1] }));
}

// Scene dari transkrip bertimestamp (hasil AI). Waktunya diselaraskan ulang ke jeda di audio.
export function scenesFromTranscript(segments, totalSec, targetSec, pauses = []) {
  const segs = alignTranscript(segments, totalSec, pauses);
  const groups = groupByLength(segs, targetSec, (s) => s.end - s.start);
  return groups.map((g, idx) => ({
    i: idx + 1,
    text: g.map((s) => s.text).join(' '),
    start: idx === 0 ? 0 : g[0].start,
    end: g[g.length - 1].end,
    prompt: '',
    image: null,
    status: 'idle',
  })).map((s, idx, arr) => ({
    ...s,
    // scene menyambung tanpa celah: berakhir saat scene berikutnya mulai
    end: idx === arr.length - 1 ? totalSec : arr[idx + 1].start,
  }));
}

// Potongan subtitle (±7 kata) dengan timing proporsional di dalam scene.
// Potongan subtitle tidak melewati akhir kalimat, dan waktunya diselaraskan ke jeda di audio.
export function subtitleCues(scenes, pauses = [], maxWords = 7) {
  const cues = [];
  for (const s of scenes) {
    const chunks = [];
    for (const sent of splitSentences(s.text || '')) {
      const words = sent.split(/\s+/).filter(Boolean);
      // bagi rata supaya tidak ada potongan sisa 1–2 kata
      const parts = Math.ceil(words.length / maxWords);
      const per = Math.ceil(words.length / parts);
      for (let i = 0; i < words.length; i += per) chunks.push(words.slice(i, i + per).join(' '));
    }
    if (!chunks.length) continue;
    const b = alignUnits(chunks.map(spokenWeight), s.start, s.end, pauses);
    chunks.forEach((text, k) => cues.push({ start: b[k], end: b[k + 1], text }));
  }
  return cues;
}

export function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
