// Jembatan ke Klipin MCP server (mcp/server.mjs) supaya AI agent bisa menjalankan Klipin.
// Panel mengambil tugas lewat long-poll ke localhost, menjalankannya, lalu mengirim hasilnya.

export const AGENT_URL = 'http://127.0.0.1:47816';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {Record<string, (args, progress) => Promise<{text, image?}>>} tools
 * @param {(state: 'off'|'offline'|'online'|'standby'|'working', info?: string) => void} onState
 */
export function startAgentBridge(tools, onState) {
  const client = crypto.randomUUID();
  const headers = { 'x-klipin-client': client };
  let enabled = false, running = false, state = '';
  const set = (s, info) => { if (s !== state || info) { state = s; onState(s, info); } };
  const post = (p, body) => fetch(`${AGENT_URL}${p}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});

  async function run(job) {
    const fn = tools[job.tool.replace(/^klipin_/, '')];
    set('working', job.tool);
    let lastProg = 0;
    const progress = (text) => { // dibatasi supaya tidak membanjiri server
      if (Date.now() - lastProg < 800) return;
      lastProg = Date.now();
      post('/progress', { id: job.id, text });
    };
    try {
      if (!fn) throw new Error(`Tool ${job.tool} tidak dikenal oleh versi Klipin ini — update extension.`);
      const r = await fn(job.args || {}, progress);
      await post('/result', { id: job.id, ok: true, ...r });
    } catch (e) {
      console.warn('[Klipin] agent', job.tool, e);
      await post('/result', { id: job.id, ok: false, error: e?.message || String(e) });
    }
    set('online');
  }

  async function loop() {
    running = true;
    while (enabled) {
      let r;
      try {
        const res = await fetch(`${AGENT_URL}/poll`, { headers, cache: 'no-store' });
        r = await res.json();
      } catch {
        set('offline');
        await sleep(15000); // server belum jalan → cek lagi sesekali saja
        continue;
      }
      if (r.standby) { set('standby'); await sleep(4000); continue; }
      if (state !== 'working') set('online');
      if (r.job) run(r.job); // tetap polling selama tugas berjalan → server tahu panel masih hidup
    }
    running = false;
    set('off');
  }

  return {
    setEnabled(on) {
      enabled = on;
      if (on && !running) loop();
      if (!on) set('off');
    },
  };
}
