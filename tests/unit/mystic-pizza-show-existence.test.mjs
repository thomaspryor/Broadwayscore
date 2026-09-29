// TESTS-VS-DERIVED-DATA-EXEMPT: this regional entry was added by hand and
// verified directly against Playbill (CLAUDE.md's manual-stub rule), not
// produced by an enricher — there is no data/precursors/ source file for it
// to derive expectations from.
/**
 * Regression coverage for card #1933 (missing-show, zero-results search):
 * users searching "mystic pizza" got zero results because no production existed
 * in shows.json. Confirms the Paper Mill Playhouse (regional, Feb 2025) entry
 * is present, valid, scoreable, and discoverable via the real search predicate —
 * not just eyeballed JSON.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

const { matchesShowSearchQuery } = require(resolve(ROOT, 'scripts/lib/show-search-match.js'));

const showsData = JSON.parse(readFileSync(resolve(ROOT, 'data/shows.json'), 'utf-8'));
const reviewsData = JSON.parse(readFileSync(resolve(ROOT, 'data/reviews.json'), 'utf-8'));
const outletRegistry = JSON.parse(readFileSync(resolve(ROOT, 'data/outlet-registry.json'), 'utf-8'));

const SHOW_ID = 'mystic-pizza-regional-2025';

describe('Mystic Pizza show existence (#1933)', () => {
  const show = showsData.shows.find(s => s.id === SHOW_ID);

  test('show exists in shows.json', () => {
    assert.ok(show, `expected a shows.json entry with id "${SHOW_ID}"`);
  });

  test('show has valid category/market for the regional pipeline', () => {
    assert.equal(show.category, 'regional');
    assert.equal(show.market, 'regional');
    assert.ok(show.id.includes('-regional'), 'id must contain "-regional" for useCurrentMarket detection');
  });

  test('show has a real venue and dates', () => {
    assert.equal(show.venue, 'Paper Mill Playhouse, Millburn, NJ');
    assert.equal(show.openingDate, '2025-02-02');
    assert.equal(show.closingDate, '2025-02-23');
    assert.equal(show.status, 'closed');
  });

  test('"mystic pizza" search query matches the show via the real search predicate', () => {
    assert.ok(matchesShowSearchQuery(show, 'mystic pizza'));
    assert.ok(matchesShowSearchQuery(show, 'Mystic Pizza'));
    assert.ok(matchesShowSearchQuery(show, 'mystic'));
  });

  const reviews = reviewsData.reviews.filter(r => r.showId === SHOW_ID);

  test('show has enough reviews to clear the regional min-score threshold', () => {
    // Regional/off-broadway threshold is 3, or 5 if all reviews are T3 (see
    // memory/feedback_regional_show_add_runbook.md). This show has a T2 review
    // (TheaterMania), so the floor is 3.
    assert.ok(reviews.length >= 3, `expected >=3 reviews, found ${reviews.length}`);
    const hasT1orT2 = reviews.some(r => r.tier <= 2);
    if (!hasT1orT2) {
      assert.ok(reviews.length >= 5, 'T3-only shows need >=5 reviews to display a score');
    }
  });

  test('every ingested review has a registered outlet and a valid assignedScore', () => {
    for (const r of reviews) {
      assert.ok(outletRegistry.outlets[r.outletId], `outletId "${r.outletId}" missing from outlet-registry.json`);
      assert.ok(typeof r.assignedScore === 'number' && r.assignedScore >= 0 && r.assignedScore <= 100);
      assert.ok(r.url, `review from ${r.outlet} is missing a url`);
    }
  });
});
