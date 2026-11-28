// BRO-3556: gather-reviews.js's own Show Score path (curated/slug-guessed page,
// Playwright carousel, HTML fallback, pagination API) must apply the same
// production-identity gate the gap audit applies to Show Score discovery
// (BRO-1412, isUrlYearOutOfWindow). Show Score keeps one page per title, so a
// revival's page can link a prior production's notice; before this fix
// gather-reviews ingested such links with no year check.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { showScoreUrlBlockReason, partitionShowScoreReviews, isUrlYearOutOfWindow } = require('./lib/gap-ingest-policy.js');

const here = path.dirname(fileURLToPath(import.meta.url));

// A 2026 Broadway revival of a title that also ran on Broadway in 2016.
const revival = {
  id: 'she-loves-me-2026',
  title: 'She Loves Me',
  category: 'broadway',
  previewsStartDate: '2026-02-20',
  openingDate: '2026-03-15',
};

const STALE = 'https://www.nytimes.com/2016/03/18/theater/review-she-loves-me.html';
const CURRENT = 'https://www.nytimes.com/2026/03/16/theater/she-loves-me-review.html';
const SLUG_ONLY = 'https://variety.com/2026/legit/reviews/she-loves-me-review-1235';
const NO_YEAR = 'https://www.theatermania.com/news/she-loves-me-review_123456/';

test('a prior-production Show Score link is blocked with the audit\'s source tag', () => {
  assert.strictEqual(isUrlYearOutOfWindow(STALE, revival), true);
  assert.strictEqual(showScoreUrlBlockReason(STALE, revival), 'show-score-url-year');
});

test('a current-run Show Score link still ingests', () => {
  assert.strictEqual(showScoreUrlBlockReason(CURRENT, revival), null);
  assert.strictEqual(showScoreUrlBlockReason(SLUG_ONLY, revival), null);
});

test('a link with no embedded year, or no link at all, fails open', () => {
  assert.strictEqual(showScoreUrlBlockReason(NO_YEAR, revival), null);
  assert.strictEqual(showScoreUrlBlockReason(null, revival), null);
  assert.strictEqual(showScoreUrlBlockReason(undefined, revival), null);
});

test('a declared priorRuns window readmits its own year', () => {
  const withPrior = { ...revival, priorRuns: [{ openingDate: '2016-03-17', closingDate: '2016-07-10' }] };
  // A transfer/extension that declares the 2016 run as its own keeps 2016 links.
  assert.strictEqual(showScoreUrlBlockReason(STALE, withPrior), null);
  // A 2012 link is outside both windows and stays blocked.
  assert.strictEqual(showScoreUrlBlockReason('https://www.nytimes.com/2012/05/01/theater/x.html', withPrior), 'show-score-url-year');
});

test('partition keeps current-run reviews and drops prior-production ones', () => {
  const reviews = [
    { outlet: 'The New York Times', url: STALE, source: 'show-score-playwright' },
    { outlet: 'The New York Times', url: CURRENT, source: 'show-score-playwright' },
    { outlet: 'Variety', url: SLUG_ONLY, source: 'show-score' },
    { outlet: 'TheaterMania', url: null, source: 'show-score' },
  ];
  const { kept, blocked } = partitionShowScoreReviews(reviews, revival);
  assert.deepStrictEqual(kept.map((r) => r.url), [CURRENT, SLUG_ONLY, null]);
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].review.url, STALE);
  assert.strictEqual(blocked[0].reason, 'show-score-url-year');
});

test('partition tolerates an empty or missing list', () => {
  assert.deepStrictEqual(partitionShowScoreReviews([], revival), { kept: [], blocked: [] });
  assert.deepStrictEqual(partitionShowScoreReviews(undefined, revival), { kept: [], blocked: [] });
});

test('gather-reviews gates every Show Score source before foundReviews', () => {
  // Wiring guard: the carousel, page-HTML fallback and pagination batches must
  // each go through the shared partition, so a new Show Score source added
  // without the gate shows up here.
  const src = fs.readFileSync(path.join(here, 'gather-reviews.js'), 'utf8');
  assert.match(src, /const \{ partitionShowScoreReviews \} = require\('\.\/lib\/gap-ingest-policy'\);/);
  assert.match(src, /gateShowScore\(showScoreResult\.reviews, 'carousel'\)/);
  assert.match(src, /gateShowScore\(extractShowScoreReviews\(/);
  assert.match(src, /gateShowScore\(paginatedReviews, 'pagination'\)/);
});

test('partition gates the raw Show Score link when the url was nulled (urlOf)', () => {
  // BRO-5261 retro-review: the page-HTML fallback's validateUrl nulls a link
  // whose slug misses the title BEFORE the gate ran, so a 2016 notice passed
  // with url null. The gate must see the raw link.
  const RAW = Symbol('raw');
  const nulled = { outlet: 'The New York Times', url: null, [RAW]: STALE, source: 'show-score' };
  const fine = { outlet: 'Variety', url: SLUG_ONLY, [RAW]: SLUG_ONLY, source: 'show-score' };
  const urlOf = (r) => r[RAW] || r.url;
  const { kept, blocked } = partitionShowScoreReviews([nulled, fine], revival, { urlOf });
  assert.deepStrictEqual(kept, [fine]);
  assert.strictEqual(blocked[0].review, nulled);
  // Without urlOf the nulled row slips through (the old behaviour).
  assert.strictEqual(partitionShowScoreReviews([nulled], revival).kept.length, 1);
});

test('gather-reviews gates the raw link and skips slug guessing for an older production', () => {
  const src = fs.readFileSync(path.join(here, 'gather-reviews.js'), 'utf8');
  assert.match(src, /partitionShowScoreReviews\(reviews, show, \{ urlOf \}\)/);
  assert.strictEqual((src.match(/\[SS_RAW_URL\]: /g) || []).length, 3, 'every extractShowScoreReviews push keeps the raw link');
  assert.match(src, /showScoreSlugGuessBlockReason\(show, url, urlMap, allShowsForSlugs, year\)/);
});
