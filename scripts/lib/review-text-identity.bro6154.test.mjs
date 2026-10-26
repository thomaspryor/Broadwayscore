import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { mergeTheatreRecordIntoExisting, isWrongShowRejection } = createRequire(import.meta.url)('./review-text-identity.js');

const rejected = () => ({
  fullText: 'Another production reviewed at length here. '.repeat(10),
  rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'wrong_show', wrongShow: true,
  rejectionReasoning: 'x', contentTier: 'invalid', contentTierReason: 'Wrong show', llmPullQuote: 'q',
});
const fresh = (t) => ({ fullText: t, contentTier: 'complete', contentTierReason: 'Full review text from Theatre Record', textFetchedAt: '2026-10-26T00:00:00Z' });

test('BRO-6154 wrong-show rejected file takes the fresh section text, lifts the rejection and requeues', () => {
  const out = mergeTheatreRecordIntoExisting(rejected(), fresh('The right production gets its own review text. '.repeat(10)));
  assert.match(out.fullText, /^The right production/);
  for (const k of ['wrongShow', 'rejectedBy', 'rejectionReason', 'rejectionReasoning', 'llmPullQuote']) assert.equal(out[k], undefined, k);
  assert.equal(out.contentTier, 'complete');
  assert.equal(out.needsRescore, true);
  assert.match(out.fullTextTrimmed.reason, /BRO-6154/);
});

test('BRO-6154 same text re-extracted keeps the rejection; non-rejected files are untouched', () => {
  const r = rejected();
  assert.equal(mergeTheatreRecordIntoExisting(r, fresh(r.fullText)).rejectedBy, 'ensemble-scoreability-check');
  const ok = { fullText: 'Good existing text. '.repeat(20), contentTier: 'complete' };
  assert.equal(mergeTheatreRecordIntoExisting(ok, fresh('Different. '.repeat(30))).fullText, ok.fullText);
  assert.equal(isWrongShowRejection({ rejectedBy: 'other', rejectionReason: 'wrong_show' }), false);
});
