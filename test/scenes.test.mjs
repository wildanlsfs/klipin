import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, alignUnits, retimeScenes, scenesFromScript, subtitleCues } from '../js/scenes.js';

test('splitSentences preserves Indonesian and English abbreviations', () => {
  const txt = 'Dr. Budi berangkat ke Jl. Sudirman No. 12 bersama Prof. Andi. R.A. Kartini menulis surat, dkk. ikut membaca. Ini kalimat kedua!';
  const sents = splitSentences(txt);
  assert.equal(sents.length, 3);
  assert.equal(sents[0], 'Dr. Budi berangkat ke Jl. Sudirman No. 12 bersama Prof. Andi.');
  assert.equal(sents[1], 'R.A. Kartini menulis surat, dkk. ikut membaca.');
  assert.equal(sents[2], 'Ini kalimat kedua!');
});

test('alignUnits snaps boundaries to real pauses and maintains monotonicity', () => {
  const pauses = [
    { start: 2.9, end: 3.3, t: 3.1, dur: 0.4 },
    { start: 6.2, end: 6.7, t: 6.45, dur: 0.5 },
  ];
  const b = alignUnits([30, 30, 30], 0, 9.5, pauses);
  assert.equal(b.length, 4);
  assert.equal(b[0], 0);
  assert.equal(b[3], 9.5);
  assert.ok(Math.abs(b[1] - 3.1) < 0.05);
  assert.ok(Math.abs(b[2] - 6.45) < 0.05);
  for (let i = 1; i < b.length; i++) assert.ok(b[i] > b[i - 1]);
});

test('scenesFromScript + retimeScenes + subtitleCues produce contiguous timings', () => {
  const script = 'Kalimat pertama singkat saja. Kalimat kedua sedikit lebih panjang, ada koma di tengahnya. Kalimat ketiga menutup cerita.';
  const pauses = [
    { start: 2.0, end: 2.4, t: 2.2, dur: 0.4 },
    { start: 6.0, end: 6.5, t: 6.25, dur: 0.5 },
  ];
  const scenes = scenesFromScript(script, 9.0, 3, pauses);
  assert.ok(scenes.length >= 2);
  assert.equal(scenes[0].start, 0);
  assert.equal(scenes.at(-1).end, 9.0);
  for (let i = 1; i < scenes.length; i++) {
    assert.equal(scenes[i].start, scenes[i - 1].end);
  }
  const cues = subtitleCues(scenes, pauses, 5);
  assert.ok(cues.length >= scenes.length);
  for (const c of cues) {
    assert.ok(c.end > c.start);
    assert.ok(c.text.split(/\s+/).length <= 7);
  }
});
