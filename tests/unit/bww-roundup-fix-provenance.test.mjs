// scripts/tests/bww-roundup-yield-provenance.test.mjs
//
// Re-armed acceptance test for card #1729 (P1: prove the BWW roundup fix
// actually recovers reviews). The card's original acceptance (`npx tsc
// --noEmit`) was vacuous — it type-checks the repo and proves nothing about
// whether the 2026-07-31 cheap-tier fix (bww-rr-discover.js) actually
// recovers reviews. This file closes the three specific claims the card
// re-armed against, and require()s the real functions throughout (CLAUDE.md
// rule 15) rather than re-implementing any of their logic here.
//
// 1. YIELD PROVENANCE — computeRoundupYield() (scripts/lib/bww-roundup-yield.js)
//    classifies each review-text record as roundup-touched / roundup-exclusive.
//    Fixtures below mirror the REAL classification captured 2026-08-17 from
//    data/review-texts/ for the three in-window shows named in the card
//    (the-saviors, cat-cohen-broad-strokes, les-miserables-arena-concert):
//    of 10 reviews the roundup ever touched across all three shows, only 2
//    (both on les-miserables: amny--matt-windman, chicagotribune--chris-jones)
//    were NEVER independently corroborated by another discovery mechanism —
//    those 2 are the fix's true unique yield. The other 8 were also found by
//    show-score-playwright / playbill-verdict / outlet-listing-poller and
//    would very likely have surfaced anyway.
//
// 2. BROADWAY REPLAY — discoverBwwRoundupUrl() (scripts/lib/bww-rr-discover.js)
//    replayed against titanique-2026, the one Broadway show with a real
//    pre-fix persisted bwwRoundupUrl (opened 2026-04-12, roundup URL
//    `Review-Roundup-TITANIQUE-Sets-Sail-on-Broadway-20260412`). Fixture
//    anchors reproduce what its BWW section/reviews.php page listing looked
//    like at the time. Asserts the fast (non-Browserbase) path still resolves
//    the correct URL — the regression direction the cost work could
//    plausibly have broken (cheap tier now runs BEFORE the paid Broadway
//    fallback, per the card's stated latency concern).
//
// 3. MISSING 4TH ROUNDUP — root-caused (not a persistence bug):
//    midnight-at-the-never-get-west-end-2026 opened 2026-07-20. Its ONLY
//    dispatch of opening-night-poller.js happened around that previews->open
//    transition (opening-night-poller.yml has `on: workflow_dispatch` only —
//    no `schedule:` trigger; it fires once per show via update-show-status.yml
//    plus optional manual runs, see assertion below), running the code AS IT
//    EXISTED THEN. The fix that let West End/off-West End shows attempt BWW
//    discovery at all — commit a76bd35ea1f, 2026-08-02T14:25:30-04:00 — landed
//    13 days after that dispatch. Before it, opening-night-poller.js gated the
//    ENTIRE discoverBwwRoundupUrl block behind `!isWestEnd`, so this show's one
//    and only poller run never even tried. No automated job has re-dispatched
//    the poller for this show since (no cron re-scans already-open shows for a
//    missing bwwRoundupUrl), so the fixed code has never had a live run against
//    it. Live-replayed 2026-08-17 (this session, not part of the committed
//    suite — the current reviews.php listing only carries recent roundups):
//    discoverBwwRoundupUrl(midnightShow) now returns `section-only` — the
//    Aug-2026 roundup has since rolled off BWW's listing entirely, so even a
//    fresh dispatch today could no longer recover it. This is a genuine,
//    now-unrecoverable timing gap, not a code defect — the regression this
//    suite guards is narrower and durable: West End/off-West End categories
//    must never again be silently excluded from the CHEAP discovery tiers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { computeRoundupYield } = require('../lib/bww-roundup-yield.js');
const { discoverBwwRoundupUrl, shouldSkipReviewsPhp } = require('../lib/bww-rr-discover.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. YIELD PROVENANCE
// ---------------------------------------------------------------------------

const SAVIORS_ROUNDUP_URL = 'https://www.broadwayworld.com/article/Review-Roundup-THE-SAVIORS-Opens-at-Atlantic-Theater-Company-20260727';
const CAT_COHEN_ROUNDUP_URL = 'https://www.broadwayworld.com/article/Review-Roundup-Cat-Cohens-BROAD-STROKES-Opens-Off-Broadway-20260727';
const LES_MIS_ROUNDUP_URL = 'https://www.broadwayworld.com/article/Review-Roundup-LES-MISERABLES-THE-ARENA-CONCERT-SPECTACULAR-Opens-At-Radio-City-Music-Hall-20260728';

// Fixture mirrors the real `source`/`sources`/`bwwRoundupUrl` fields observed
// 2026-08-17 in data/review-texts/<showId>/*.json for the three in-window
// shows. Only the fields computeRoundupYield() reads are included.
const FIXTURE_REVIEWS = [
  // the-saviors-off-broadway-2026 — 8 files touched by the roundup, 0 exclusive
  { showId: 'the-saviors-off-broadway-2026', outletId: 'nonroundup1', criticName: 'a', source: 'serp-discovery', sources: ['serp-discovery', 'submit-review-form', 'broad-web-serp'], bwwRoundupUrl: null },
  { showId: 'the-saviors-off-broadway-2026', outletId: 'exeunt-magazine', criticName: 'lane-williamson', source: 'bww-roundup', sources: ['bww-roundup', 'show-score-playwright'], bwwRoundupUrl: SAVIORS_ROUNDUP_URL },
  { showId: 'the-saviors-off-broadway-2026', outletId: 'nysr', criticName: 'michael-sommers', source: 'bww-roundup', sources: ['bww-roundup', 'show-score-playwright', 'outlet-listing-poller', 'playbill-verdict'], bwwRoundupUrl: SAVIORS_ROUNDUP_URL },
  { showId: 'the-saviors-off-broadway-2026', outletId: 'nytg', criticName: 'kyle-turner', source: 'bww-roundup', sources: ['bww-roundup', 'show-score-playwright', 'playbill-verdict'], bwwRoundupUrl: SAVIORS_ROUNDUP_URL },
  { showId: 'the-saviors-off-broadway-2026', outletId: 'nytimes', criticName: 'helen-shaw', source: 'bww-roundup', sources: ['bww-roundup', 'show-score-playwright', 'playbill-verdict'], bwwRoundupUrl: SAVIORS_ROUNDUP_URL },
  { showId: 'the-saviors-off-broadway-2026', outletId: 'talkinbroadway', criticName: 'howard-miller', source: 'bww-roundup', sources: ['bww-roundup', 'show-score', 'outlet-listing-poller', 'opening-night-discovery'], bwwRoundupUrl: SAVIORS_ROUNDUP_URL },
  { showId: 'the-saviors-off-broadway-2026', outletId: 'thewrap', criticName: 'robert-hofler', source: 'bww-roundup', sources: ['bww-roundup', 'show-score-playwright', 'playbill-verdict'], bwwRoundupUrl: SAVIORS_ROUNDUP_URL },
  { showId: 'the-saviors-off-broadway-2026', outletId: 'nytg', criticName: 'unknown', source: 'submit-review-form', sources: ['submit-review-form', 'bww-roundup', 'playbill-verdict'], bwwRoundupUrl: SAVIORS_ROUNDUP_URL },
  { showId: 'the-saviors-off-broadway-2026', outletId: 'exeunt-magazine', criticName: 'read-more', source: 'submit-review-form', sources: ['submit-review-form', 'bww-roundup', 'outlet-listing-poller', 'playbill-verdict'], bwwRoundupUrl: SAVIORS_ROUNDUP_URL },

  // cat-cohen-broad-strokes-off-broadway-2026 — 2 files touched, 0 exclusive
  { showId: 'cat-cohen-broad-strokes-off-broadway-2026', outletId: 'nysr', criticName: 'michael-sommers', source: 'bww-roundup', sources: ['bww-roundup', 'playbill-verdict'], bwwRoundupUrl: CAT_COHEN_ROUNDUP_URL },
  { showId: 'cat-cohen-broad-strokes-off-broadway-2026', outletId: 'nytg', criticName: 'caroline-cao', source: 'bww-roundup', sources: ['bww-roundup', 'serp-discovery', 'playbill-verdict', 'nyc-theatre'], bwwRoundupUrl: CAT_COHEN_ROUNDUP_URL },
  { showId: 'cat-cohen-broad-strokes-off-broadway-2026', outletId: 'nypost', criticName: 'johnny-oleksinski', source: 'playbill-verdict', sources: ['playbill-verdict', 'submit-review-form'], bwwRoundupUrl: null },

  // les-miserables-arena-concert-spectacular-off-broadway-2026 — 4 files touched,
  // 2 EXCLUSIVE (amny, chicagotribune — never corroborated by any other source)
  { showId: 'les-miserables-arena-concert-spectacular-off-broadway-2026', outletId: 'amny', criticName: 'matt-windman', source: 'bww-roundup', sources: ['bww-roundup'], bwwRoundupUrl: LES_MIS_ROUNDUP_URL },
  { showId: 'les-miserables-arena-concert-spectacular-off-broadway-2026', outletId: 'chicagotribune', criticName: 'chris-jones', source: 'bww-roundup', sources: ['bww-roundup'], bwwRoundupUrl: LES_MIS_ROUNDUP_URL },
  { showId: 'les-miserables-arena-concert-spectacular-off-broadway-2026', outletId: 'nypost', criticName: 'johnny-oleksinski', source: 'playbill-verdict', sources: ['playbill-verdict', 'bww-roundup'], bwwRoundupUrl: LES_MIS_ROUNDUP_URL },
  { showId: 'les-miserables-arena-concert-spectacular-off-broadway-2026', outletId: 'nysr', criticName: 'melissa-rose-bernardo', source: 'playbill-verdict', sources: ['playbill-verdict', 'submit-review-form', 'bww-roundup'], bwwRoundupUrl: LES_MIS_ROUNDUP_URL },
  { showId: 'les-miserables-arena-concert-spectacular-off-broadway-2026', outletId: 'nytimes', criticName: 'richard-sandomir', source: 'rss-discovery', sources: ['rss-discovery'], bwwRoundupUrl: null },
];

test('computeRoundupYield: the-saviors — roundup touched 8 reviews, exclusively sourced none', () => {
  const y = computeRoundupYield('the-saviors-off-broadway-2026', FIXTURE_REVIEWS);
  assert.equal(y.roundupTouchedCount, 8);
  assert.equal(y.roundupExclusiveCount, 0);
});

test('computeRoundupYield: cat-cohen-broad-strokes — roundup touched 2 reviews, exclusively sourced none', () => {
  const y = computeRoundupYield('cat-cohen-broad-strokes-off-broadway-2026', FIXTURE_REVIEWS);
  assert.equal(y.roundupTouchedCount, 2);
  assert.equal(y.roundupExclusiveCount, 0);
});

test('computeRoundupYield: les-miserables-arena-concert — roundup exclusively sourced amny + chicagotribune, the fix\'s real unique yield', () => {
  const y = computeRoundupYield('les-miserables-arena-concert-spectacular-off-broadway-2026', FIXTURE_REVIEWS);
  assert.equal(y.roundupTouchedCount, 4);
  assert.equal(y.roundupExclusiveCount, 2);
  const exclusiveOutlets = y.roundupExclusive.map(r => r.outletId).sort();
  assert.deepEqual(exclusiveOutlets, ['amny', 'chicagotribune']);
});

test('computeRoundupYield: a review with no sources array at all falls back to its single `source` field', () => {
  const reviews = [{ showId: 'x', outletId: 'o', criticName: 'c', source: 'bww-roundup' }];
  const y = computeRoundupYield('x', reviews);
  assert.equal(y.roundupTouchedCount, 1);
  assert.equal(y.roundupExclusiveCount, 1);
});

// ---------------------------------------------------------------------------
// 2. BROADWAY REPLAY
// ---------------------------------------------------------------------------

const TITANIQUE_ROUNDUP_URL = 'https://www.broadwayworld.com/article/Review-Roundup-TITANIQUE-Sets-Sail-on-Broadway-20260412';
const titaniqueShow = { id: 'titanique-2026', title: 'Titanique', openingDate: '2026-04-12', category: 'broadway' };

test('Broadway replay: titanique-2026 resolves via the cheap section-page scan (no Browserbase needed)', async () => {
  const result = await discoverBwwRoundupUrl(titaniqueShow, {
    // Fixture: the homepage/section-page anchor listing as it looked around
    // titanique-2026's real 2026-04-12 opening, including noise anchors for
    // other same-week openings.
    fetchSectionAnchors: async () => ([
      TITANIQUE_ROUNDUP_URL,
      'https://www.broadwayworld.com/article/Review-Roundup-Some-Other-Show-Opens-on-Broadway-20260410',
    ]),
    // Cheap reviews.php tier should never even be consulted once the section
    // scan already matched.
    fetchCheapAnchors: async () => { throw new Error('should not be called — section scan already matched'); },
    // Paid Browserbase tier must never be consulted either.
    fetchAnchors: async () => { throw new Error('should not be called — cheap tier already resolved the URL'); },
  });
  assert.equal(result.url, TITANIQUE_ROUNDUP_URL);
  assert.equal(result.via, 'section');
  // NOTE: no wall-clock assertion here (ship-check adversarial review flagged
  // an earlier `ms < 1000` bound as CI-flaky — timing varies under load and
  // proves nothing about correctness). The "should not be called" throws
  // above already guard against an accidental real I/O hop creeping into
  // this fixture-backed path; that's a functional guard, not a race.
});

test('Broadway replay: titanique-2026 still resolves via the cheap reviews.php tier if the section scan misses (fast path, no Browserbase)', async () => {
  const result = await discoverBwwRoundupUrl(titaniqueShow, {
    fetchSectionAnchors: async () => ([]), // section scan empty this run
    fetchCheapAnchors: async () => ([TITANIQUE_ROUNDUP_URL]),
    // NOTE: opts.fetchAnchors is deliberately omitted — discoverBwwRoundupUrl's
    // own contract is "when supplied, the cheap tier is bypassed entirely"
    // (bww-rr-discover.js docstring), so a "should not be called" guard here
    // would itself suppress the very cheap-tier path this test exercises.
  });
  assert.equal(result.url, TITANIQUE_ROUNDUP_URL);
  assert.equal(result.via, 'reviews.php-cheap');
});

test('Broadway replay: falls through to the paid Browserbase tier only when BOTH cheap tiers miss, and still finds the real URL', async () => {
  const result = await discoverBwwRoundupUrl(titaniqueShow, {
    fetchSectionAnchors: async () => ([]),
    fetchCheapAnchors: async () => ([]),
    fetchAnchors: async () => ([TITANIQUE_ROUNDUP_URL]),
  });
  assert.equal(result.url, TITANIQUE_ROUNDUP_URL);
  assert.equal(result.via, 'reviews.php');
});

// ---------------------------------------------------------------------------
// 3. MISSING 4TH ROUNDUP — regression guard + dispatch-mechanism proof
// ---------------------------------------------------------------------------

// Real shows.json values (checked 2026-08-17): openingDate 2026-07-20,
// category off-west-end, market west-end.
const midnightShow = {
  id: 'midnight-at-the-never-get-west-end-2026',
  title: 'Midnight at the Never Get',
  openingDate: '2026-07-20',
  category: 'off-west-end',
};

test('missing 4th roundup regression guard: off-West-End shows must still reach the cheap section-page tier (never re-gated behind !isWestEnd)', async () => {
  const KNOWN_URL = 'https://www.broadwayworld.com/article/Review-Roundup-MIDNIGHT-AT-THE-NEVER-GET-Opens-20260720';
  const result = await discoverBwwRoundupUrl(midnightShow, {
    fetchSectionAnchors: async () => ([KNOWN_URL]),
    fetchCheapAnchors: async () => { throw new Error('should not be called — section scan already matched'); },
    fetchAnchors: async () => { throw new Error('should not be called — off-west-end must not reach the paid tier by default'); },
  });
  assert.equal(result.url, KNOWN_URL);
  assert.equal(result.via, 'section');
});

test('missing 4th roundup regression guard: off-West-End still gets the cheap reviews.php-cheap tier when the section scan misses', async () => {
  const KNOWN_URL = 'https://www.broadwayworld.com/article/Review-Roundup-MIDNIGHT-AT-THE-NEVER-GET-Opens-20260720';
  // opts.fetchAnchors deliberately omitted — see the Broadway-replay test above
  // for why supplying it (even just to assert it's unreachable) would itself
  // bypass the cheap tier this test exercises.
  const result = await discoverBwwRoundupUrl(midnightShow, {
    fetchSectionAnchors: async () => ([]),
    fetchCheapAnchors: async () => ([KNOWN_URL]),
  });
  assert.equal(result.url, KNOWN_URL);
  assert.equal(result.via, 'reviews.php-cheap');
});

test('shouldSkipReviewsPhp: off-west-end still correctly skips only the PAID Browserbase tier (cost guard intact)', () => {
  assert.equal(shouldSkipReviewsPhp(midnightShow), true);
});

test('missing 4th roundup: opening-night-poller.yml has no cron — it fires once per show (workflow_dispatch only), so nothing ever re-ran the fixed discovery code against this show after it opened', () => {
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'opening-night-poller.yml');
  const yaml = fs.readFileSync(workflowPath, 'utf8');
  assert.match(yaml, /workflow_dispatch:/, 'poller must still be dispatchable');
  assert.doesNotMatch(yaml, /^\s*schedule:/m, 'poller must have NO cron trigger — a schedule here would mean this class of gap should already be closed, contradicting the card');
});
