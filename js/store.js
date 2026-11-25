// Simpan proyek di IndexedDB supaya tidak hilang saat side panel ditutup
// (gambar & audio terlalu besar untuk chrome.storage).

const DB = 'tuyul-content'; // nama lama sengaja dipertahankan supaya project yang tersimpan tidak hilang
const STORE = 'kv';
const MEDIA = 'media';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const kvGet = (key) => tx(STORE, 'readonly', (s) => s.get(key));
export const kvSet = (key, value) => tx(STORE, 'readwrite', (s) => s.put(value, key));
export const kvDel = (key) => tx(STORE, 'readwrite', (s) => s.delete(key));

export const mediaGet = (key) => tx(MEDIA, 'readonly', (s) => s.get(key));
export const mediaSet = (key, value) => tx(MEDIA, 'readwrite', (s) => s.put(value, key));
export const mediaDel = (key) => tx(MEDIA, 'readwrite', (s) => s.delete(key));
export const mediaClear = () => tx(MEDIA, 'readwrite', (s) => s.clear());
export async function mediaClearProject() {
  const db = await open();
  const keys = await new Promise((resolve) => {
    const t = db.transaction(MEDIA, 'readonly');
    const req = t.objectStore(MEDIA).getAllKeys();
    t.oncomplete = () => resolve(req.result || []);
    t.onerror = () => resolve([]);
  });
  const projectKeys = keys.filter((k) => !String(k).startsWith('style-preview:'));
  if (!projectKeys.length) return;
  await tx(MEDIA, 'readwrite', (s) => {
    for (const k of projectKeys) s.delete(k);
  });
}

// Peta nilai dataURL yang sudah tersimpan di store 'media' supaya tidak menulis ulang dataURL sama berkali-kali.
const keyByData = new Map();
let seq = 0;

function keyForDataUrl(str) {
  const cached = keyByData.get(str);
  if (cached) return cached;
  const k = `m_${Date.now().toString(36)}_${(++seq).toString(36)}`;
  keyByData.set(str, k);
  return k;
}

function isDataUrl(v) {
  return typeof v === 'string' && v.startsWith('data:image/');
}

/**
 * Simpan state proyek dengan memisahkan semua dataURL gambar ke store 'media'.
 * Jadi ketikan ringan di textarea tidak menulis ulang puluhan MB base64 gambar ke disk.
 */
export async function saveStateClean(state) {
  const clone = structuredClone(state);
  const writes = [];
  const written = new Set();
  const offload = (val) => {
    if (!isDataUrl(val)) return val;
    const k = keyForDataUrl(val);
    if (!written.has(k)) {
      written.add(k);
      writes.push([k, val]);
    }
    return { __media: k };
  };

  if (Array.isArray(clone.scenes)) {
    for (const s of clone.scenes) {
      if (isDataUrl(s.image)) s.image = offload(s.image);
      if (Array.isArray(s.alts)) s.alts = s.alts.map((a) => offload(a));
    }
  }
  if (clone.yt) {
    if (Array.isArray(clone.yt.bgs)) clone.yt.bgs = clone.yt.bgs.map((b) => offload(b));
    if (Array.isArray(clone.yt.concepts)) {
      for (const c of clone.yt.concepts) {
        if (isDataUrl(c.image)) c.image = offload(c.image);
      }
    }
  }

  if (writes.length) {
    const db = await open();
    const existingKeys = await new Promise((resolve) => {
      const t = db.transaction(MEDIA, 'readonly');
      const req = t.objectStore(MEDIA).getAllKeys();
      t.oncomplete = () => resolve(new Set(req.result || []));
      t.onerror = () => resolve(new Set());
    });
    const toWrite = writes.filter(([k]) => !existingKeys.has(k));
    if (toWrite.length) {
      await tx(MEDIA, 'readwrite', (store) => {
        for (const [k, v] of toWrite) store.put(v, k);
      });
    }
  }
  await kvSet('state', clone);
}

/**
 * Muat state proyek dan selesaikan referensi { __media: key } dari store 'media'.
 * Tetap menerima string data:image/... mentah dari proyek lama (backward-compatible).
 */
export async function loadStateHydrated() {
  const state = await kvGet('state');
  if (!state) return null;
  const resolveRef = async (v) => {
    if (v && typeof v === 'object' && typeof v.__media === 'string') {
      const data = await mediaGet(v.__media).catch(() => null);
      if (typeof data === 'string') keyByData.set(data, v.__media);
      return data || null;
    }
    return v;
  };
  if (Array.isArray(state.scenes)) {
    for (const s of state.scenes) {
      s.image = await resolveRef(s.image);
      if (Array.isArray(s.alts)) {
        s.alts = (await Promise.all(s.alts.map(resolveRef))).filter(Boolean);
      }
    }
  }
  if (state.yt) {
    if (Array.isArray(state.yt.bgs)) {
      state.yt.bgs = (await Promise.all(state.yt.bgs.map(resolveRef))).filter(Boolean);
    }
    if (Array.isArray(state.yt.concepts)) {
      for (const c of state.yt.concepts) {
        c.image = await resolveRef(c.image);
      }
    }
  }
  return state;
}
