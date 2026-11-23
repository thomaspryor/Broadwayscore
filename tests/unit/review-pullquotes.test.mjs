// LIVE-DATA-LANE: reads data/critic-registry.json (untracked core data); data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
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

// BRO-6439: the rebuild runs applyScoreRelevantMigrations (garbageFullText -> fullText recovery) before
// finalizePullQuote. recoverableQuote skipped that step, so it judged a different file than the rebuild did
// (aladdin-2014/ap: called "recoverable" what the rebuild shipped with no quote). Both directions must agree.
test('BRO-6439: recoverableQuote sees the same garbageFullText recovery the rebuild applies first', () => {
  const { applyScoreRelevantMigrations } = require('../../scripts/lib/rebuild-helpers');
  const body = 'The revival is a thoroughly gripping production that deserves every bit of praise it gets from audiences. '
    + 'The lead performance is something special, and the director keeps the evening moving at a confident clip. '
    + 'The design is handsome without ever upstaging the actors, and the second act lands with real force.';
  const data = { showId: 'some-show-2014', outletId: 'ap', criticName: 'A Critic', fullText: null, garbageFullText: body };
  const migrated = { ...data };
  assert.equal(applyScoreRelevantMigrations(migrated).garbageRecovered, true, 'fixture must exercise the recovery');
  const rebuildShips = finalizePullQuote(migrated, 'Some Show', 'open');
  assert.ok(rebuildShips, 'fixture: the rebuild ships a quote from the recovered text');
  // BRO-7505: finalizePullQuote itself applies the migrations, so an un-migrated file gets the rebuild's answer.
  assert.equal(finalizePullQuote({ ...data }, 'Some Show', 'open'), rebuildShips);
  assert.equal(recoverableQuote({ ...data }, 'Some Show', 'open'), rebuildShips);
  // Never mutates the caller's file object (the backfill writes reviews.json, never review-texts).
  const input = { ...data };
  recoverableQuote(input, 'Some Show', 'open');
  assert.equal(input.fullText, null);
  // An error-page garbage body is never recovered, so there is nothing to quote either way.
  assert.equal(recoverableQuote({ ...data, garbageReason: 'Error/404 page' }, 'Some Show', 'open'), null);
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

// BRO-7127: garbageFullText quarantined as another show's article is never recovered into fullText.
test('BRO-7127: applyScoreRelevantMigrations does not recover a "Cross-show duplicate" garbageFullText', () => {
  const { applyScoreRelevantMigrations } = require('../../scripts/lib/rebuild-helpers');
  const body = 'The revival is a thoroughly gripping production that deserves every bit of praise it gets from audiences. '
    + 'The lead performance is something special, and the director keeps the evening moving at a confident clip. '
    + 'The design is handsome without ever upstaging the actors, and the second act lands with real force.';
  const base = { showId: 'some-show-2014', outletId: 'ap', criticName: 'A Critic', fullText: null, garbageFullText: body };
  const dup = { ...base, garbageFullTextNote: 'Cross-show duplicate: fullText belongs to a different show' };
  assert.equal(applyScoreRelevantMigrations(dup).garbageRecovered, false);
  assert.equal(dup.fullText, null);
  assert.equal(finalizePullQuote(dup, 'Some Show', 'open'), null);
  for (const extra of [
    { showNotMentioned: true },
    { garbageReason: 'Wrong outlet: BroadwayNews content scraped from EW URL' },
    { garbageReason: 'TheaterMania 404 page, not a review' },
    { wrongShowReason: 'Cross-attribution: content matches another-show-1972' },
  ]) {
    const d = { ...base, ...extra };
    assert.equal(applyScoreRelevantMigrations(d).garbageRecovered, false, JSON.stringify(extra));
    assert.equal(d.fullText, null);
  }
  const other = { ...base, garbageFullTextNote: 'Truncated by scraper' };
  assert.equal(applyScoreRelevantMigrations(other).garbageRecovered, true, 'control: other garbage notes still recover');
});

// BRO-7505 class guard: recoverableQuote must be a thin wrapper over the rebuild's finalizePullQuote. Three cards
// (BRO-6117, BRO-6439, BRO-7012) were each a pre-quote rebuild step the backfill's own copy of the chain lacked.
// A pre-quote step re-implemented in the backfill fails here; add it to finalizePullQuote instead.
test('BRO-7505: backfill re-implements no pre-quote rebuild step; finalizePullQuote owns them', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/backfill-missing-pullquotes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /applyScoreRelevantMigrations|selectBestExcerpt\(/, 'backfill must call finalizePullQuote only');
  const rebuild = fs.readFileSync(new URL('../../scripts/rebuild-all-reviews.js', import.meta.url), 'utf8');
  const fn = rebuild.slice(rebuild.indexOf('function finalizePullQuote'), rebuild.indexOf('Require-as-a-library'));
  assert.match(fn, /applyScoreRelevantMigrations\(/, 'finalizePullQuote must apply the rebuild migrations');
});

// BRO-7505 review finding: the rebuild deletes a wrong-author file's fullText AFTER migrating; finalizePullQuote must not re-recover it.
test('BRO-7505: finalizePullQuote does not resurrect garbageFullText for a wrong-author file', () => {
  const body = 'The revival is a thoroughly gripping production that deserves every bit of praise it gets from audiences. '
    + 'The lead performance is something special, and the director keeps the evening moving at a confident clip. '
    + 'The design is handsome without ever upstaging the actors, and the second act lands with real force.';
  const data = { showId: 'some-show-2014', outletId: 'ap', criticName: 'A Critic', fullText: null, garbageFullText: body, fullTextWrongAuthor: true };
  assert.equal(finalizePullQuote({ ...data }, 'Some Show', 'open'), null);
});

// BRO-8105: photo credit / caption / page-header chrome inside a shipped quote. Synthetic prose, real shapes.
const { stripCaptionChrome } = require('../../scripts/lib/pull-quote-guards.js');
const BODY = ' There is precious little to admire in this staging, and the cast cannot rescue a script that never finds its footing. '
  + 'The second half repeats the first with louder music, and the design, handsome as it is, serves a story nobody asked to hear again.';

test('BRO-8105: stripCaptionChrome cuts each caption shape and leaves the prose', () => {
  const cases = [
    ['The Cast Photo by Evan Zimmerman', 'There is precious little'],
    ['Friedman Theatre (Photo credit: Matthew Murphy)', 'There is precious little'],
    ['Photo by Victoria Wai', 'There is precious little'],
    ['...Music Box Theatre. Credit: Cylla von Tiedemann/', 'There is precious little'],
    ['Broadway Review | A Show Title By Jane Doe Comments Posted on March 24, 2024.', 'There is precious little'],
  ];
  for (const [chrome, start] of cases) {
    const out = stripCaptionChrome(chrome + BODY);
    assert.ok(out.startsWith(start), `${chrome} -> ${out.slice(0, 40)}`);
    assert.doesNotMatch(out, /Photo|Credit|Posted on|Zimmerman|Tiedemann/);
  }
  // A credit deeper in the quote is removed on its own, the sentences around it stay.
  const mid = 'x'.repeat(0) + BODY.trim() + ' Photo by Evan Zimmerman The finale lands.';
  assert.doesNotMatch(stripCaptionChrome(mid), /Photo by/);
  // Prose that merely says "photo by" is untouched.
  const clean = 'He praised the photo by the window, a lovely image, in a thoroughly satisfying evening.';
  assert.equal(stripCaptionChrome(clean), clean);
});

test('BRO-8105: amNY page header + photo caption with a "/Provided" tail; a leading ellipsis alone is kept', () => {
  const raw = 'Broadway Review | ‘Some Show’ brings the circus to Broadway By Jane Doe … Comments Posted on March 24, 2024. '
    + 'Two Actors in "Some Show" on Broadway. Photo by Matthew Murphy/Provided I do not know about you, but I prefer the circus itself.';
  assert.equal(stripCaptionChrome(raw), 'I do not know about you, but I prefer the circus itself.');
  const ell = '...Some Show aspires to the kind of emotional sweep we associate with the greats.';
  assert.equal(stripCaptionChrome(ell), ell);
});

// BRO-8105: an LLM quote snapped back to its source sentence picks up the caption that precedes it
// (a non-contiguous quote snaps to its source sentence; the-moth-off-west-end-2026/london-box-office: single-line page, "...Finborough Theatre. Photo by Victoria Wai Unfortunately ...").
test('BRO-8105: a snapped llmPullQuote does not pull in the photo credit before its sentence', () => {
  const quote = 'Unfortunately what was originally a striking monologue assumes an altogether more stodgy consistency as a clunkily overwritten play of two meandering hours.';
  const fullText = 'Home Theatre News Reviews Review: A PLAY at Finborough Theatre Review: A PLAY at Finborough Theatre Jane Roe 30 October, 2026, 00:00 '
    + 'Originally commissioned for video as part of a series of monologues, the piece was partly based on conversations with a former conscript. '
    + 'The writer is also a film director and a capable teller of stories, some of which are partially assimilated here. '
    + 'A Play at Finborough Theatre. Photo by Victoria Wai ' + quote.replace('assumes an', 'assumes, in the end, an')
    + ' The cast do what they can with it, and the direction is brisk, but the evening still feels long and the closing scene arrives too late to matter.';
  const q = selectBestExcerpt({ showId: 'some-show-2026', llmPullQuote: quote, fullText, textStatus: 'complete' });
  assert.ok(q, 'fixture must produce a quote');
  assert.doesNotMatch(q, /Photo by|Victoria Wai/, q);
});

// A candidate that itself opens with the caption (the shipped bug-2026 / the-outsiders-2024 shape) is cleaned in validateExcerpt.
test('BRO-8105: a candidate that opens with a photo credit ships without it', () => {
  const prose = 'Seen first in London, the play has been staged with a restless energy that the cast sustains for two full hours. '
    + 'The writing is sharp, the design is handsome, and the second act lands with real force.';
  for (const head of ['Friedman Theatre (Photo credit: Matthew Murphy) ', 'Photo by Victoria Wai ']) {
    const q = selectBestExcerpt({ showId: 'some-show-2026', llmPullQuote: head + prose, fullText: head + prose + ' ' + prose + ' ' + prose, textStatus: 'complete' });
    assert.ok(q, 'fixture must produce a quote for ' + head);
    assert.doesNotMatch(q, /Photo|Murphy|Victoria Wai/, q);
  }
});
