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
// `soft[k]` = true → batas ke-k jatuh di tengah frasa (bukan di tanda baca), jadi tidak ditarik kuat ke jeda.
export function alignUnits(weights, t0, t1, pauses = [], prior = null, soft = null) {
  const n = weights.length;
  if (n <= 1) return [t0, t1];
  const inRange = pauses.filter((p) => p.t > t0 + 0.05 && p.t < t1 - 0.05);
  // Waktu bicara (tanpa jeda) dari t0 sampai t. Panjang kalimat dibandingkan dengan waktu bicara,
  // bukan waktu total: narator sering berhenti lama di koma/daftar ("tenaga, bumbu, kemasan"),
  // dan jeda itu tidak boleh dihitung sebagai "kalimatnya sudah selesai".
  const gaps = inRange.map((p) => [Math.max(t0, p.start), Math.min(t1, p.end)]).filter(([a, b]) => b > a);
  const gapCum = [0];
  for (const [a, b] of gaps) gapCum.push(gapCum[gapCum.length - 1] + (b - a));
  const speechAt = (t) => {
    let lo = 0, hi = gaps.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (gaps[m][0] < t) lo = m + 1; else hi = m; }
    let g = gapCum[lo];
    if (lo > 0 && gaps[lo - 1][1] > t) g -= gaps[lo - 1][1] - t; // t berada di dalam jeda
    return t - t0 - g;
  };
  const speechSpan = Math.max(0.1, speechAt(t1));
  const timeAtSpeech = (sp) => { // kebalikan speechAt
    let t = t0 + sp;
    for (const [a, b] of gaps) { if (a < t) t += b - a; else break; }
    return Math.min(t1, t);
  };
  const W = weights.reduce((a, b) => a + b, 0) || 1;
  let exp = weights.map((w) => (speechSpan * w) / W);
  const cum = [0];
  for (const w of weights) cum.push(cum[cum.length - 1] + w);
  let prop = cum.map((c) => timeAtSpeech((speechSpan * c) / W));
  prop[0] = t0; prop[n] = t1;
  // Perkiraan batas dari luar (mis. timestamp transkrip AI) dipakai sebagai titik awal pencarian
  // dan perkiraan durasi tiap potongan; tetap dikunci ke jeda nyata di audio.
  if (prior?.length === n + 1) {
    const pr = prior.map((t, k) => (k === 0 ? t0 : k === n ? t1 : Math.min(t1, Math.max(t0, t))));
    exp = exp.map((e, i) => Math.max(0.2, (Math.max(0, speechAt(pr[i + 1]) - speechAt(pr[i])) + e) / 2));
    prop = prop.map((t, k) => (t + pr[k]) / 2);
  }

  const win = Math.max(4, span(t0, t1) * 0.12);
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
      const pull = soft?.[k] ? 0.25 : 1;
      list.push({ t: p.t, sp: speechAt(p.t), bonus: -pull * (rank(p.dur) + 3 * Math.min(p.dur, 0.6) / 0.6) });
    }
    list.push({ t: prop[k], sp: speechAt(prop[k]), bonus: 0.8 });
    cands.push(list);
  }
  const unitCost = (i, a, b) => {
    const d = b.sp - a.sp;
    if (b.t - a.t < 0.12) return Infinity;
    // rasio (bukan selisih detik): kalimat dibaca 1,5× lebih cepat/lambat dinilai wajar
    const r = Math.log((d + 0.3) / (exp[i] + 0.3));
    return 4 * r * r;
  };

  let prev = [{ t: t0, sp: 0, cost: 0, back: -1 }];
  const table = [prev];
  for (let k = 1; k < n; k++) {
    const cur = cands[k].map((c) => {
      let best = Infinity, back = -1;
      for (let j = 0; j < prev.length; j++) {
        const v = prev[j].cost + unitCost(k - 1, prev[j], c);
        if (v < best) { best = v; back = j; }
      }
      return { t: c.t, sp: c.sp, cost: best + c.bonus, back };
    });
    table.push(cur);
    prev = cur;
  }
  const end = { t: t1, sp: speechSpan };
  let best = Infinity, bi = -1;
  prev.forEach((c, j) => {
    const v = c.cost + unitCost(n - 1, c, end);
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
const span = (a, b) => b - a;

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

// Pecah kalimat jadi potongan subtitle ≤ maxWords kata, sebisa mungkin di tanda baca (koma dsb.),
// karena di situlah narator berhenti sejenak. Return: [{ text, soft }] — soft = dipotong di tengah frasa.
function subtitleChunks(sent, maxWords) {
  const clauses = sent.split(/(?<=[,;:—–])\s+/).map((c) => c.split(/\s+/).filter(Boolean)).filter((c) => c.length);
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ words: cur, soft: false }); cur = []; };
  for (const c of clauses) {
    if (cur.length && cur.length + c.length > maxWords) flush();
    if (c.length > maxWords) {
      // klausa panjang: bagi rata supaya tidak ada potongan sisa 1–2 kata
      const parts = Math.ceil(c.length / maxWords), per = Math.ceil(c.length / parts);
      for (let i = 0; i < c.length; i += per) out.push({ words: c.slice(i, i + per), soft: i > 0 });
    } else cur.push(...c);
  }
  flush();
  // potongan 1–2 kata di akhir digabung ke sebelumnya kalau masih muat
  const last = out[out.length - 1], prev = out[out.length - 2];
  if (prev && last.words.length <= 2 && prev.words.length + last.words.length <= maxWords + 2) {
    prev.words.push(...last.words);
    out.pop();
  }
  return out.map((o) => ({ text: o.words.join(' '), soft: o.soft }));
}

// Potongan subtitle dengan waktu diselaraskan ke jeda di audio; tidak melewati akhir kalimat.
export function subtitleCues(scenes, pauses = [], maxWords = 7) {
  const cues = [];
  for (const s of scenes) {
    const chunks = [];
    for (const sent of splitSentences(s.text || '')) {
      subtitleChunks(sent, maxWords).forEach((c, k) => chunks.push({ ...c, soft: k > 0 && c.soft }));
    }
    if (!chunks.length) continue;
    const b = alignUnits(chunks.map((c) => spokenWeight(c.text)), s.start, s.end, pauses, null, chunks.map((c) => c.soft));
    chunks.forEach((c, k) => cues.push({ start: b[k], end: b[k + 1], text: c.text }));
  }
  return cues;
}

export function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
