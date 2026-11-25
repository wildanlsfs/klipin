// Klik ikon extension → buka side panel (berdampingan dengan tab Google Flow).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[Klipin] setPanelBehavior', e));

// AI agent (Klipin MCP server di localhost): kalau agent mengirim tugas tetapi panel Klipin belum
// terbuka, buka Klipin di tab (side panel tidak bisa dibuka tanpa klik pengguna).
const AGENT_URL = 'http://127.0.0.1:47816';
const DETACH_PREFIX = 'klipin-detach-';
const AUTOMATED_HOST = /^https:\/\/([a-z0-9-]+\.)*(labs\.google|flow\.google|flow\.google\.com|aistudio\.google\.com)(:\d+)?(\/|$)/i;

chrome.alarms.create('klipin-agent', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(DETACH_PREFIX)) {
    const tabId = Number(alarm.name.slice(DETACH_PREFIX.length));
    attached.delete(tabId);
    if (Number.isFinite(tabId)) chrome.debugger.detach({ tabId }).catch(() => {});
    return;
  }
  if (alarm.name !== 'klipin-agent') return;
  const { agentBridge = true } = await chrome.storage.local.get('agentBridge');
  if (!agentBridge) return;
  try {
    const st = await (await fetch(`${AGENT_URL}/state`, { headers: { 'x-klipin-client': 'background' } })).json();
    if (!st.pending || st.alive) return;
    const url = chrome.runtime.getURL('sidepanel.html');
    const open = await chrome.tabs.query({ url: `${url}*` });
    if (!open.length) {
      const tab = await chrome.tabs.create({ url: `${url}?agent=1`, active: false, pinned: true });
      chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {}); // jangan ditidurkan hemat memori Chrome
    } else {
      const { lastWake = 0 } = await chrome.storage.session.get('lastWake').catch(() => ({}));
      if (Date.now() - lastWake > 90000) {
        // Tab Klipin ada tapi tidak terhubung (biasanya ditidurkan Chrome): muat ulang, maks sekali per 90 detik.
        await chrome.storage.session.set({ lastWake: Date.now() }).catch(() => {});
        await chrome.tabs.reload(open[0].id);
        chrome.tabs.update(open[0].id, { autoDiscardable: false }).catch(() => {});
      }
    }
  } catch {
    // server MCP tidak jalan — normal kalau pengguna tidak memakai AI agent
  }
});

// Klik & ketik "asli" untuk Google Flow / AI Studio. Halaman mengabaikan event buatan script
// (event.isTrusted = false), jadi tombol/input dikirim lewat Chrome DevTools Protocol.
const attached = new Set();

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
  chrome.alarms.create(`${DETACH_PREFIX}${tabId}`, { delayInMinutes: 2 });
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

async function cdpTypeText(tabId, text, clearFirst = false) {
  await ensureAttached(tabId);
  const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p);
  if (clearFirst) {
    // Pilih semua teks di elemen fokus lalu hapus sebelum insertText
    const mod = (await chrome.runtime.getPlatformInfo().catch(() => ({ os: 'mac' }))).os === 'mac' ? 4 : 2;
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mod, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mod, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  }
  if (text) await send('Input.insertText', { text: String(text) });
  scheduleDetach(tabId);
}

// Isi <input type=file> di tab YouTube Studio dengan file video/thumbnail hasil Klipin.
// Lewat CDP karena script biasa tidak boleh memilih file lokal; tidak ada batas ukuran file.
async function setFileInput(tabId, files, kind) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https:\/\/studio\.youtube\.com\//i.test(tab?.url || '')) {
    throw new Error('Tab tujuan bukan YouTube Studio.');
  }
  const extRe = kind === 'image' ? /\.(jpe?g|png|webp)$/i : /\.(mp4|mov|webm|mkv)$/i;
  if (!Array.isArray(files) || !files.length || files.some((f) => typeof f !== 'string' || !f || f.includes('\0') || !extRe.test(f))) {
    throw new Error('Path atau format file tidak valid untuk diunggah.');
  }

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
  if (msg?.type === 'TUYUL_SET_FILE' && sender.url?.startsWith(chrome.runtime.getURL('sidepanel.html'))) { // hanya dari panel Klipin (side panel atau tab)
    setFileInput(msg.tabId, msg.files, msg.kind)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  const fromAutoTab = Boolean(sender.tab?.id && AUTOMATED_HOST.test(sender.tab.url || ''));
  if (!fromAutoTab) return false;

  if (msg?.type === 'TUYUL_SLEEP') { // jeda untuk tab Flow / AI Studio yang tersembunyi
    setTimeout(() => sendResponse({ ok: true }), Math.min(Number(msg.ms) || 0, 30000));
    return true;
  }
  if (msg?.type === 'TUYUL_DEBUG_ATTACH') {
    const fresh = !attached.has(sender.tab.id);
    ensureAttached(sender.tab.id)
      .then(() => sendResponse({ ok: true, fresh }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'TUYUL_CDP_TYPE') {
    cdpTypeText(sender.tab.id, msg.text, !!msg.clear)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'TUYUL_TRUSTED_CLICK') {
    trustedClick(sender.tab.id, msg.x, msg.y, msg.attempt)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});
