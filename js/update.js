// Cek versi baru Klipin di GitHub Releases. Extension yang dipasang lewat "Load unpacked" tidak bisa
// mengganti filenya sendiri, jadi Klipin memberi tahu, mengunduh ZIP-nya, lalu memandu langkah sisanya.

const REPO = 'wildanlsfs/klipin';
const EVERY_MS = 6 * 3600 * 1000;

const parse = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
export function newer(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

/** @returns {Promise<null | { version, current, page, zip, notes }>} */
export async function checkUpdate({ force = false } = {}) {
  const current = chrome.runtime.getManifest().version;
  const { updCheck } = await chrome.storage.local.get('updCheck');
  let rel = updCheck?.rel;
  if (force || !rel || Date.now() - (updCheck.at || 0) > EVERY_MS) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const j = await res.json();
    const zip = (j.assets || []).find((a) => /^klipin-[\d.]+\.zip$/i.test(a.name));
    rel = { version: j.tag_name?.replace(/^v/, ''), page: j.html_url, zip: zip?.browser_download_url || '', notes: (j.body || '').slice(0, 1500) };
    await chrome.storage.local.set({ updCheck: { at: Date.now(), rel } });
  }
  return rel?.version && newer(rel.version, current) ? { ...rel, current } : null;
}

export async function downloadUpdate(u) {
  return chrome.downloads.download({ url: u.zip || u.page, filename: `Klipin/klipin-${u.version}.zip`, conflictAction: 'overwrite' });
}
