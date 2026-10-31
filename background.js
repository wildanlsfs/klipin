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
