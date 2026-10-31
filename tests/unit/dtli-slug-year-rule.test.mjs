/**
 * DTLI slug year rule (2026 data audit, BRO-4204 S7-T9).
 *
 * The audit found every-brilliant-thing-2026 mapped to DTLI's 2014 page (3
 * reviews, all December 14, 2014) while `every-brilliant-thing-2` (17 reviews,
 * March 2026) sat unmapped, hamlet-2026 mapped to `hamlet-broadway` (5 reviews,
 * all 2008), death-of-a-salesman-2026 to the 2012 page. The revival-suffix
 * preference alone cannot see that: DTLI suffixes are creation order, not
 * year, and the bare slug is often the current production (bug-2026 → `bug`,
 * 19 reviews from 2026).
 *
 * All three functions are the REAL ones from scripts/lib/review-guards.js
 * (CLAUDE.md §15). The HTML fixtures are the review-item blocks DTLI serves
 * today (fetched 2026-09-28 for every-brilliant-thing, every-brilliant-thing-2,
 * hamlet-broadway and bug), trimmed to the elements the extractor reads.
 *
 * Run: node --test tests/unit/dtli-slug-year-rule.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const {
  pickBestDtliSlug,
  dtliSlugPredatesShow,
  extractDtliReviewYears,
  dtliShowYear,
} = require(path.join(ROOT, 'scripts/lib/review-guards.js'));

// Real-shaped DTLI show page fragments (class names and date format verbatim).
function reviewItem(outlet, critic, date, variant = 'review-item') {
  return `
<div class="${variant}">
  <div class="review-item-attribution-wrapper"><img class="review-item-attribution" alt="${outlet}" src="/x.png"></div>
  <h2 class="review-item-critic-name"><a href="/?s=${encodeURIComponent(critic)}">${critic}</a></h2>
  <div class="review-item-date">${date}</div>
  <p class="paragraph">…</p>
  <a href="https://example.com/${outlet.toLowerCase()}" class="button button-pink review-item-button">READ THE REVIEW</a>
</div>`;
}
const PAGE_SHELL = (items) => `<!DOCTYPE html><html><head><title>Every Brilliant Thing – Did They Like It?</title></head>
<body><div class="show-header">Opened December 14, 2014</div>
<img src="/wp-content/uploads/thumbs-up/thumb-3.png">
<section class="reviews">${items}</section>
<aside class="more-shows"><div class="show-tile">Hamlet (2026)</div><div class="review-item-date-unrelated">January 1, 2030</div></aside>
</body></html>`;

const EBT_2014_HTML = PAGE_SHELL([
  reviewItem('New York Times', 'Charles Isherwood', 'December 14, 2014'),
  reviewItem('Time Out', 'David Cote', 'December 14, 2014'),
  reviewItem('Variety', 'Marilyn Stasio', 'December 14, 2014', 'poster-review-item'),
].join(''));
const EBT_2026_HTML = PAGE_SHELL([
  reviewItem('New York Times', 'Jesse Green', 'March 12, 2026'),
  reviewItem('Vulture', 'Sara Holdren', 'March 12, 2026'),
  reviewItem('Variety', 'Aramide Tinubu', 'March 13, 2026', 'poster-review-item'),
].join(''));
const HAMLET_2008_HTML = PAGE_SHELL([
  reviewItem('New York Times', 'Ben Brantley', 'October 3, 2008'),
  reviewItem('Variety', 'David Rooney', 'October 3, 2008'),
].join(''));
const MIXED_HTML = PAGE_SHELL([
  reviewItem('New York Times', 'Ben Brantley', 'October 3, 2012'),
  reviewItem('Vulture', 'Sara Holdren', 'March 12, 2026'),
].join(''));
const EMPTY_HTML = PAGE_SHELL('');

describe('extractDtliReviewYears', () => {
  test('reads one year per review-item date, ignoring header/sidebar dates', () => {
    assert.deepEqual(extractDtliReviewYears(EBT_2014_HTML), [2014, 2014, 2014]);
    assert.deepEqual(extractDtliReviewYears(EBT_2026_HTML), [2026, 2026, 2026]);
    assert.deepEqual(extractDtliReviewYears(MIXED_HTML), [2012, 2026]);
  });

  test('an empty or garbage page yields []', () => {
    assert.deepEqual(extractDtliReviewYears(EMPTY_HTML), []);
    assert.deepEqual(extractDtliReviewYears(''), []);
    assert.deepEqual(extractDtliReviewYears(null), []);
    assert.deepEqual(extractDtliReviewYears('<div class="review-item-date">Coming soon</div>'), []);
  });
});

describe('dtliSlugPredatesShow', () => {
  test('all reviews before the show year → predates', () => {
    assert.equal(dtliSlugPredatesShow([2014, 2014, 2014], 2026), true);
    assert.equal(dtliSlugPredatesShow([2008, 2008], '2026'), true);
  });

  test('any review in or after the show year → does not predate', () => {
    assert.equal(dtliSlugPredatesShow([2012, 2026], 2026), false);
    assert.equal(dtliSlugPredatesShow([2026, 2026], 2026), false);
    assert.equal(dtliSlugPredatesShow([2025], 2026), true, 'a late-2025 page for a 2026 id is still an earlier production');
  });

  test('no evidence never predates (empty page, failed probe, unknown year)', () => {
    assert.equal(dtliSlugPredatesShow([], 2026), false);
    assert.equal(dtliSlugPredatesShow(null, 2026), false);
    assert.equal(dtliSlugPredatesShow(undefined, 2026), false);
    assert.equal(dtliSlugPredatesShow([2014], null), false);
    assert.equal(dtliSlugPredatesShow([2014], 'soon'), false);
  });
});

describe('dtliShowYear', () => {
  test('opening year, else previews year, else the id year, else null', () => {
    assert.equal(dtliShowYear({ id: 'evita-2026', openingDate: '2027-03-25', previewsStartDate: '2027-02-27' }), 2027);
    assert.equal(dtliShowYear({ id: 'ripples-off-west-end-2026', previewsStartDate: '2027-01-21' }), 2027);
    assert.equal(dtliShowYear({ id: 'every-brilliant-thing-2026' }), 2026);
    assert.equal(dtliShowYear({ id: 'hamilton' }), null);
    assert.equal(dtliShowYear(null), null);
  });
});

describe('pickBestDtliSlug — the year rule on top of the suffix preference', () => {
  test('every-brilliant-thing-2026: the 2014 page is rejected, the 2026 page wins', () => {
    const reviewYearsBySlug = {
      'every-brilliant-thing': extractDtliReviewYears(EBT_2014_HTML),
      'every-brilliant-thing-2': extractDtliReviewYears(EBT_2026_HTML),
    };
    assert.equal(pickBestDtliSlug('every-brilliant-thing-2026', ['every-brilliant-thing', 'every-brilliant-thing-2'], { reviewYearsBySlug, showYear: 2026 }), 'every-brilliant-thing-2');
    // Even when the wrong page is the ONLY candidate (the audit's actual state).
    assert.equal(pickBestDtliSlug('every-brilliant-thing-2026', ['every-brilliant-thing'], { reviewYearsBySlug, showYear: 2026 }), null);
  });

  test('hamlet-2026: a 2008 page must not be assigned to a 2026 revival', () => {
    const reviewYearsBySlug = { 'hamlet-broadway': extractDtliReviewYears(HAMLET_2008_HTML) };
    assert.equal(pickBestDtliSlug('hamlet-2026', ['hamlet-broadway'], { reviewYearsBySlug }), null, 'showYear defaults to the id year');
    assert.equal(pickBestDtliSlug('hamlet-2008', ['hamlet-broadway'], { reviewYearsBySlug }), 'hamlet-broadway', 'the 2008 production keeps it');
  });

  test('bug-2026: a bare slug whose reviews are current is kept (suffix preference is not a year check)', () => {
    const reviewYearsBySlug = { bug: [2026, 2026, 2026] };
    assert.equal(pickBestDtliSlug('bug-2026', ['bug'], { reviewYearsBySlug, showYear: 2026 }), 'bug');
  });

  test('the suffix preference still applies among the survivors', () => {
    const reviewYearsBySlug = { giant: [2012], 'giant-2': [2026], 'giant-3': [] };
    assert.equal(pickBestDtliSlug('giant-2026', ['giant', 'giant-2', 'giant-3'], { reviewYearsBySlug, showYear: 2026 }), 'giant-3', 'unprobed/empty pages survive and the highest suffix wins');
    assert.equal(pickBestDtliSlug('giant-2026', ['giant', 'giant-2'], { reviewYearsBySlug, showYear: 2026 }), 'giant-2');
  });

  test('a mixed-year page (an old page that also carries the new reviews) is not rejected', () => {
    const reviewYearsBySlug = { 'death-of-a-salesman': extractDtliReviewYears(MIXED_HTML) };
    assert.equal(pickBestDtliSlug('death-of-a-salesman-2026', ['death-of-a-salesman'], { reviewYearsBySlug }), 'death-of-a-salesman');
  });

  test('no probe data, no show year, or an un-yeared id → the legacy behaviour is unchanged', () => {
    assert.equal(pickBestDtliSlug('giant-2026', ['giant', 'giant-2']), 'giant-2');
    assert.equal(pickBestDtliSlug('company-2022', ['company', 'company-2', 'company-3']), 'company-3');
    assert.equal(pickBestDtliSlug('hamilton', ['hamilton', 'hamilton-2']), 'hamilton');
    assert.equal(pickBestDtliSlug('hamilton', ['hamilton'], { reviewYearsBySlug: { hamilton: [2015] } }), 'hamilton', 'no year to compare against');
    assert.equal(pickBestDtliSlug('x-2026', []), null);
    assert.equal(pickBestDtliSlug('x-2026', ['x'], { reviewYearsBySlug: new Map([['x', [2014]]]), showYear: 2026 }), null, 'a Map works too');
  });
});

describe('discover-dtli-slugs.js wiring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/discover-dtli-slugs.js'), 'utf8');

  test('probes candidates, passes the years to the real picker, and unmaps a rejected current slug under --force', () => {
    assert.match(src, /require\('\.\/lib\/review-guards'\)/);
    assert.match(src, /const reviewYearsBySlug = showYear \? await probeCandidateYears\(slugs\) : null;/);
    assert.match(src, /pickBestDtliSlug\(showId, slugs, \{ reviewYearsBySlug, showYear \}\)/);
    assert.match(src, /unmappedByYear\[showId\] = mappedSlug;/);
    assert.match(src, /delete slugMap\.shows\[showId\];/);
    assert.match(src, /if \(FORCE\) \{[\s\S]*?matchType: 'existing-mapping'/, '--force must re-probe each mapped id\'s current slug');
    assert.match(src, /--shows=/, 'the --shows filter must exist for targeted re-probes');
  });
});
