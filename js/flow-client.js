// Klien otomasi Google Flow (mencari/membuka tab Flow, buat project baru, kirim prompt, normalisasi gambar).
import { FLOW_URL } from './data.js';
import { toast, errMsg } from './dom.js';
import * as llm from './llm.js';

// URL Flow berubah-ubah (flow.google.com, labs.google/fx/tools/flow, /fx/id/tools/flow, labs.google/flow…),
// jadi cocokkan longgar: domain Flow/Labs + kata "flow" di host/path.
export const isFlowUrl = (u = '') =>
  /^https:\/\/([a-z0-9-]+\.)*(labs\.google|flow\.google|flow\.google\.com)(:\d+)?(\/|$)/i.test(u) && /flow/i.test(u);

export async function findFlowTab() {
  const tabs = (await chrome.tabs.query({})).filter((t) => isFlowUrl(t.url || t.pendingUrl));
  // utamakan tab project (punya kotak prompt) → tab aktif → yang terakhir dipakai
  return tabs.find((t) => /\/project\//.test(t.url || ''))
    || tabs.find((t) => t.active)
    || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
    || null;
}

function waitTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUp); resolve(); }, timeoutMs);
    function onUp(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUp);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUp);
  });
}

async function pingFlowTab(tabId) {
  let r = await chrome.tabs.sendMessage(tabId, { type: 'TUYUL_PING' }).catch(() => null);
  if (!r) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/flow.js'] }).catch(() => {});
    r = await chrome.tabs.sendMessage(tabId, { type: 'TUYUL_PING' }).catch(() => null);
  }
  return r;
}

export async function connectFlow() {
  const tab = await findFlowTab();
  if (!tab) {
    const [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const where = act?.url ? ` (tab aktif: ${act.url.replace(/^https?:\/\//, '').slice(0, 60)})` : '';
    return { ok: false, reason: `Tab Flow belum dibuka${where}` };
  }
  const r = await pingFlowTab(tab.id);
  if (!r) return { ok: false, tab, reason: 'Tidak bisa terhubung (muat ulang tab Flow)' };
  if (r.needsLogin) return { ok: false, tab, needsLogin: true, reason: 'Belum login ke Google Flow' };
  if (!r.hasInput) return { ok: false, tab, reason: 'Buka sebuah project di Flow' };
  return { ok: true, tab };
}

/**
 * Pastikan ada tab project Google Flow yang siap menerima prompt.
 * Kalau belum ada atau masih di beranda, otomatis buka Flow & klik "New project".
 */
export async function ensureFlowProject({ autoCreate = true, onStatus } = {}) {
  let c = await connectFlow();
  if (c.ok) return c;
  if (c.needsLogin || !autoCreate) return c;

  onStatus?.('Membuka Google Flow & menyiapkan project…');
  let tab = c.tab;
  if (!tab) {
    tab = await chrome.tabs.create({ url: FLOW_URL, active: true });
    await waitTabComplete(tab.id);
    await new Promise((r) => setTimeout(r, 1200));
  } else if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  }

  let ping = await pingFlowTab(tab.id);
  if (!ping) return { ok: false, tab, reason: 'Tidak bisa terhubung ke tab Flow (coba muat ulang).' };
  if (ping.needsLogin) return { ok: false, tab, needsLogin: true, reason: 'Silakan login ke akun Google di tab Flow dulu.' };

  if (!ping.hasInput) {
    onStatus?.('Membuat project baru di Google Flow…');
    const created = await chrome.tabs.sendMessage(tab.id, { type: 'TUYUL_FLOW_NEW_PROJECT' }).catch((e) => ({ ok: false, error: errMsg(e) }));
    if (!created?.ok) {
      return {
        ok: false,
        tab,
        needsLogin: !!created?.needsLogin,
        reason: created?.error || 'Gagal membuat project baru di Flow.',
      };
    }
  }
  return connectFlow();
}

export async function normalizeImage(src, maxSide = 1920) {
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

/**
 * Cover-crop gambar ke ukuran target (mis. 320×200 JPG untuk contoh gaya visual).
 * @returns {Promise<{ blob: Blob, dataUrl: string }>}
 */
export async function cropToJpeg(src, w = 320, h = 200, quality = 0.86) {
  let blob = src instanceof Blob ? src : null;
  for (const credentials of ['include', 'omit']) {
    if (blob) break;
    try {
      const res = await fetch(src, { credentials });
      if (res.ok) blob = await res.blob();
    } catch {}
  }
  if (!blob) throw new Error('Gambar tidak bisa dibaca.');
  const bmp = await createImageBitmap(blob);
  const k = Math.max(w / bmp.width, h / bmp.height);
  const dw = bmp.width * k, dh = bmp.height * k;
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  bmp.close();
  const out = await c.convertToBlob({ type: 'image/jpeg', quality });
  const dataUrl = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(out);
  });
  return { blob: out, dataUrl };
}

// Atur Flow sebelum mulai: mode langsung (bukan Agen), Gambar, rasio proyek, 1 gambar per prompt.
export async function configureFlow(tabId, ratio) {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'TUYUL_FLOW_CONFIGURE', ratio, count: 1 }).catch(() => null);
  if (r?.ok && r.changed?.length) toast(`Flow diatur otomatis: ${r.changed.join(', ')}`, 'ok');
  else if (r && !r.ok) toast(r.error, 'err');
  return r;
}

/**
 * Kirim daftar scene ke Google Flow secara paralel (1–5 sekaligus).
 */
export async function runFlowBatch({
  targets, totalScenes, ratio, parallel = 5, settings, visualStyle,
  autoCreate = false, shouldStop = () => false, onSceneUpdate, onProgress, onBatchProgress, onStatus,
}) {
  if (!targets.length) return { ok: 0, fail: 0, stopped: false };
  if (targets.some((s) => !s.prompt)) throw new Error('Ada scene tanpa prompt. Buat storyboard dulu.');

  const c = autoCreate ? await ensureFlowProject({ autoCreate: true, onStatus }) : await connectFlow();
  if (!c.ok) throw new Error(`Flow: ${c.reason}`);

  if (!c.tab.active) await chrome.tabs.update(c.tab.id, { active: true }).catch(() => {});
  await configureFlow(c.tab.id, ratio);

  let ok = 0, fail = 0, started = 0, stopped = false;
  const par = targets.length > 1 ? Math.min(5, Math.max(1, parallel)) : 1;

  const one = async (k) => {
    const s = targets[k];
    s.status = 'working';
    s.error = '';
    onSceneUpdate?.(s);
    onBatchProgress?.(ok + fail, targets.length);
    onProgress?.(`scene ${s.i} (${k + 1}/${targets.length}${par > 1 ? `, ${par} sekaligus` : ''})`);

    let res = null;
    let promptToSend = s.prompt;
    let softened = false;
    for (let waits = 0; !shouldStop() && !stopped; ) {
      res = await chrome.tabs.sendMessage(c.tab.id, {
        type: 'TUYUL_FLOW_GENERATE', prompt: promptToSend, label: `Scene ${s.i}/${totalScenes}`, count: 1,
      }).catch((e) => ({ ok: false, error: errMsg(e) }));
      if (res?.ok) break;
      const err = res?.error || '';
      if (/tidak ditemukan|Receiving end/i.test(err)) break;
      // Hanya tunggu antrean kalau Flow masih memproses batch lain; JANGAN kirim ulang saat timeout (mencegah boros kredit ganda)
      if (/sedang memproses/i.test(err) && waits++ < 150) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      // Jika ditolak filter keamanan Flow dan settings tersedia → perhalus prompt sekali lalu kirim ulang
      if (res?.policyError && !softened && settings) {
        softened = true;
        try {
          promptToSend = await llm.softenScenePrompt(settings, { prompt: s.prompt, visualStyle });
          s.prompt = promptToSend;
          onSceneUpdate?.(s);
          continue;
        } catch {}
      }
      break;
    }

    if (res?.ok) {
      try {
        const outs = res.images?.length ? res.images : [res];
        const imgs = [];
        for (const o of outs) {
          try { imgs.push(await normalizeImage(o.image || o.url)); } catch {}
        }
        if (!imgs.length) throw new Error('kosong');
        [s.image, ...s.alts] = imgs;
        s.status = 'done';
        ok++;
      } catch {
        s.status = 'error';
        s.error = 'gagal ambil gambar';
        fail++;
      }
    } else {
      s.status = 'error';
      s.error = res?.error || 'gagal';
      fail++;
      if (/tidak ditemukan|Receiving end/i.test(s.error)) {
        stopped = true;
        toast(s.error, 'err');
      }
    }
    onSceneUpdate?.(s);
    onBatchProgress?.(ok + fail, targets.length);
  };

  try {
    await Promise.all(Array.from({ length: Math.min(par, targets.length) }, async () => {
      while (!shouldStop() && !stopped && started < targets.length) await one(started++);
    }));
  } finally {
    chrome.tabs.sendMessage(c.tab.id, {
      type: 'TUYUL_STATUS',
      text: shouldStop() || stopped ? 'dihentikan' : `selesai — ${ok} gambar`,
    }).catch(() => {});
  }
  return { ok, fail, stopped: shouldStop() || stopped };
}

export async function generateConceptImages({ concepts, ks, ratio, autoCreate = true, onDoneOne }) {
  const c = autoCreate ? await ensureFlowProject({ autoCreate: true }) : await connectFlow();
  if (!c.ok) throw new Error(`Flow: ${c.reason}`);
  if (!c.tab.active) await chrome.tabs.update(c.tab.id, { active: true }).catch(() => {});
  await configureFlow(c.tab.id, ratio);
  let done = 0;
  const errors = [];
  await Promise.all(ks.map(async (k) => {
    const concept = concepts[k];
    let res;
    for (let waits = 0; waits < 150; waits++) {
      res = await chrome.tabs.sendMessage(c.tab.id, {
        type: 'TUYUL_FLOW_GENERATE', prompt: concept.prompt, label: `Thumbnail ${k + 1}`, count: 1,
      }).catch((e) => ({ ok: false, error: errMsg(e) }));
      if (res?.ok || !/sedang memproses/i.test(res?.error || '')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!res?.ok) { errors.push(`konsep ${k + 1}: ${res?.error || 'gagal'}`); return; }
    const o = res.images?.[0] || res;
    concept.image = await normalizeImage(o.image || o.url, 1600);
    done++;
    onDoneOne?.(k, concept);
  }));
  if (!done && errors.length) throw new Error(`Flow gagal membuat gambar (${errors.join('; ')}).`);
  if (errors.length) toast(`Sebagian gagal: ${errors.join('; ')}`, 'err');
  return done;
}

export async function generateThumbBgInFlow({ prompt, ratio, autoCreate = true }) {
  const c = autoCreate ? await ensureFlowProject({ autoCreate: true }) : await connectFlow();
  if (!c.ok) throw new Error(`Flow: ${c.reason}`);
  if (!c.tab.active) await chrome.tabs.update(c.tab.id, { active: true }).catch(() => {});
  await configureFlow(c.tab.id, ratio);
  const res = await chrome.tabs.sendMessage(c.tab.id, {
    type: 'TUYUL_FLOW_GENERATE', prompt, label: 'Thumbnail', count: 1,
  });
  if (!res?.ok) throw new Error(res?.error || 'Flow gagal membuat gambar.');
  const outs = res.images?.length ? res.images : [res];
  const imgs = [];
  for (const o of outs) {
    try { imgs.push(await normalizeImage(o.image || o.url, 1600)); } catch {}
  }
  if (!imgs.length) throw new Error('Gambar latar thumbnail gagal diunduh.');
  return imgs;
}
