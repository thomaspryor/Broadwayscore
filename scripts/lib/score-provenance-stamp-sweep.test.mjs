/**
 * BRO-6052: a page-parsed scoreProvenance stamp must survive a later aggregator
 * sweep. mergeReviews() only takes an incoming originalScore when the file has
 * none and the incoming source is not an aggregator, so a stamped file keeps the
 * outlet-read rating and its stamp. Per CLAUDE.md rule 15 this require()s the
 * real functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeReviews } = require('./review-normalization.js');
const { bodylessScoreProvenance } = require('./review-guards.js');

const SHOW = { id: 'age-is-a-feeling-off-west-end-2026', title: 'Age Is a Feeling', category: 'off-west-end' };
const stamped = () => ({
  showId: SHOW.id, outletId: 'thestage', outlet: 'The Stage', criticName: 'Natasha Tripney',
  url: 'https://www.thestage.co.uk/reviews/age-is-a-feeling-review',
  fullText: null, originalScore: 60, scoreSource: 'llm-v6', scoreProvenance: 'page-parsed',
});

test('an aggregator sweep does not replace originalScore or drop the stamp on a stamped file', () => {
  const existing = stamped();
  const incoming = { ...stamped(), scoreProvenance: undefined, originalScore: 100, scoreSource: 'show-score-stars' };
  const merged = mergeReviews(existing, incoming, {}, { show: SHOW });
  assert.equal(merged.originalScore, 60);
  assert.equal(merged.scoreProvenance, 'page-parsed');
  assert.equal(bodylessScoreProvenance(merged), 'page-parsed');
});

test('an unstamped relabelled file reads aggregator-inherited, the stamp is what fixes it', () => {
  const { scoreProvenance, ...bare } = stamped();
  assert.equal(bodylessScoreProvenance(bare), 'aggregator-inherited');
  assert.equal(bodylessScoreProvenance({ ...bare, scoreProvenance }), 'page-parsed');
});
