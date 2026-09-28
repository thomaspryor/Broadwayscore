/**
 * BRO-4185 C: collector-set wrongProduction flags (text quarantined in
 * wrongFullText) get the sweep's Sonnet second look. Requires the real
 * functions (CLAUDE.md §15).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  isCollectorWrongProductionCandidate,
  restoreQuarantinedText,
  stampCollectorWpRejection,
  quarantinedTextHash,
} = require('./collector-wp-release');

const show = { id: 'disgraced-2014', title: 'Disgraced', openingDate: '2014-10-23' };
const text = 'Ayad Akhtar\'s Disgraced arrives on Broadway with a ferocious dinner party. '.repeat(40);
const ctx = { inOwnWindow: () => true, isGarbage: () => false };
const base = {
  wrongProduction: true,
  wrongProductionReason: 'Collector LLM: wrong production (high) — reviews a different run',
  fullText: null,
  wrongFullText: text,
  publishDate: '2014-10-24',
};

describe('isCollectorWrongProductionCandidate', () => {
  test('matches a quarantined collector flag inside the run window', () => {
    assert.equal(isCollectorWrongProductionCandidate(base, show, ctx), true);
  });
  test('skips flags from other sources', () => {
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongProductionReason: 'CV-promoted: x' }, show, ctx), false);
  });
  test('skips reviews dated outside the run window', () => {
    assert.equal(isCollectorWrongProductionCandidate(base, show, { ...ctx, inOwnWindow: () => false }), false);
  });
  test('skips garbage captures (the consent drain handles those)', () => {
    assert.equal(isCollectorWrongProductionCandidate(base, show, { ...ctx, isGarbage: () => true }), false);
  });
  test('skips short quarantined text and unquarantined files', () => {
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongFullText: 'short' }, show, ctx), false);
    assert.equal(isCollectorWrongProductionCandidate({ ...base, fullText: text }, show, ctx), false);
  });
  test('skips operator-protected and wrongShow files', () => {
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongProductionOverride: true }, show, ctx), false);
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongProductionManualClear: true }, show, ctx), false);
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongShow: true }, show, ctx), false);
  });
  test('asks once per distinct text', () => {
    const d = { ...base };
    stampCollectorWpRejection(d, '2026-09-28T00:00:00Z');
    assert.equal(d.collectorWpReverifiedHash, quarantinedTextHash(text));
    assert.equal(isCollectorWrongProductionCandidate(d, show, ctx), false);
    assert.equal(isCollectorWrongProductionCandidate({ ...d, wrongFullText: text + ' changed' }, show, ctx), true);
  });
});

describe('restoreQuarantinedText', () => {
  test('moves the text back and reclassifies the tier', () => {
    const d = { ...base, incompleteReason: 'wrong_content', incompleteDetail: 'Collector LLM' };
    restoreQuarantinedText(d, () => ({ contentTier: 'complete', tierReason: 'Full review text', wordCount: 500 }));
    assert.equal(d.fullText, text);
    assert.equal('wrongFullText' in d, false);
    assert.equal(d.wrongArticleManualClear, true);
    assert.equal(d.incompleteReason, null);
    assert.equal(d.contentTier, 'complete');
  });
});
