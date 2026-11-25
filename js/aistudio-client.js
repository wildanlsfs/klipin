// Klien otomasi Google AI Studio (aistudio.google.com/generate-speech) untuk suara TTS gratis otomatis.
import { AI_STUDIO_TTS_URL } from './data.js';
import * as audioLib from './audio.js';
import { chunkText } from './llm.js';

const isAiStudioUrl = (u = '') => /^https:\/\/aistudio\.google\.com\//i.test(u);

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

async function ensureAiStudioTab(onStatus) {
  const tabs = (await chrome.tabs.query({})).filter((t) => isAiStudioUrl(t.url || t.pendingUrl));
  let tab = tabs.find((t) => /generate-speech/i.test(t.url || '')) || tabs[0] || null;
  if (!tab) {
    onStatus?.('Membuka Google AI Studio…');
    tab = await chrome.tabs.create({ url: AI_STUDIO_TTS_URL, active: true });
    await waitTabComplete(tab.id);
    await new Promise((r) => setTimeout(r, 1500));
  } else {
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (!/generate-speech/i.test(tab.url || '')) {
      onStatus?.('Mengarahkan ke halaman Generate Speech…');
      await chrome.tabs.update(tab.id, { url: AI_STUDIO_TTS_URL });
      await waitTabComplete(tab.id);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  let ping = await chrome.tabs.sendMessage(tab.id, { type: 'KLIPIN_AISTUDIO_PING' }).catch(() => null);
  if (!ping) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/aistudio.js'] }).catch(() => {});
    ping = await chrome.tabs.sendMessage(tab.id, { type: 'KLIPIN_AISTUDIO_PING' }).catch(() => null);
  }
  if (!ping) throw new Error('Tidak bisa terhubung ke tab Google AI Studio — coba muat ulang tab tersebut.');
  if (ping.needsLogin) throw new Error('Belum login ke Google AI Studio — silakan login di tab AI Studio lalu ulangi.');
  return tab;
}

async function decodeBase64Audio(base64, mimeType = 'audio/wav') {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = /mp3|mpeg/i.test(mimeType) ? 'mp3' : /ogg/i.test(mimeType) ? 'ogg' : 'wav';
  return audioLib.decodeFile(new File([bytes], `aistudio.${ext}`, { type: mimeType }));
}

async function waitLatestAudioDownload(startedAt, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await chrome.downloads.search({ startedAfter: new Date(startedAt - 2000).toISOString(), orderBy: ['-startTime'], limit: 5 });
    const hit = items.find((d) => d.state === 'complete' && /\.(wav|mp3|m4a|ogg|webm)$/i.test(d.filename || ''));
    if (hit) {
      const res = await fetch(`file://${hit.filename}`);
      const blob = await res.blob();
      return audioLib.decodeFile(new File([blob], 'aistudio.wav'));
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('Audio hasil download dari AI Studio tidak ditemukan.');
}

/**
 * Buat voiceover otomatis gratis lewat tab Google AI Studio di Chrome.
 * Mengembalikan { samples: Float32Array mono, sampleRate }.
 */
export async function synthesizeViaAiStudio({ script, styleInstr = '', voice = '', onProgress, signal }) {
  if (!script?.trim()) throw new Error('Naskah masih kosong.');
  const tab = await ensureAiStudioTab((msg) => onProgress?.(0, 1, msg));
  const parts = chunkText(script.trim(), 2400);
  const decoded = [];

  for (let i = 0; i < parts.length; i++) {
    if (signal?.aborted) throw new DOMException('Pembuatan suara dibatalkan', 'AbortError');
    onProgress?.(i, parts.length, `Membuat suara di AI Studio (${i + 1}/${parts.length})…`);
    const startedAt = Date.now();
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: 'KLIPIN_AISTUDIO_SPEECH',
      script: parts[i],
      styleInstr,
      voice,
      timeoutMs: 120000,
    }).catch((e) => ({ ok: false, error: e.message }));

    if (!res?.ok) {
      throw new Error(res?.error || 'Google AI Studio gagal membuat suara.');
    }
    let chunkAudio;
    if (res.base64) {
      chunkAudio = await decodeBase64Audio(res.base64, res.mimeType);
    } else if (res.viaDownload) {
      chunkAudio = await waitLatestAudioDownload(startedAt);
    } else {
      throw new Error('AI Studio tidak mengembalikan data audio.');
    }
    decoded.push(chunkAudio);
  }
  onProgress?.(parts.length, parts.length, 'Suara AI Studio selesai ✓');

  const sampleRate = decoded[0].sampleRate;
  const normalized = await Promise.all(decoded.map((a) => audioLib.resample(a, sampleRate)));
  const total = normalized.reduce((n, a) => n + a.samples.length, 0);
  const samples = new Float32Array(total);
  let off = 0;
  for (const a of normalized) {
    samples.set(a.samples, off);
    off += a.samples.length;
  }
  return { samples, sampleRate };
}
