/**
 * BRO-736: Aggregator-first discovery for opening night shows.
 *
 * gather-reviews.js already checks aggregators (DTLI, Show Score, BWW
 * roundups) before SERP structurally, but the general-purpose SERP guard
 * (isUrlYearOutsideWindow) grants a -3y grace on the show's opening year —
 * a revival/transfer within that window (e.g. Cats: Broadway revival 2026,
 * Off-Broadway "Jellicle Ball" run 2024) sailed through, producing 27/32
 * wrongProduction files. --opening-night opts into a 0-grace embedded-year
 * check instead of touching the shared, broadly-used default guard.
 *
 * Run: node --test tests/unit/gather-reviews-opening-night.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  extractUrlYear,
  isSerpUrlWrongProductionForOpeningNight,
  computeSerpShare,
  exceedsOpeningNightSerpBudget,
  parseGatherReviewsFlags,
} = require('../../scripts/lib/opening-night-discovery.js');

test('extractUrlYear reads a slash-delimited embedded year', () => {
  assert.equal(extractUrlYear('https://www.nytimes.com/2024/10/12/theater/cats-review.html'), 2024);
});

test('extractUrlYear reads a dash-delimited embedded year (slug-style permalink)', () => {
  assert.equal(extractUrlYear('https://www.example.com/cats-2024-review/'), 2024);
});

test('extractUrlYear returns null when no year is embedded', () => {
  assert.equal(extractUrlYear('https://www.nytimes.com/theater/cats-review.html'), null);
});

test('extractUrlYear returns null for a null/empty url', () => {
  assert.equal(extractUrlYear(''), null);
  assert.equal(extractUrlYear(null), null);
});

test('Cats repro: 2024 Off-Broadway URL rejected for a 2026 Broadway opening with no declared priorRuns', () => {
  const show = { openingDate: '2026-04-09', priorRuns: [], tourLegs: [] };
  const url = 'https://www.nytimes.com/2024/06/12/theater/cats-jellicle-ball-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), true);
});

test('a URL year matching the opening year is accepted', () => {
  const show = { openingDate: '2026-04-09' };
  const url = 'https://www.nytimes.com/2026/04/09/theater/cats-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), false);
});

test('a mismatched URL year IS accepted when covered by a declared priorRuns window', () => {
  const show = {
    openingDate: '2026-04-09',
    priorRuns: [{ openingDate: '2024-06-01', closingDate: '2024-08-01' }],
  };
  const url = 'https://www.nytimes.com/2024/06/12/theater/cats-jellicle-ball-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), false);
});

test('a mismatched URL year IS accepted when covered by a declared tourLegs window', () => {
  const show = {
    openingDate: '2026-04-09',
    tourLegs: [{ startDate: '2023-01-01', endDate: '2023-06-01' }],
  };
  const url = 'https://www.example.com/2023-cats-tour-review/';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), false);
});

test('a URL with no embedded year is never rejected (nothing to check)', () => {
  const show = { openingDate: '2026-04-09' };
  const url = 'https://www.nytimes.com/theater/cats-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), false);
});

test('a URL year in the FUTURE relative to opening year is rejected (bad record, not a legitimate prior run)', () => {
  const show = { openingDate: '2026-04-09' };
  const url = 'https://www.nytimes.com/2028/01/01/theater/cats-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), true);
});

test('a December opening reviewed the following January is accepted (spillover grace)', () => {
  const show = { openingDate: '2026-12-28' };
  const url = 'https://www.nytimes.com/2027/01/02/theater/cats-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), false);
});

test('an April opening reviewed the following January is still rejected (no spillover grace outside Nov/Dec)', () => {
  const show = { openingDate: '2026-04-09' };
  const url = 'https://www.nytimes.com/2027/01/02/theater/cats-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), true);
});

test('a priorRuns entry with only openingDate (no closingDate) still readmits its own year', () => {
  const show = {
    openingDate: '2026-04-09',
    priorRuns: [{ openingDate: '2024-06-01' }],
  };
  const url = 'https://www.nytimes.com/2024/06/12/theater/cats-jellicle-ball-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), false);
});

test('a malformed show.openingDate never rejects (cannot determine a window, fails safe)', () => {
  const show = { openingDate: 'not-a-real-date' };
  const url = 'https://www.nytimes.com/2024/06/12/theater/cats-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, show), false);
});

test('missing show.openingDate never rejects (can\'t determine a window)', () => {
  const url = 'https://www.nytimes.com/2024/06/12/theater/cats-review.html';
  assert.equal(isSerpUrlWrongProductionForOpeningNight(url, {}), false);
});

test('computeSerpShare counts serp-discovery* sources against the total', () => {
  const foundReviews = [
    { source: 'dtli' },
    { source: 'show-score-playwright' },
    { source: 'serp-discovery' },
    { source: 'serp-discovery-per-critic' },
  ];
  const { serpCount, aggregatorCount, total, serpRatio } = computeSerpShare(foundReviews);
  assert.equal(serpCount, 2);
  assert.equal(aggregatorCount, 2);
  assert.equal(total, 4);
  assert.equal(serpRatio, 0.5);
});

test('computeSerpShare on an empty list returns a zero ratio, not NaN', () => {
  const { serpRatio, total } = computeSerpShare([]);
  assert.equal(total, 0);
  assert.equal(serpRatio, 0);
});

test('exceedsOpeningNightSerpBudget: acceptance criteria threshold is 20%', () => {
  assert.equal(exceedsOpeningNightSerpBudget(0.19), false);
  assert.equal(exceedsOpeningNightSerpBudget(0.2), false);
  assert.equal(exceedsOpeningNightSerpBudget(0.21), true);
});

test('opening-night-mode scenario: 27/32 SERP contamination would exceed budget', () => {
  const foundReviews = [
    ...Array.from({ length: 27 }, () => ({ source: 'serp-discovery' })),
    ...Array.from({ length: 5 }, () => ({ source: 'dtli' })),
  ];
  const { serpRatio } = computeSerpShare(foundReviews);
  assert.equal(exceedsOpeningNightSerpBudget(serpRatio), true);
});

test('parseGatherReviewsFlags: --opening-night sets openingNight true, defaults false without it', () => {
  const withFlag = parseGatherReviewsFlags(['--shows=cats-broadway-2026', '--opening-night']);
  assert.equal(withFlag.openingNight, true);
  assert.deepEqual(withFlag.showIds, ['cats-broadway-2026']);

  const withoutFlag = parseGatherReviewsFlags(['--shows=cats-broadway-2026']);
  assert.equal(withoutFlag.openingNight, false);
});

test('parseGatherReviewsFlags: missing --shows returns null showIds', () => {
  const flags = parseGatherReviewsFlags(['--opening-night']);
  assert.equal(flags.showIds, null);
});

test('parseGatherReviewsFlags: parses all flags together', () => {
  const flags = parseGatherReviewsFlags([
    '--shows=a,b',
    '--aggregators-only',
    '--validate-urls',
    '--historical',
    '--opening-night',
  ]);
  assert.deepEqual(flags, {
    showIds: ['a', 'b'],
    aggregatorsOnly: true,
    validateUrls: true,
    historical: true,
    openingNight: true,
  });
});

test('discover-opening-night-reviews.js requires and calls isSerpUrlWrongProductionForOpeningNight at all 3 SERP strategies (BRO-736 wiring guard)', () => {
  // discover-opening-night-reviews.js is a second, independent SERP discovery
  // path dispatched directly by opening-night-reviews.yml (line 216) BEFORE
  // gather-reviews.js ever runs — it bypasses --opening-night entirely, so it
  // needs its own copy of the same guard. Source-text assertion (not a require
  // + mock, since main() does file I/O + network) so a future refactor can't
  // silently drop the call and regress the exact contamination path BRO-736
  // exists to close.
  const src = readFileSync(path.join(__dirname, '../../scripts/discover-opening-night-reviews.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/opening-night-discovery['"]\)/);
  const callCount = (src.match(/isSerpUrlWrongProductionForOpeningNight\(url, show\)/g) || []).length;
  assert.equal(callCount, 3, `expected 3 call sites (site-specific, Google News, broad web), found ${callCount}`);
});

test('opening-night-poller.js requires and calls isSerpUrlWrongProductionForOpeningNight at its SERP layer (BRO-736 wiring guard)', () => {
  // opening-night-poller.js is the PRIMARY real-time automated opening-night
  // engine (20-min cron for up to 4h). Its SERP layer calls discoverCorrectUrl
  // directly, which only carries the shared -3y-grace isUrlYearOutsideWindow
  // guard — this asserts the additional zero-grace check stays wired.
  const src = readFileSync(path.join(__dirname, '../../scripts/opening-night-poller.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/opening-night-discovery['"]\)/);
  assert.match(src, /isSerpUrlWrongProductionForOpeningNight\(url, show\)/);
});
