// Simpan proyek di IndexedDB supaya tidak hilang saat side panel ditutup
// (gambar & audio terlalu besar untuk chrome.storage).

const DB = 'tuyul-content'; // nama lama sengaja dipertahankan supaya project yang tersimpan tidak hilang
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const kvGet = (key) => tx('readonly', (s) => s.get(key));
export const kvSet = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const kvDel = (key) => tx('readwrite', (s) => s.delete(key));
