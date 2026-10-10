/**
 * BRO-2689: rejectionReason decides whether a T1/T2 file surfaces as a silent
 * gap. 'garbage_text' = bad fetch (surfaced as rejected-unscoreable), while
 * 'not_a_review' = editorial verdict (correct absence, never surfaced).
 *
 * Audit 2026-10-06: hand-sampled 20 of the ~145-151 garbage_text files (145 at filing, 151 on rescan) whose
 * rejectionReasoning matches /not a review|promotional|.../ — 20/20 were real
 * fetch failures (error pages, nav chrome, paywall prompts, wrong newspaper
 * section). The regex matches "not a review", which garbage descriptions use
 * too, so a bulk garbage_text -> not_a_review rewrite would hide recoverable
 * gaps. This test pins both halves of the contract so neither can drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifySilentGap } = require('../../scripts/lib/t1-silent-gap.js');

const NOW = new Date('2026-10-06T12:00:00Z');
const SHOW = { id: 'trainspotting-the-musical-west-end-2026', category: 'west-end', openingDate: '2026-07-01' };

const base = {
  outletId: 'broadwayworld',
  url: 'https://www.broadwayworld.com/x',
  fullText: 'x'.repeat(2000),
  contentTier: 'complete',
  textFetchedAt: '2026-08-01T00:00:00Z',
  rejectedAt: '2026-08-02T00:00:00Z',
  rejectedBy: 'ensemble-scoreability-check',
};
const classify = (file) => classifySilentGap({ file, show: SHOW, tier: 1, outletScored: false, now: NOW });

// Note: the gap is driven by rejectedAt + a reason code that is NOT in
// EDITORIAL_REJECTIONS; the classifier never names garbage_text explicitly.
test('garbage_text rejection (error page / nav chrome) still surfaces as a gap', () => {
  const gap = classify({
    ...base,
    rejectionReason: 'garbage_text',
    rejectionReasoning: 'claude: This is a website error page, not a review of Evita.',
  });
  assert.equal(gap && gap.type, 'rejected-unscoreable');
  assert.equal(gap.recoverable, false);
});

test('not_a_review rejection (promo/casting content, BRO-71 trainspotting shape) is a correct absence', () => {
  assert.equal(classify({
    ...base,
    rejectionReason: 'not_a_review',
    rejectionReasoning: 'promotional content, casting updates, and plot summary with no evaluative review',
  }), null);
});

test('the classifier keys on rejectionReason, not on reasoning prose', () => {
  // Same "not a review" wording, different reason code: the code wins. If
  // someone makes the classifier regex the prose, garbage pages go silent.
  const prose = 'This is navigation text, not a review.';
  assert.equal(classify({ ...base, rejectionReason: 'garbage_text', rejectionReasoning: prose })?.type, 'rejected-unscoreable');
  assert.equal(classify({ ...base, rejectionReason: 'not_a_review', rejectionReasoning: prose }), null);
});
