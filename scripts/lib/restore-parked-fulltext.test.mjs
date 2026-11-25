// BRO-8324: clearing a stale anticipatory flag must put the parked body back, or the
// re-admitted review is a text-less stub (35 of 68 files in the 2026-11-25 sweep).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { restoreParkedFullText } = require('./wrong-production-autoclear.js');
const body = 'x'.repeat(500);

test('restores a body parked in wrongFullText', () => {
  const d = { fullText: null, wrongFullText: body };
  assert.equal(restoreParkedFullText(d), true);
  assert.equal(d.fullText, body);
  assert.equal('wrongFullText' in d, false);
});

test('never overwrites a live fullText', () => {
  const d = { fullText: 'live', wrongFullText: body };
  assert.equal(restoreParkedFullText(d), false);
  assert.equal(d.fullText, 'live');
});

test('ignores short or missing parked text', () => {
  assert.equal(restoreParkedFullText({ fullText: null, wrongFullText: 'short' }), false);
  assert.equal(restoreParkedFullText({ fullText: null }), false);
  assert.equal(restoreParkedFullText(null), false);
});

test('keeps the body parked while a content flag is still live', () => {
  for (const flag of [{ wrongAttribution: true }, { wrongShow: true }, { wrongArticle: true }, { contentVerification: { wrongArticle: true } }]) {
    const d = { fullText: null, wrongFullText: body, ...flag };
    assert.equal(restoreParkedFullText(d), false);
    assert.equal(d.fullText, null);
  }
});

test('wiring: the prior-run / tour-leg anticipatory clear calls it too', () => {
  const src = fs.readFileSync(new URL('../rebuild-all-reviews.js', import.meta.url), 'utf8');
  const i = src.indexOf("reason === 'anticipatory_pre_opening_post'");
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 600), /restoreParkedFullText\(d, \{ keepIfCvWrongProduction: true \}\)/);
});

test('wiring: the anticipatory auto-clear in rebuild calls it', () => {
  const src = fs.readFileSync(new URL('../rebuild-all-reviews.js', import.meta.url), 'utf8');
  const i = src.indexOf('shouldAutoClearAnticipatoryGrace(d,');
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 1800), /restoreParkedFullText\(d, \{ keepIfCvWrongProduction: true \}\)/);
});

// Found by the BRO-8324 live-data check on a-christmas-carol-west-end-2026/buzznews--ken-payne.json:
// the date flag cleared, CV still said "reviews the Aurora, Illinois production", and the body was
// restored under a wrongProduction flag that a later pass re-applied.
test('anticipatory clears keep the body parked when content verification says another production', () => {
  const body = 'x'.repeat(400);
  const mk = () => ({ wrongFullText: body, contentVerification: { wrongProduction: true } });
  const a = mk();
  assert.equal(restoreParkedFullText(a, { keepIfCvWrongProduction: true }), false);
  assert.equal(a.fullText, undefined);
  assert.equal(a.wrongFullText, body);
  // the self-heal path (CV flag deliberately cleared by a carve-out) still restores by default
  const b = mk();
  assert.equal(restoreParkedFullText(b), true);
  assert.equal(b.fullText, body);
});

test('both anticipatory clear blocks in rebuild-all-reviews pass keepIfCvWrongProduction', () => {
  const src = fs.readFileSync(new URL('../rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.equal((src.match(/restoreParkedFullText\(d, \{ keepIfCvWrongProduction: true \}\)/g) || []).length, 2);
});
