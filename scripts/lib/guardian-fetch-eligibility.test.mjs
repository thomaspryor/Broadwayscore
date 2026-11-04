import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { guardianFetchEligibility, hasRecordedRating } = require('./guardian-fetch-eligibility.js');

const TEXT = 'x'.repeat(900);
const URL_ = 'https://www.theguardian.com/stage/2026/oct/21/860-review-billy-crystal-one-man-play';

test('BRO-6964: text but no rating is eligible for a rating-only API call (Billy Crystal 860 shape)', () => {
  const r = guardianFetchEligibility({ fullText: TEXT, url: URL_, originalScore: null }, { minTextLength: 500 });
  assert.deepEqual(r, { eligible: true, mode: 'rating-only' });
});

test('text and a recorded rating is skipped', () => {
  for (const f of [{ originalScore: '3/5 stars' }, { originalRating: '3/5' }, { starRating: 3 }]) {
    const r = guardianFetchEligibility({ fullText: TEXT, url: URL_, ...f }, { minTextLength: 500 });
    assert.equal(r.eligible, false, JSON.stringify(f));
  }
});

test('no text with a url fetches the text; no url is never eligible', () => {
  assert.deepEqual(guardianFetchEligibility({ url: URL_ }, { minTextLength: 500 }), { eligible: true, mode: 'fetch-text' });
  assert.equal(guardianFetchEligibility({ fullText: TEXT }, { minTextLength: 500 }).eligible, false);
});

test('hasRecordedRating treats empty string and null as missing', () => {
  assert.equal(hasRecordedRating({ originalScore: '' , originalRating: null }), false);
  assert.equal(hasRecordedRating({ originalScore: '3/5 stars' }), true);
});

test('BRO-6964: a late star on an llm-v6 file queues the anchored rescore; a human-scored file is left alone', () => {
  const { queueRescoreForLateRating } = require('./rescore-flagging.js');
  const llm = { scoreSource: 'llm-v6', assignedScore: 77 };
  assert.equal(queueRescoreForLateRating(llm, 'guardian-api'), true);
  assert.equal(llm.needsRescore, true);
  assert.match(llm.rescoreReason, /guardian-api/);
  const human = { scoreSource: 'human-review', assignedScore: 60 };
  assert.equal(queueRescoreForLateRating(human, 'guardian-api'), false);
  assert.equal(human.needsRescore, undefined);
});
