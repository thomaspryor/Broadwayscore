import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clearWrongProductionFlags } = require('./wrong-production-clear.js');

test('clears top-level wrongProduction/wrongShow fields', () => {
  const data = {
    wrongProduction: true,
    wrongProductionReason: 'stale',
    wrongProductionNote: 'old note',
    wrongShow: true,
    wrongShowReason: 'stale show',
  };
  clearWrongProductionFlags(data, { source: 'test-script.js' });
  assert.equal(data.wrongProduction, undefined);
  assert.equal(data.wrongProductionReason, undefined);
  assert.equal(data.wrongProductionNote, undefined);
  assert.equal(data.wrongShow, undefined);
  assert.equal(data.wrongShowReason, undefined);
});

test('corrects the embedded contentVerification sub-object so rebuild cannot re-promote it', () => {
  const data = {
    wrongProduction: true,
    contentVerification: {
      isValid: false,
      wrongProduction: true,
      wrongArticle: false,
      isFilmTv: false,
      reasoning: 'original LLM verdict: wrong theater',
    },
  };
  clearWrongProductionFlags(data, { source: 'test-script.js', reason: 'confirmed correct venue' });
  assert.equal(data.contentVerification.isValid, true);
  assert.equal(data.contentVerification.wrongProduction, false);
  assert.equal(data.contentVerification.wrongArticle, false);
  assert.equal(data.contentVerification.isFilmTv, false);
  assert.match(data.contentVerification.reasoning, /Superseded by test-script\.js/);
  assert.match(data.contentVerification.reasoning, /confirmed correct venue/);
});

test('leaves contentVerification untouched when absent (no crash, no fabricated sub-object)', () => {
  const data = { wrongProduction: true };
  clearWrongProductionFlags(data, { source: 'test-script.js' });
  assert.equal(data.contentVerification, undefined);
});

test('reclassifies a stale contentTier:"invalid" using the real classifyContentTier (complete when fullText present)', () => {
  const data = {
    wrongProduction: true,
    contentTier: 'invalid',
    incompleteReason: 'wrong_content',
    fullText: Array(80).fill('This is a genuine review sentence about the production.').join(' '),
  };
  clearWrongProductionFlags(data, { source: 'test-script.js' });
  assert.equal(data.contentTier, 'complete');
  assert.equal(data.incompleteReason, undefined);
});

test('reclassifies a stale contentTier:"invalid" to excerpt when only an excerpt is present', () => {
  const data = {
    wrongProduction: true,
    contentTier: 'invalid',
    incompleteReason: 'wrong_content',
    bwwExcerpt: 'Short excerpt text.',
  };
  clearWrongProductionFlags(data, { source: 'test-script.js' });
  assert.equal(data.contentTier, 'excerpt');
});

test('reclassifies a stale contentTier:"invalid" to stub when no text at all is present', () => {
  const data = {
    wrongProduction: true,
    contentTier: 'invalid',
  };
  clearWrongProductionFlags(data, { source: 'test-script.js' });
  assert.equal(data.contentTier, 'stub');
});

test('does not touch contentTier when it was not "invalid"', () => {
  const data = { wrongProduction: true, contentTier: 'complete', fullText: 'x'.repeat(300) };
  clearWrongProductionFlags(data, { source: 'test-script.js' });
  assert.equal(data.contentTier, 'complete');
});

test('stamps wrongProductionOverride audit fields with the calling script as source', () => {
  const data = { wrongProduction: true };
  clearWrongProductionFlags(data, { source: 'unflag-wrong-production-fps.js', reason: 'tour review correctly excluded already' });
  assert.equal(data.wrongProductionOverride, true);
  assert.match(data.wrongProductionOverrideReason, /^unflag-wrong-production-fps\.js/);
  assert.match(data.wrongProductionOverrideReason, /tour review correctly excluded already/);
  assert.equal(data.wrongProductionOverrideSetBy, 'unflag-wrong-production-fps.js');
  assert.ok(!Number.isNaN(Date.parse(data.wrongProductionOverrideSetAt)));
});

test('never sets humanReviewedWrongProduction — that field is reserved for actual human review', () => {
  const data = { wrongProduction: true };
  clearWrongProductionFlags(data, { source: 'test-script.js' });
  assert.equal(data.humanReviewedWrongProduction, undefined);
});

test('throws when source is omitted (audit trail must always identify the caller)', () => {
  assert.throws(() => clearWrongProductionFlags({ wrongProduction: true }, {}));
  assert.throws(() => clearWrongProductionFlags({ wrongProduction: true }));
});

test('returns the same object for chaining', () => {
  const data = { wrongProduction: true };
  const result = clearWrongProductionFlags(data, { source: 'test-script.js' });
  assert.strictEqual(result, data);
});

test('wrongShowOnly: leaves top-level wrongProduction untouched, only clears wrongShow', () => {
  const data = {
    wrongProduction: true,
    wrongProductionReason: 'genuinely a different production',
    wrongShow: true,
    wrongShowReason: 'stale show mismatch',
  };
  clearWrongProductionFlags(data, { source: 'test-script.js', wrongShowOnly: true });
  assert.equal(data.wrongProduction, true);
  assert.equal(data.wrongProductionReason, 'genuinely a different production');
  assert.equal(data.wrongShow, undefined);
  assert.equal(data.wrongShowReason, undefined);
});

test('wrongShowOnly: leaves contentVerification.wrongProduction untouched but corrects wrongArticle/isFilmTv/isValid', () => {
  const data = {
    wrongShow: true,
    contentVerification: {
      isValid: false,
      wrongProduction: true,
      wrongArticle: true,
      isFilmTv: false,
      reasoning: 'original LLM verdict: different show',
    },
  };
  clearWrongProductionFlags(data, { source: 'test-script.js', reason: 'joint review', wrongShowOnly: true });
  assert.equal(data.contentVerification.isValid, true);
  assert.equal(data.contentVerification.wrongProduction, true, 'must stay subject to wrongProduction promotion on next rebuild');
  assert.equal(data.contentVerification.wrongArticle, false);
  assert.equal(data.contentVerification.isFilmTv, false);
});

test('wrongShowOnly: stamps wrongShowOverride, not wrongProductionOverride (no blanket wrongProduction immunity)', () => {
  const data = { wrongShow: true };
  clearWrongProductionFlags(data, { source: 'audit-review-url-clusters.js', reason: 'venue-body-matched', wrongShowOnly: true });
  assert.equal(data.wrongShowOverride, true);
  assert.match(data.wrongShowOverrideReason, /^audit-review-url-clusters\.js/);
  assert.ok(!Number.isNaN(Date.parse(data.wrongShowOverrideAt)));
  assert.equal(data.wrongProductionOverride, undefined);
  assert.equal(data.wrongProductionOverrideReason, undefined);
  assert.equal(data.wrongProductionOverrideSetAt, undefined);
  assert.equal(data.wrongProductionOverrideSetBy, undefined);
});

test('wrongShowOnly: still reclassifies a stale contentTier:"invalid"', () => {
  const data = {
    wrongShow: true,
    contentTier: 'invalid',
    incompleteReason: 'wrong_content',
    fullText: Array(80).fill('This is a genuine review sentence about the production.').join(' '),
  };
  clearWrongProductionFlags(data, { source: 'test-script.js', wrongShowOnly: true });
  assert.equal(data.contentTier, 'complete');
  assert.equal(data.incompleteReason, undefined);
});
