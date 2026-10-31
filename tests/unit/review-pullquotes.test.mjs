import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { selectBestExcerpt } = require('../../scripts/rebuild-all-reviews.js');
const { EXCERPT_SOURCE_RANK } = require('../../scripts/lib/pull-quote-guards.js');

// BRO-767: T1/T2 reviews with assignedScore >= 70 shipped with pullQuote:null
// because three aggregator excerpt fields that ARE captured in review-texts —
// theatreReviewsExcerpt, westEndTheatreExcerpt, lboRoundupExcerpt — were never
// wired into selectBestExcerpt()'s source cascade. These tests guard the fix:
// each field must now be picked up, at a rank below the raw-fullText fallback.

test('EXCERPT_SOURCE_RANK includes the three previously-unwired aggregator fields, ranked above raw fullText', () => {
  for (const field of ['theatreReviewsExcerpt', 'westEndTheatreExcerpt', 'lboRoundupExcerpt']) {
    assert.equal(typeof EXCERPT_SOURCE_RANK[field], 'number', `${field} must have a rank`);
    assert.ok(
      EXCERPT_SOURCE_RANK[field] < EXCERPT_SOURCE_RANK.fullText,
      `${field} must rank above the raw fullText fallback`
    );
  }
});

test('selectBestExcerpt fills pullQuote from theatreReviewsExcerpt when nothing higher-priority exists', () => {
  const excerpt = selectBestExcerpt({
    showId: 'some-show-2026',
    theatreReviewsExcerpt: 'A genuinely gripping revival that finds new menace in a familiar text.',
  }, 'Some Show');
  assert.equal(excerpt, 'A genuinely gripping revival that finds new menace in a familiar text.');
});

test('selectBestExcerpt fills pullQuote from westEndTheatreExcerpt when nothing higher-priority exists', () => {
  const excerpt = selectBestExcerpt({
    showId: 'some-show-2026',
    westEndTheatreExcerpt: 'Acrobatic splendour and joy — a production that never lets its energy flag.',
  }, 'Some Show');
  assert.equal(excerpt, 'Acrobatic splendour and joy — a production that never lets its energy flag.');
});

test('selectBestExcerpt fills pullQuote from lboRoundupExcerpt when nothing higher-priority exists', () => {
  const excerpt = selectBestExcerpt({
    showId: 'some-show-2026',
    lboRoundupExcerpt: 'This co-production offers a fresh interpretation of a well-known text.',
  }, 'Some Show');
  assert.equal(excerpt, 'This co-production offers a fresh interpretation of a well-known text.');
});

test('selectBestExcerpt still prefers dtliExcerpt over the three new aggregator fields', () => {
  const excerpt = selectBestExcerpt({
    showId: 'some-show-2026',
    dtliExcerpt: 'The dtli-curated evaluative quote that should win.',
    theatreReviewsExcerpt: 'A lower-priority theatre.reviews quote that should lose.',
    westEndTheatreExcerpt: 'A lower-priority WET quote that should lose.',
    lboRoundupExcerpt: 'A lower-priority LBO quote that should lose.',
  }, 'Some Show');
  assert.equal(excerpt, 'The dtli-curated evaluative quote that should win.');
});

// The live-corpus integration check (no review missing a pullQuote has a recoverable excerpt) moved to
// tests/unit/review-pullquotes-live-data.test.mjs (BRO-5798, BRO-3425 pattern): it reads bot-rewritten data.

// BRO-5798: "recoverable" must mean "the rebuild would ship it". The rebuild rejects junk excerpts AFTER
// selectBestExcerpt(); backfill and the live-corpus check used to stop before that step and so reported
// reviews the rebuild had correctly left without a pullQuote.
const { finalizePullQuote } = require('../../scripts/rebuild-all-reviews.js');
const { recoverableQuote } = require('../../scripts/backfill-missing-pullquotes.js');

test('a quote selectBestExcerpt accepts but the rebuild discards (broken contraction) is not recoverable', () => {
  const data = {
    showId: 'some-show-2015', outletId: 'cititour',
    pullQuote: 'A thoroughly gripping production that deserves every bit of praise it gets from audiences, and the lead performance is something special because he wasn\u2019',
  };
  // The gap itself: the cascade returns it, the rebuild's last-step filter then drops it.
  assert.ok(selectBestExcerpt({ ...data }, 'Some Show'), 'fixture must get past selectBestExcerpt for this test to mean anything');
  assert.equal(finalizePullQuote({ ...data }, 'Some Show', 'closed'), null);
  assert.equal(recoverableQuote({ ...data }, 'Some Show', 'closed'), null);
});

test('recoverableQuote returns the display form the rebuild ships (wrapping quotes stripped)', () => {
  const data = {
    showId: 'some-show-2015', outletId: 'cititour',
    pullQuote: '\u201cA thoroughly gripping production that deserves every bit of praise it gets from audiences here.\u201d',
  };
  assert.equal(recoverableQuote({ ...data }, 'Some Show', 'open'),
    'A thoroughly gripping production that deserves every bit of praise it gets from audiences here.');
});

test('a clean aggregator excerpt is recoverable through the same path', () => {
  const data = {
    showId: 'some-show-2026', outletId: 'broadwayworld',
    dtliExcerpt: 'The dtli-curated evaluative quote that is long enough to ship and says the production is a triumph.',
  };
  const q = recoverableQuote(data, 'Some Show', 'open');
  assert.ok(q && q.includes('triumph'), `expected a quote, got ${q}`);
});

test('a quote cut off on a trailing comma is not shipped', () => {
  const data = {
    showId: 'some-show-2019', outletId: 'timeout-london',
    pullQuote: 'There is a lot of random wandering on and off. Even with Wilton giving it both barrels and a decent,',
  };
  assert.equal(finalizePullQuote({ ...data }, 'Some Show', 'closed'), null);
  assert.equal(recoverableQuote({ ...data }, 'Some Show', 'closed'), null);
});

test('a clean excerpt on a file the rebuild excludes is not recoverable', () => {
  const data = {
    showId: 'some-show-2019', outletId: 'timeout-london', wrongProduction: true,
    dtliExcerpt: 'The dtli-curated evaluative quote that is long enough to ship and says the production is a triumph.',
  };
  const show = { id: 'some-show-2019', title: 'Some Show', status: 'closed' };
  assert.ok(recoverableQuote({ ...data, wrongProduction: false }, 'Some Show', 'closed'), 'control: same file without the flag is recoverable');
  assert.equal(recoverableQuote({ ...data }, 'Some Show', 'closed', { show, filePath: 'x/timeout-london--a.json' }), null);
});

test('BRO-6201: changedSinceRebuildScan separates rebuild lag from a wiring gap', () => {
  const { changedSinceRebuildScan } = require('../../scripts/backfill-missing-pullquotes.js');
  const scan = '2026-10-29T00:29:43.534Z';
  // The 2026-10-29 Time Out file: text fetched before the scan, LLM-scored after it.
  assert.equal(changedSinceRebuildScan({ textFetchedAt: '2026-10-29T00:16:21.558Z', llmMetadata: { scoredAt: '2026-10-29T00:39:30.310Z' } }, scan), true);
  assert.equal(changedSinceRebuildScan({ firstSeenAt: '2026-10-29T01:00:00Z' }, scan), true);
  // Every stamp before the scan: the rebuild saw this file, so a missing quote is a real gap.
  assert.equal(changedSinceRebuildScan({ textFetchedAt: '2026-10-01T00:00:00Z', llmMetadata: { scoredAt: '2026-10-02T00:00:00Z' } }, scan), false);
  assert.equal(changedSinceRebuildScan({}, scan), false);
  // No scan stamp on reviews.json: never skip, so the check cannot go quiet.
  assert.equal(changedSinceRebuildScan({ firstSeenAt: '2099-01-01T00:00:00Z' }, undefined), false);
  assert.equal(changedSinceRebuildScan({ firstSeenAt: '2099-01-01T00:00:00Z' }, 'not a date'), false);
});
