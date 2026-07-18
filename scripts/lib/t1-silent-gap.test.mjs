import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifySilentGap, shouldAlertGap } = require('./t1-silent-gap.js');

// Fixture shapes are the two real 2026-07-18 incident files, trimmed.
const TIMES_EMPTY_STUB = {
  url: 'https://www.thetimes.com/culture/theatre-dance/article/the-oresteia-review-david-morrissey-bg8qzzhhn',
  criticName: 'Clive Davis',
  contentTier: 'excerpt',
  fullText: '',
};

const NYT_BOT_STUB_REJECTED = {
  url: 'https://www.nytimes.com/2026/07/15/theater/the-potluck-review-cesar-alvarez.html',
  criticName: 'Helen Shaw',
  contentTier: 'truncated',
  fullText: 'x'.repeat(2956),
  assignedScore: 62,
  rejectedBy: 'ensemble-scoreability-check',
  rejectedAt: '2026-07-18T06:37:19.249Z',
};

test('Times/Oresteia incident shape: empty T1 stub is a recoverable empty-body gap', () => {
  const gap = classifySilentGap({ file: TIMES_EMPTY_STUB, tier: 1, outletScored: false });
  assert.deepEqual(gap, { type: 'empty-body', recoverable: true });
});

test('NYT/Potluck incident shape: rejected bot-stub is a gap even with an assignedScore', () => {
  const gap = classifySilentGap({ file: NYT_BOT_STUB_REJECTED, tier: 1, outletScored: false });
  assert.deepEqual(gap, { type: 'rejected-unscoreable', recoverable: false });
});

test('content present but scoring pipeline never ran → unscored', () => {
  const gap = classifySilentGap({
    file: { url: 'https://x', fullText: 'y'.repeat(1000), contentTier: 'complete' },
    tier: 2, outletScored: false,
  });
  assert.deepEqual(gap, { type: 'unscored', recoverable: false });
});

test('tier 3+ outlets are never a silent gap', () => {
  assert.equal(classifySilentGap({ file: TIMES_EMPTY_STUB, tier: 3, outletScored: false }), null);
});

test('outlet already scored (sibling file or reviews.json) → no gap (financialtimes--unknown case)', () => {
  assert.equal(classifySilentGap({ file: TIMES_EMPTY_STUB, tier: 1, outletScored: true }), null);
});

test('legitimate exclusions are not gaps', () => {
  for (const excl of [
    { wrongProduction: true },
    { wrongShow: true },
    { isNonReview: true },
    { isRoundupArticle: true },
    { duplicateOf: 'whatsonstage--matt-trueman.json' },
    { duplicateTextOf: 'a.json' },
    { rejectionReason: 'not_a_review' },
    { humanReviewScore: 80 },
  ]) {
    assert.equal(
      classifySilentGap({ file: { ...TIMES_EMPTY_STUB, ...excl }, tier: 1, outletScored: false }),
      null, `expected null for ${JSON.stringify(excl)}`);
  }
});

test('scored + unrejected file is not a gap (rebuild lag is not escalated)', () => {
  const gap = classifySilentGap({
    file: { url: 'https://x', fullText: 'y'.repeat(5000), llmScore: { score: 39 }, assignedScore: 39 },
    tier: 1, outletScored: false,
  });
  assert.equal(gap, null);
});

test('empty-body over the retry cap stays a gap but is no longer recoverable', () => {
  const gap = classifySilentGap({
    file: { ...TIMES_EMPTY_STUB, aggUrlRecoveryCount: 3 },
    tier: 1, outletScored: false,
  });
  assert.deepEqual(gap, { type: 'empty-body', recoverable: false });
});

test('alert dedupe: never-alerted fires, recent alert suppresses, 8-day-old re-fires', () => {
  const now = new Date('2026-07-18T12:00:00Z');
  assert.equal(shouldAlertGap(null, now), true);
  assert.equal(shouldAlertGap('2026-07-17T12:00:00Z', now), false);
  assert.equal(shouldAlertGap('2026-07-10T11:00:00Z', now), true);
  assert.equal(shouldAlertGap('garbage', now), true);
});
