// Klik ikon extension → buka side panel (berdampingan dengan tab Google Flow).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[Klipin] setPanelBehavior', e));

// AI agent (Klipin MCP server di localhost): kalau agent mengirim tugas tetapi panel Klipin belum
// terbuka, buka Klipin di tab (side panel tidak bisa dibuka tanpa klik pengguna).
const AGENT_URL = 'http://127.0.0.1:47816';
chrome.alarms.create('klipin-agent', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'klipin-agent') return;
  const { agentBridge = true } = await chrome.storage.local.get('agentBridge');
  if (!agentBridge) return;
  try {
    const st = await (await fetch(`${AGENT_URL}/state`, { headers: { 'x-klipin-client': 'background' } })).json();
    if (!st.pending || st.alive) return;
    const url = chrome.runtime.getURL('sidepanel.html');
    const open = await chrome.tabs.query({ url: `${url}*` });
    if (!open.length) await chrome.tabs.create({ url: `${url}?agent=1`, active: false, pinned: true });
  } catch {
    // server MCP tidak jalan — normal kalau pengguna tidak memakai AI agent
  }
});

// Klik "asli" untuk Google Flow. Flow mengabaikan klik/Enter buatan script (event.isTrusted = false),
// jadi tombol kirim diklik lewat Chrome DevTools Protocol. Selama dipakai, Chrome menampilkan bilah
// "Klipin sedang men-debug browser ini"; debugger dilepas lagi setelah 2 menit tidak dipakai.
const attached = new Set();
const detachTimers = new Map();

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw e; // service worker sempat tidur, sesi lama masih ada
  }
  attached.add(tabId);
}

function scheduleDetach(tabId) {
  clearTimeout(detachTimers.get(tabId));
  detachTimers.set(tabId, setTimeout(() => {
    attached.delete(tabId);
    chrome.debugger.detach({ tabId }).catch(() => {});
  }, 120000));
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

async function trustedClick(tabId, x, y, attempt = 1) {
  await ensureAttached(tabId);
  // Saat zoom halaman ≠ 100%, skala koordinat CDP bisa berbeda dari piksel CSS → percobaan
  // berikutnya memakai skala yang lain (sama saja kalau zoom 100%).
  const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
  const k = attempt % 2 ? 1 : zoom;
  const base = { x: x * k, y: y * k, button: 'left', clickCount: 1 };
  const send = (p) => chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', p);
  await send({ ...base, type: 'mouseMoved', button: 'none' });
  await send({ ...base, type: 'mousePressed' });
  await send({ ...base, type: 'mouseReleased' });
  scheduleDetach(tabId);
}

// Isi <input type=file> di tab lain (mis. dialog upload YouTube Studio) dengan file dari komputer ini.
// Lewat CDP karena script biasa tidak boleh memilih file lokal; tidak ada batas ukuran file.
async function setFileInput(tabId, files, kind) {
  await ensureAttached(tabId);
  const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p);
  // cari input file yang terlihat, termasuk di dalam shadow DOM
  const expr = `(() => {
    const out = [];
    const walk = (root) => root.querySelectorAll('*').forEach((el) => {
      if (el.tagName === 'INPUT' && el.type === 'file') out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    });
    walk(document);
    const want = ${JSON.stringify(kind)};
    const ok = (el) => { const a = (el.accept || '').toLowerCase(); return want === 'image' ? /image/.test(a) : !/^image/.test(a); };
    return out.filter(ok).at(-1) || null;
  })()`;
  const { result } = await send('Runtime.evaluate', { expression: expr });
  if (!result?.objectId) throw new Error(kind === 'image' ? 'Tombol upload thumbnail tidak ditemukan di halaman.' : 'Kotak upload file tidak ditemukan — buka dialog upload dulu.');
  await send('DOM.setFileInputFiles', { files, objectId: result.objectId });
  scheduleDetach(tabId);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TUYUL_SET_FILE' && !sender.tab) { // hanya dari panel Klipin
    setFileInput(msg.tabId, msg.files, msg.kind)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'TUYUL_SLEEP' && sender.tab?.id) { // jeda untuk tab Flow yang tersembunyi (lihat content/flow.js)
    setTimeout(() => sendResponse({ ok: true }), Math.min(Number(msg.ms) || 0, 30000));
    return true;
  }
  if (msg?.type === 'TUYUL_DEBUG_ATTACH' && sender.tab?.id) {
    // Pasang debugger SEBELUM posisi tombol diukur: bilah "sedang men-debug" yang muncul
    // saat pertama dipasang memperkecil halaman dan menggeser tombol kirim.
    const fresh = !attached.has(sender.tab.id);
    ensureAttached(sender.tab.id)
      .then(() => sendResponse({ ok: true, fresh }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type !== 'TUYUL_TRUSTED_CLICK' || !sender.tab?.id) return false;
  trustedClick(sender.tab.id, msg.x, msg.y, msg.attempt)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
