import test from 'node:test';
import assert from 'node:assert/strict';
import { trimSilence, findPauses, mapPausesThroughCuts, normalizeLoudness, encodeWav } from '../js/audio.js';

function makeAudio({ sampleRate = 16000, segments }) {
  const total = segments.reduce((n, s) => n + Math.round(s.sec * sampleRate), 0);
  const samples = new Float32Array(total);
  let off = 0;
  for (const s of segments) {
    const len = Math.round(s.sec * sampleRate);
    if (s.amp > 0) {
      for (let i = 0; i < len; i++) {
        samples[off + i] = s.amp * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
      }
    }
    off += len;
  }
  return { samples, sampleRate };
}

test('trimSilence trims leading/trailing silence tighter when edgeKeepSec is 0.025 (loop mode)', () => {
  const raw = makeAudio({
    segments: [
      { sec: 0.5, amp: 0 },
      { sec: 1.0, amp: 0.3 },
      { sec: 1.0, amp: 0 },
      { sec: 1.0, amp: 0.3 },
      { sec: 0.5, amp: 0 },
    ],
  });
  const normal = trimSilence(raw, { maxPause: 0.35, edgeKeepSec: 0.15 });
  const loop = trimSilence(raw, { maxPause: 0.35, edgeKeepSec: 0.025 });
  assert.ok(loop.audio.samples.length < normal.audio.samples.length);
  assert.ok(loop.removed > normal.removed + 0.15);

  const pauses = findPauses(raw);
  assert.equal(pauses.length, 1);
  const mapped = mapPausesThroughCuts(pauses, loop.cuts);
  assert.equal(mapped.length, 1);
  assert.ok(mapped[0].dur > 0.9); // preserves original pause weight
});

test('normalizeLoudness lifts quiet audio, prevents clipping, and handles digital silence safely', () => {
  const quiet = makeAudio({ segments: [{ sec: 1.0, amp: 0.02 }] });
  const boosted = normalizeLoudness(quiet);
  const peakBoosted = boosted.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peakBoosted > 0.1 && peakBoosted <= Math.pow(10, -1 / 20) + 1e-5);

  const loud = makeAudio({ segments: [{ sec: 1.0, amp: 0.99 }] });
  const limited = normalizeLoudness(loud);
  const peakLimited = limited.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peakLimited <= Math.pow(10, -1 / 20) + 1e-5);

  const silent = makeAudio({ segments: [{ sec: 0.5, amp: 0 }] });
  const resSilent = normalizeLoudness(silent);
  assert.equal(resSilent.samples.every((x) => Number.isFinite(x) && x === 0), true);
});

test('encodeWav creates valid RIFF/WAVE header', async () => {
  const a = makeAudio({ segments: [{ sec: 0.25, amp: 0.2 }] });
  const blob = encodeWav(a);
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert.equal(String.fromCharCode(...buf.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...buf.slice(8, 12)), 'WAVE');
  assert.equal(buf.byteLength, 44 + a.samples.length * 2);
});
