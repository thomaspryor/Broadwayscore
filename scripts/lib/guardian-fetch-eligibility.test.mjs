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

test('excluded rows and api-has-no-star rows are not fetched again (BRO-6964 review)', () => {
  const text = 'x'.repeat(500);
  assert.equal(guardianFetchEligibility({ fullText: text, url: 'u', wrongProduction: true }).eligible, false);
  assert.equal(guardianFetchEligibility({ fullText: text, url: 'u', wrongShow: true }).eligible, false);
  assert.equal(guardianFetchEligibility({ fullText: text, url: 'u', duplicateOf: 'a.json' }).eligible, false);
  const r = guardianFetchEligibility({ fullText: text, url: URL_, guardianApi: { fetchedAt: '2026-01-01', starRating: null } });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'api-has-no-star');
});

test('queueRescoreForLateRating leaves human-review rows alone', () => {
  const { queueRescoreForLateRating } = require('./rescore-flagging.js');
  assert.equal(queueRescoreForLateRating({ scoreSource: 'llm-v6', humanReviewScore: 62 }, 'x'), false);
});

// BRO-7446: msblackforpresident's dateless serp-discovery stub 404'd every run and failed the workflow.
const { isDatedGuardianArticleUrl, shouldFailRun } = require('./guardian-fetch-eligibility.js');

test('BRO-7446: dateless Guardian stub URL is never eligible', () => {
  const stub = 'https://www.theguardian.com/stage/2026/nov/ms-blakk-for-president-play';
  assert.deepEqual(guardianFetchEligibility({ url: stub }, { minTextLength: 500 }), { eligible: false, reason: 'undated-url' });
  assert.equal(isDatedGuardianArticleUrl(stub), false);
  assert.equal(isDatedGuardianArticleUrl('https://www.theguardian.com/stage/2026/nov/05/ms-blakk-for-president-play'), true);
});

test('BRO-7446: only 404s with nothing fetched does not fail the run; real failures still do', () => {
  assert.equal(shouldFailRun({ fetched: 0, failed: 1, notFound: 1 }), false);
  assert.equal(shouldFailRun({ fetched: 0, failed: 2, notFound: 1 }), true);
  assert.equal(shouldFailRun({ fetched: 1, failed: 3, notFound: 0 }), false);
});
