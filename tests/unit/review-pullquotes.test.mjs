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

// BRO-8084: a whole review tiered "truncated" only because the page ends in a star line + run-info line (no full
// stop) shipped with no pull quote, because the selector refused to read any truncated body. Synthetic prose.
// Ship-check (Codex + Claude reviewers): the quote must never contain the trailer or a cut final sentence.
const PROSE = 'A raucous romp has opened in midtown just in time for the holidays. The writers have given themselves a satirical '
  + 'mission and the cast of six meets it with total commitment. The host, played by a riotous and charming newcomer, is the '
  + 'evening\u2019s MVP, whose overdone accent is pure delight. The audience participation is sharp and never mean-spirited. '
  + 'The design is handsome without ever upstaging the actors, and the second act lands with real force. '
  + 'The score is bright and tuneful, with two numbers that stay in the head long after the curtain call. '
  + 'The jokes land often enough that the occasional miss barely registers, and the pacing never sags. '
  + 'The lighting and costumes give the small stage a surprising sense of scale and polish. '
  + 'The ensemble is tight, the direction is brisk, and the whole evening feels confident and generous. ';
// Neutral plot filler (no evaluative words): real reviews run 450+ words, and the re-tier step refuses "Short text".
const FILLER = 'The story begins on a cold evening in the city, where a group of strangers receives an invitation by post. '
  + 'Each guest is asked to bring a single object from home, and each is told to keep its purpose secret. '
  + 'They gather in a rented hall above a shop, and a host explains the rules of the game in a long speech. '
  + 'Every round, one of the guests is sent out of the room while the others vote on a secret role. '
  + 'The first round ends quickly, and the second round introduces a new rule about who may speak and when. '
  + 'By the third round the guests have formed two camps, and the host begins to read names from a list. '
  + 'The set is a single room with a long table, a staircase and a window that looks onto a painted skyline. '
  + 'The running time is ninety minutes with no interval, and the cast of six plays all of the roles between them. '
  + 'The company moves the table, the chairs and the lamps between scenes without leaving the stage. ';
const TRAILER = '\u2605\u2605\u2605\u2605 4 stars Some Show runz at The Theatre, 1 Main Street until 31 January 2027 Tickets from \u00a320';
const TRAILER_RE = /runz at|runs at|\u2605|4 stars|until 31 January|Tickets from/;
const trailerFile = (tail, over = {}) => ({
  showId: 'some-show-2026', outletId: 'the-recs', criticName: 'A Critic', showTitle: 'Some Show',
  fullText: FILLER + PROSE + tail, textStatus: 'truncated', contentTier: 'truncated', truncationSignals: ['no_ending_punctuation'], ...over,
});

test('BRO-8084: trailer-only truncation still yields a pull quote from the body', () => {
  const q = finalizePullQuote(trailerFile(`Delightfully deranged ${TRAILER}`), 'Some Show', 'open');
  assert.ok(q && q.length > 50, `expected a quote, got ${JSON.stringify(q)}`);
  assert.doesNotMatch(q, TRAILER_RE);
});

// Plot summary with no evaluative words, so the only quotable-looking sentence is the one glued to the trailer.
const PLOT = 'The story follows a group of friends who travel to a castle in the mountains for the weekend. '.repeat(1)
  + 'On the first night they draw lots to decide who will play the host. The second scene takes place in the kitchen. '
  + 'A letter arrives that nobody expected, and the group argues about what to do with it. '
  + 'The third scene moves to the garden, where two of the friends make a bet. '
  + 'By the interval the host has been chosen and the bet has been settled. '
  + 'The second half takes place over a single dinner, and the letter is finally opened. '
  + 'The cast of six sit around a long table while the host reads the names aloud. ';
test('BRO-8084: an evaluative last phrase glued to the trailer never ships the trailer', () => {
  const glued = (tail) => ({ ...trailerFile(''), fullText: FILLER + PLOT + tail });
  for (const tail of [
    `Ultimately the result is a wonderful and moving evening ${TRAILER}`,
    `It was superb, a triumph in every scene ${TRAILER}`,
    `Ultimately a wonderful and moving evening \u2605\u2605\u2605\u2605\u2605 Some Show runs at The Theatre until 4 April 2027`,
  ]) {
    const q = finalizePullQuote(glued(tail), 'Some Show', 'open');
    if (q) assert.doesNotMatch(q, TRAILER_RE, `trailer leaked: ${q}`);
    assert.ok(!q || !/wonderful and moving evening|superb, a triumph/.test(q), `glued phrase quoted: ${q}`);
  }
});

test('BRO-8084: a glued evaluative phrase after strong prose is not quoted', () => {
  for (const tail of [
    `Ultimately the result is a wonderful and moving evening ${TRAILER}`,            // no full stop before the star line
    `It was superb, a triumph in every scene ${TRAILER}`,
    `Ultimately a wonderful and moving evening \u2605\u2605\u2605\u2605\u2605 Some Show runs at The Theatre until 4 April 2027`,
  ]) {
    const q = finalizePullQuote(trailerFile(tail), 'Some Show', 'open');
    if (q) assert.doesNotMatch(q, TRAILER_RE, `trailer leaked: ${q}`);
    assert.ok(!q || !/wonderful and moving evening|superb, a triumph/.test(q), `glued phrase quoted: ${q}`);
  }
  // a body with no full stops at all has no safe prefix: no quote, never a trailer
  assert.equal(finalizePullQuote({ ...trailerFile(''), fullText: 'a superb cast that triumphs in every scene and a score to match '.repeat(8) + TRAILER }, 'Some Show', 'open'), null);
});

test('BRO-8084: a body cut mid-sentence is not quoted from its cut end', () => {
  const q = finalizePullQuote(trailerFile('The finale is a triumph and the company is superb, and in the closing scene the director lets the staging lose its grip on the'), 'Some Show', 'open');
  if (q) assert.doesNotMatch(q, /lose its grip|triumph and the company/);
});

// finalizePullQuote re-tiers the file from its TEXT (the rebuild does the same), so a real truncation has to be real in
// the text: a paywall prompt in the body (the classifier scans the first 70%), or a body too short to be a review.
const PAYWALLED = FILLER + 'Subscribe to continue reading this review. ' + PROSE + FILLER + 'Delightfully deranged ' + TRAILER;
test('BRO-8084: a real truncation (paywall prompt / short text) ships no extracted quote', () => {
  const t = `Delightfully deranged ${TRAILER}`;
  assert.equal(finalizePullQuote(trailerFile('', { fullText: PAYWALLED }), 'Some Show', 'open'), null, 'paywall prompt in the body');
  const short = 'The cast is superb and the staging is a triumph from the first scene to the last. '.repeat(4) + t;
  assert.equal(finalizePullQuote(trailerFile('', { fullText: short, wordCount: 93 }), 'Some Show', 'open'), null, 'short text');
  assert.equal(finalizePullQuote(trailerFile(t, { contentTierReason: 'Paywall truncation: hard paywall', truncationSignals: ['paywall_or_login_prompt'], fullText: PAYWALLED }), 'Some Show', 'open'), null);
});

// BRO-8084 (ship-check, Gemini): finalizePullQuote must give the rebuild's answer for a file as STORED, i.e. run the
// same re-tier step the rebuild runs first. Otherwise backfill / the live-data test call a review recoverable that the
// rebuild then leaves quote-less (or the reverse) and the drift check reddens.
test('BRO-8084: a stored-truncated file the classifier now calls complete (known trailer) still yields a quote', () => {
  const body = FILLER + PROSE + 'Delightfully deranged.';
  const file = {
    showId: 'some-show-2026', outletId: 'guardian', criticName: 'A Critic', showTitle: 'Some Show',
    url: 'https://example.com/a', wordCount: 200,
    fullText: `${body} • At the Almeida, London, until 7 June`,
    textStatus: 'truncated', contentTier: 'truncated', truncationSignals: ['no_ending_punctuation'],
  };
  const q = finalizePullQuote({ ...file }, 'Some Show', 'open');
  assert.ok(q && q.length > 50, `expected a quote, got ${JSON.stringify(q)}`);
  assert.doesNotMatch(q, /Almeida|until 7 June/);
});

test('BRO-8084: stored trailer-only signals that the re-tier replaces with a real paywall verdict ship no quote', () => {
  const file = {
    showId: 'some-show-2026', outletId: 'the-recs', criticName: 'A Critic', showTitle: 'Some Show',
    fullText: PAYWALLED, textStatus: 'truncated', contentTier: 'truncated',
    truncationSignals: ['no_ending_punctuation'], contentTierReason: 'Missing proper ending or other signals',
  };
  assert.equal(finalizePullQuote({ ...file }, 'Some Show', 'open'), null);
});

// BRO-8084: the body steps are newly open to stored-truncated files, but they must not displace the quote such a file
// already shipped from a soft-rejected candidate (5 of 52,285 reviews changed in the real rebuild before this gate).
test('BRO-8084: a stored-truncated file keeps its soft-rejected quote instead of a new body extraction', () => {
  const soft = '(the cast of six play every role between them in a staging that is a triumph of invention and wit)'; // deferred: a whole-candidate aside
  const withSoft = trailerFile(`Delightfully deranged ${TRAILER}`, { showScoreExcerpt: soft });
  const q = finalizePullQuote(withSoft, 'Some Show', 'open');
  assert.ok(q && /^\(the cast of six/.test(q), `existing soft-rejected quote displaced: ${JSON.stringify(q)}`);
  // the same file with no soft candidate does get the body quote
  assert.ok(finalizePullQuote(trailerFile(`Delightfully deranged ${TRAILER}`), 'Some Show', 'open'));
});

// BRO-8084 (Gemini): a paywall prompt that ENDS a long preview sits in the last 30%, which the classifier does not scan.
// The classifier calls a body this long complete, so it is quotable, but only from the part before the trailer window.
test('BRO-8084: a paywall prompt ending a long preview never reaches a quote', () => {
  for (const tail of ['Subscribe to continue reading', 'Sign in to read the rest of this review', 'Continue reading']) {
    const file = trailerFile('', { fullText: FILLER + PROSE + FILLER + PROSE + ' ' + tail, url: 'https://example.com/a', wordCount: 400 });
    const q = finalizePullQuote(file, 'Some Show', 'open');
    assert.ok(!q || !/subscribe|sign in|continue reading/i.test(q), `${tail}: ${q}`);
  }
});
