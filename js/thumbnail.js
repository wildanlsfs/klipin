// Renderer & utilitas thumbnail YouTube/Shorts (16:9 → 1280×720, 9:16 → 1080×1920, 1:1 → 1080×1080).
import { THUMB_TYPES } from './data.js';

export const THUMB_COLORS = { yellow: '#ffd400', white: '#ffffff', red: '#ff2d2d' };
export const SPLIT_COLORS = ['#ff3b3b', '#3ddc63']; // teks dua sisi: kiri/atas = hasil buruk, kanan/bawah = hasil baik

export const thumbSize = (ratio) =>
  ratio === '9:16' ? { w: 1080, h: 1920 } : ratio === '1:1' ? { w: 1080, h: 1080 } : { w: 1280, h: 720 };

export const thumbType = (id) => THUMB_TYPES.find((t) => t.id === id);
export const layoutPos = (t) => (t?.layout === 'split' ? 'split' : t?.layout === 'bottom' ? 'bottom' : 'left');

const imgCache = new Map();
export function clearImgCache() { imgCache.clear(); }

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

export function thumbBgList(S) {
  const yt = S.yt || { bgs: [], concepts: [] };
  return [
    ...(yt.concepts || []).map((c, k) => c.image && { key: `c${k}`, src: c.image, label: `konsep ${k + 1}` }).filter(Boolean),
    ...(yt.bgs || []).map((src, n) => ({ key: `g${n}`, src, label: 'latar' })),
    ...(S.scenes || []).filter((x) => x.image).map((x) => ({ key: `s${x.i}`, src: x.image, label: `scene ${x.i}` })),
  ];
}

export function currentBg(S, key = S.yt?.thumb?.bg) {
  const list = thumbBgList(S);
  return list.find((b) => b.key === key) || list[0] || null;
}

function layoutThumbText(ctx, text, boxW, boxH) {
  const words = text.toUpperCase().replace(/\bRP(?=\s?\d)/g, 'Rp').split(/\s+/).filter(Boolean);
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

function strokeFill(ctx, l, x, y, size, fill) {
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 6;
  ctx.lineWidth = Math.max(8, size * 0.12);
  ctx.strokeStyle = '#000';
  ctx.lineJoin = 'round';
  ctx.strokeText(l, x, y);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = fill;
  ctx.fillText(l, x, y);
}

function drawSplitText(ctx, text, W, H, tall) {
  const parts = text.split('|').map((x) => x.trim()).filter(Boolean).slice(0, 2);
  if (parts.length < 2) parts.push('');
  const pad = 40;
  const boxes = tall
    ? [{ x: 0, y: H * 0.06, w: W, h: H * 0.16 }, { x: 0, y: H * 0.53, w: W, h: H * 0.16 }]
    : [{ x: 0, y: pad, w: W / 2, h: H * 0.36 }, { x: W / 2, y: pad, w: W / 2, h: H * 0.36 }];
  boxes.forEach((b, k) => {
    const g = ctx.createLinearGradient(0, b.y - pad, 0, b.y + b.h + pad);
    g.addColorStop(0, 'rgba(0,0,0,.7)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(b.x, Math.max(0, b.y - pad), b.w, b.h + pad * 2);
    if (!parts[k]) return;
    const { size, lines, lh } = layoutThumbText(ctx, parts[k], b.w - pad * 2, b.h);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    lines.forEach((l, n) => strokeFill(ctx, l, b.x + b.w / 2, b.y + n * lh, size, SPLIT_COLORS[k]));
  });
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  if (tall) ctx.fillRect(0, H / 2 - 3, W, 6);
  else ctx.fillRect(W / 2 - 3, 0, 6, H);
}

let drawSeq = 0;
export async function drawThumb(canvas, S, spec = S.yt?.thumb || {}, { onSize } = {}) {
  const isMain = canvas.id === 'thumbCanvas';
  const seq = isMain ? ++drawSeq : drawSeq;
  const { text = '', pos = 'left', color = 'yellow' } = spec;
  const bg = currentBg(S, spec.bg);
  const im = bg ? await loadImg(bg.src).catch(() => null) : null;
  if (isMain && seq !== drawSeq) return;
  if (isMain) {
    const { w, h } = thumbSize(S.ratio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    onSize?.(w, h);
  }
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const tall = H > W;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  if (im) {
    const k = Math.max(W / im.width, H / im.height);
    const dw = im.width * k, dh = im.height * k;
    const fx = tall ? 0.5 : pos === 'left' ? 0.65 : pos === 'right' ? 0.35 : 0.5;
    ctx.drawImage(im, (W - dw) * fx, (H - dh) * 0.4, dw, dh);
  }
  if (!text.trim()) return;
  if (pos === 'split') return drawSplitText(ctx, text, W, H, tall);

  const g = pos === 'bottom' ? ctx.createLinearGradient(0, H, 0, H * (tall ? 0.5 : 0.35))
    : tall ? ctx.createLinearGradient(0, 0, 0, H * 0.5)
    : pos === 'left' ? ctx.createLinearGradient(0, 0, W * 0.7, 0) : ctx.createLinearGradient(W, 0, W * 0.3, 0);
  g.addColorStop(0, 'rgba(0,0,0,.78)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const pad = 56;
  const boxW = pos === 'bottom' || tall ? W - pad * 2 : W * 0.56;
  const boxH = tall ? H * 0.3 : pos === 'bottom' ? H * 0.45 : H - pad * 2;
  const { size, lines, lh } = layoutThumbText(ctx, text, boxW, boxH);
  const blockH = lines.length * lh;
  const y0 = tall ? (pos === 'bottom' ? H * 0.82 - blockH : H * 0.1)
    : pos === 'bottom' ? H - pad - blockH : (H - blockH) / 2;
  ctx.textBaseline = 'top';
  ctx.textAlign = pos === 'right' ? 'right' : pos === 'bottom' ? 'center' : 'left';
  const x = pos === 'right' ? W - pad : pos === 'bottom' ? W / 2 : pad;
  ctx.lineJoin = 'round';
  lines.forEach((l, k) => {
    const y = y0 + k * lh;
    strokeFill(ctx, l, x, y, size, k === 0 || color === 'white' ? (THUMB_COLORS[color] || THUMB_COLORS.yellow) : '#ffffff');
  });
}

export async function thumbBlob(S) {
  const { w, h } = thumbSize(S.ratio);
  const c = new OffscreenCanvas(w, h);
  await drawThumb(c, S, S.yt?.thumb || {});
  let blob;
  for (const q of [0.92, 0.85, 0.75, 0.65]) { // YouTube: maks 2 MB
    blob = await c.convertToBlob({ type: 'image/jpeg', quality: q });
    if (blob.size < 2e6) break;
  }
  return blob;
}

export async function thumbPreviewBase64(S) {
  const { w, h } = thumbSize(S.ratio);
  const c = new OffscreenCanvas(w, h);
  await drawThumb(c, S, S.yt?.thumb || {});
  const k = 640 / Math.max(w, h);
  const small = new OffscreenCanvas(Math.round(w * k), Math.round(h * k));
  small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
  const prev = await small.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.readAsDataURL(prev);
  });
}
