// BRO-4141: an approved submission that only lacks an LLM score is a wait,
// not a failure. All 11 "approved review submission #N is not on the site"
// owner emails of 9/23-9/24 were this case; each went live on its own once
// llm-ensemble-score scored it ~45 min later.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkSubmissionLanded } = require('./submission-landing.js');

const SHOW = { id: 'deep-heat-rivalry-off-west-end-2026', status: 'open', openingDate: '2026-09-17', market: 'west-end' };
const URL = 'https://www.thereviewshub.com/deep-heat-rivalry-the-other-palace/';

function fixture(review) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-landing-'));
  fs.mkdirSync(path.join(dir, SHOW.id));
  fs.writeFileSync(path.join(dir, SHOW.id, 'thereviewshub--the-reviews-hub.json'), JSON.stringify({
    showId: SHOW.id, outlet: 'The Reviews Hub', outletId: 'thereviewshub', criticName: 'Jo Critic',
    url: URL, publishDate: '2026-09-17', contentTier: 'complete', fullText: 'x'.repeat(2000),
    source: 'submit-review-form', ...review,
  }));
  return dir;
}

test('in reviews.json by URL: landed', () => {
  const dir = fixture({ llmScore: { score: 78 } });
  const r = checkSubmissionLanded({ showId: SHOW.id, url: URL, reviews: [{ showId: SHOW.id, url: URL }], reviewTextsDir: dir, show: SHOW });
  assert.equal(r.landed, true);
});

test('unscored and otherwise includable: pendingScore, not a failure', () => {
  const dir = fixture({});
  const r = checkSubmissionLanded({ showId: SHOW.id, url: URL, reviews: [], reviewTextsDir: dir, show: SHOW });
  assert.equal(r.landed, false);
  assert.equal(r.pendingScore, true);
  assert.match(r.reason, /not scored yet/);
});

test('scored but still missing from reviews.json: a real miss, not pending', () => {
  const dir = fixture({ llmScore: { score: 78 } });
  const r = checkSubmissionLanded({ showId: SHOW.id, url: URL, reviews: [], reviewTextsDir: dir, show: SHOW });
  assert.equal(r.landed, false);
  assert.ok(!r.pendingScore);
});

test('unscored but blocked by a past text-gate failure: a real miss, not pending', () => {
  const dir = fixture({ fullText: 'Subscribe to read the full review.', contentTier: 'stub' });
  const r = checkSubmissionLanded({ showId: SHOW.id, url: URL, reviews: [], reviewTextsDir: dir, show: SHOW });
  assert.equal(r.landed, false);
  assert.ok(!r.pendingScore, `a file the scorer will skip must not be pending: ${r.reason}`);
});

test('an assignedScore counts as scored', () => {
  const dir = fixture({ assignedScore: 80 });
  const r = checkSubmissionLanded({ showId: SHOW.id, url: URL, reviews: [], reviewTextsDir: dir, show: SHOW });
  assert.ok(!r.pendingScore);
});

test('awaiting-score sweep: landed closes, stuck escalates, fresh waits', () => {
  const { decideAwaitingSubmission, AWAITING_SCORE_MAX_HOURS } = require('./submission-landing.js');
  assert.equal(decideAwaitingSubmission({ landed: true, ageHours: 1 }), 'close');
  assert.equal(decideAwaitingSubmission({ landed: true, ageHours: 999 }), 'close');
  assert.equal(decideAwaitingSubmission({ landed: false, ageHours: 2 }), 'wait');
  assert.equal(decideAwaitingSubmission({ landed: false, ageHours: AWAITING_SCORE_MAX_HOURS }), 'escalate');
});

test('findShowForSubmission locates the show by the submitted URL', () => {
  const { findShowForSubmission } = require('./submission-landing.js');
  const dir = fixture({});
  assert.equal(findShowForSubmission(URL, [{ id: 'other-show' }, SHOW], dir).id, SHOW.id);
  assert.equal(findShowForSubmission('https://example.com/nope', [SHOW], dir), null);
});

test('an excluded review keeps its exclusion reason even when unscored', () => {
  const dir = fixture({ wrongShow: true, wrongShowReason: 'test' });
  const r = checkSubmissionLanded({ showId: SHOW.id, url: URL, reviews: [], reviewTextsDir: dir, show: SHOW });
  assert.equal(r.landed, false);
  assert.ok(!r.pendingScore, `expected a real exclusion, got: ${r.reason}`);
});
