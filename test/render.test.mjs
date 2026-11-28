import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTotal, padPcm, DEFAULT_TAIL_SEC } from '../js/render.js';

test('renderTotal menambah ekor setelah narasi dan membatasinya 0–5 detik', () => {
  assert.equal(renderTotal(47.98, 0), 47.98);
  assert.equal(renderTotal(47.98, DEFAULT_TAIL_SEC), 47.98 + DEFAULT_TAIL_SEC);
  assert.equal(renderTotal(10, 99), 15);
  assert.equal(renderTotal(10, -3), 10);
  assert.equal(renderTotal(10, NaN), 10);
  assert.equal(renderTotal(10), 10);
});

test('padPcm memadatkan hening sampai sepanjang video tanpa mengubah suara asli', () => {
  const pcm = Float32Array.from([0.5, -0.5, 0.25]);
  const out = padPcm(pcm, 1, 10);
  assert.equal(out.length, 10);
  assert.deepEqual([...out.slice(0, 3)], [0.5, -0.5, 0.25]);
  assert.ok([...out.slice(3)].every((v) => v === 0));
  assert.equal(padPcm(pcm, 0.1, 10), pcm);
});
