import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FORMATS, VISUAL_STYLES, VISUAL_STYLE_CATS, STYLE_PREVIEW_SUBJECT, VOICES } from '../js/data.js';
import { cleanScript, parseJSON, compactRules, rulesFor, scriptRules, targetWords, normalizeCreativeBrief, OPENAI_VOICES, parseVoicesPayload, englishPromptGuide } from '../js/llm.js';

test('cleanScript strips markdown headings and formatting without dropping lines starting with * or **', () => {
  const raw = '# Judul Video\n**Fakta pertama** terjadi di Jakarta.\n*Catatan penting* tetap harus dibaca narator.\n- Poin daftar';
  const cleaned = cleanScript(raw);
  assert.equal(cleaned.includes('Judul Video'), false);
  assert.ok(cleaned.includes('Fakta pertama terjadi di Jakarta.'));
  assert.ok(cleaned.includes('Catatan penting tetap harus dibaca narator.'));
  assert.ok(cleaned.includes('Poin daftar'));
});

test('targetWords respects format shortWords for rantai 1-minute Shorts', () => {
  const rantai = FORMATS.find((f) => f.id === 'rantai');
  assert.equal(targetWords(rantai, 1, 150), 125);
  assert.equal(targetWords(rantai, 5, 150), 750);
  const explainer = FORMATS.find((f) => f.id === 'explainer');
  assert.equal(targetWords(explainer, 1, 150), 150);
});

test('scriptRules toggles loop vs commentEnd properly for Shorts', () => {
  const settings = { rules: {} };
  const noLoop = scriptRules(settings, 1, false, []).map((r) => r.id);
  const withLoop = scriptRules(settings, 1, true, []).map((r) => r.id);
  assert.ok(noLoop.includes('commentEnd'));
  assert.equal(noLoop.includes('loop'), false);
  assert.ok(withLoop.includes('loop'));
  assert.equal(withLoop.includes('commentEnd'), false);
});

test('compactRules preserves only user overrides and round-trips through rulesFor', () => {
  const list = rulesFor({}, 'script');
  list[0].on = false;
  list.push({ id: 'u_custom', label: 'Aturan Saya', text: 'Selalu pakai contoh nyata.', on: true, builtin: false });
  const compacted = compactRules('script', list);
  assert.equal(compacted.length, 2);
  const restored = rulesFor({ rules: { script: compacted } }, 'script');
  assert.equal(restored[0].on, false);
  assert.ok(restored.some((r) => r.id === 'u_custom' && r.text === 'Selalu pakai contoh nyata.'));
});

test('parseJSON parses fenced and noisy LLM JSON output', () => {
  const parsed = parseJSON('Berikut hasilnya:\n```json\n{"titles":["A","B"]}\n```');
  assert.deepEqual(parsed, { titles: ['A', 'B'] });
});

test('VISUAL_STYLES has 20 styles with valid categories, prompts, and .jpg preview paths', () => {
  assert.equal(VISUAL_STYLES.length, 20);
  assert.ok(STYLE_PREVIEW_SUBJECT.length > 20);
  const validCats = new Set(VISUAL_STYLE_CATS.map((c) => c.id));
  for (const v of VISUAL_STYLES) {
    assert.ok(validCats.has(v.cat), `Invalid cat for ${v.id}`);
    assert.ok(v.prompt && v.guide && v.bestFor);
    assert.equal(v.preview, `assets/styles/${v.id}.jpg`);
    const fileUrl = new URL(`../${v.preview}`, import.meta.url);
    if (fs.existsSync(fileUrl)) {
      const buf = fs.readFileSync(fileUrl);
      assert.ok(buf.length > 1000, `JPG too small: ${v.preview}`);
      assert.equal(buf[0], 0xff);
      assert.equal(buf[1], 0xd8);
    }
  }
});

test('normalizeCreativeBrief validates IDs, provides safe fallbacks, and enforces loop=false for long videos', () => {
  const shortValid = normalizeCreativeBrief({
    format: 'explainer',
    narration_style: 'santai',
    visual_style: 'kurzgesagt',
    loop: true,
    voice: 'puck',
    reason: 'Cocok untuk explainer cepat.',
  }, { minutes: 1 });
  assert.equal(shortValid.format, 'explainer');
  assert.equal(shortValid.narrStyle, 'santai');
  assert.equal(shortValid.visualStyle, 'kurzgesagt');
  assert.equal(shortValid.loop, true);
  assert.equal(shortValid.voice, 'Puck');

  const longInvalid = normalizeCreativeBrief({
    format: 'tidak_ada',
    narration_style: 'ngasal',
    visual_style: 'invalid',
    loop: true,
    voice: 'nobody',
  }, { minutes: 5 });
  assert.equal(longInvalid.format, FORMATS[0].id);
  assert.equal(longInvalid.visualStyle, VISUAL_STYLES[0].id);
  assert.equal(longInvalid.loop, false);
});

test('VOICES has all 30 Gemini voices and OPENAI_VOICES has 13 voices incl. marin & cedar', () => {
  assert.equal(VOICES.length, 30);
  for (const name of ['Achird', 'Callirrhoe', 'Vindemiatrix', 'Zubenelgenubi', 'Charon', 'Sulafat']) {
    assert.ok(VOICES.some((v) => v.name === name), `Missing Gemini voice ${name}`);
  }
  assert.equal(OPENAI_VOICES.length, 13);
  assert.ok(OPENAI_VOICES.some((v) => v.id === 'marin'));
  assert.ok(OPENAI_VOICES.some((v) => v.id === 'cedar'));
});

test('parseVoicesPayload handles Gemini /v1beta/voices, OpenAI-compat payloads, dedupe, and fallback', () => {
  const geminiFb = VOICES.map((v) => ({ ...v, id: v.name }));
  const gem = parseVoicesPayload({
    voices: [
      { name: 'voices/Charon', displayName: 'Charon', gender: 'male' },
      { voice_id: 'voice_custom_99', display_name: 'My Cloned Voice', type: 'prompted', persona: 'Warm narrator', gender: 'female' },
    ],
  }, geminiFb);
  assert.equal(gem[0].id, 'Charon');
  assert.equal(gem[0].desc, 'Informatif, dalam — cocok dokumenter');
  assert.equal(gem[1].id, 'voice_custom_99');
  assert.equal(gem[1].gender, 'P');
  assert.ok(gem[1].desc.includes('Warm narrator'));
  assert.equal(gem.length, 31);

  const compatObj = parseVoicesPayload({ data: [{ id: 'marin' }, { id: 'kokoro_af', name: 'Kokoro AF', gender: 'female', description: 'Crisp' }] }, OPENAI_VOICES);
  assert.equal(compatObj[0].name, 'Marin');
  assert.equal(compatObj[0].gender, 'P');
  assert.equal(compatObj[1].id, 'kokoro_af');
  assert.equal(compatObj.length, 14);

  const strArr = parseVoicesPayload(['alloy', 'custom_new'], [], { mergeFallback: false });
  assert.deepEqual(strArr.map((x) => x.id), ['alloy', 'custom_new']);

  const emptyFb = parseVoicesPayload({}, OPENAI_VOICES);
  assert.equal(emptyFb.length, 13);
});

test('englishPromptGuide returns empty for id and idiomatic global $ examples for en', () => {
  assert.equal(englishPromptGuide('script', 'id'), '');
  for (const kind of ['script', 'title', 'hook', 'callout', 'youtube']) {
    const g = englishPromptGuide(kind, 'en');
    assert.ok(g.length > 20, `Empty englishPromptGuide for ${kind}`);
    assert.ok(g.includes('$'), `Expected global $ example in ${kind}`);
    assert.equal(/\bRp\d/i.test(g), false, `Unexpected Rp example in ${kind}`);
  }
});
