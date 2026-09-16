/**
 * BRO-3610: gather-reviews.js has its own set of 7 archive-read call sites
 * that read the exact same cached aggregator HTML/JSON files the 5 scraper
 * scripts write (BWW, DTLI, Show Score, LBO, TR, TS), plus one more
 * (Stagedoor) with no validation at all — but never got upgraded to
 * checkArchiveCategory() when BRO-2547/2549/2565 wired that category-aware,
 * cross-market-sibling-checking guard into the scrapers themselves. This is
 * the same "each reader wrote its own logic independently" root cause
 * BRO-2565's own ticket described.
 *
 * checkArchiveCategory()'s own behavior (word-match, punctuation-false-
 * positive rescue, cross-market-sibling rejection) is already fully
 * regression-tested in scripts/lib/archive-cache-guard.test.mjs against the
 * REAL function. These tests don't re-prove that predicate — they prove
 * gather-reviews.js's own call sites are actually WIRED to it (not a bare
 * validateRoundupPageTitle() call, and not a REPLACEMENT of the existing
 * validatePageMatchesShow() year/LLM check where one already existed) — the
 * same static-source-inspection pattern archive-cache-guard.test.mjs already
 * uses for scrape-dtli.js/scrape-playbill-verdict.js/scrape-nyc-theatre-
 * roundups.js/scrape-london-box-office-roundups.js, since gather-reviews.js's
 * relevant functions (searchBWWRoundup, gatherReviewsForShow) reach these
 * archive reads only after live SERP/HTTP calls this suite cannot make.
 *
 * Run: node --test tests/unit/gather-reviews-archive-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = stripComments(
  fs.readFileSync(fileURLToPath(new URL('../../scripts/gather-reviews.js', import.meta.url)), 'utf8'),
);

function stripComments(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

test('imports checkArchiveCategory and buildSiblingCategoriesFromShows, and memoizes a siblingCategoriesByShowId() helper', () => {
  assert.match(SRC, /require\('\.\/lib\/archive-cache-guard'\)/, 'must require the shared guard module');
  assert.match(SRC, /checkArchiveCategory/, 'checkArchiveCategory must be imported/used');
  assert.match(SRC, /buildSiblingCategoriesFromShows/, 'buildSiblingCategoriesFromShows must be imported/used');
  assert.match(SRC, /function siblingCategoriesByShowId\(\)/, 'must define a memoized siblingCategoriesByShowId() helper, mirroring the 5 scrapers');
});

// ---------------------------------------------------------------------------
// The 4 previously-bare validateRoundupPageTitle(html, show.title || showId)
// call sites — none had a category or siblingCategories argument.
// ---------------------------------------------------------------------------

test('BWW roundup archive-cache read (searchBWWRoundup) no longer calls bare validateRoundupPageTitle', () => {
  const idx = SRC.indexOf("path.join(__dirname, '..', 'data', 'aggregator-archive', 'bww-roundups'");
  assert.ok(idx > 0, 'must still locate the bww-roundups archive path');
  const scope = SRC.slice(idx, idx + 1500);
  assert.match(scope, /checkArchiveCategory\(html, show, siblingCategoriesByShowId\(\)\[showId\]\)/,
    'the cached-archive read must call checkArchiveCategory with siblingCategories');
  assert.doesNotMatch(scope, /validateRoundupPageTitle\(/,
    'must not still call the bare, category-blind validateRoundupPageTitle at this site');
});

test('LBO archive-cache read no longer calls bare validateRoundupPageTitle', () => {
  const idx = SRC.indexOf("path.join(__dirname, '../data/aggregator-archive/lbo-roundups'");
  assert.ok(idx > 0, 'must still locate the lbo-roundups archive path');
  const scope = SRC.slice(idx, idx + 800);
  assert.match(scope, /checkArchiveCategory\(lboHtml, show, siblingCategoriesByShowId\(\)\[showId\]\)/,
    'the LBO cached-archive read must call checkArchiveCategory with siblingCategories');
  assert.doesNotMatch(scope, /validateRoundupPageTitle\(/,
    'must not still call the bare, category-blind validateRoundupPageTitle at this site');
});

test('theatre.reviews (TR) archive-cache read no longer calls bare validateRoundupPageTitle', () => {
  const idx = SRC.indexOf("path.join(archBase, 'theatre-reviews'");
  assert.ok(idx > 0, 'must still locate the theatre-reviews archive path');
  const scope = SRC.slice(idx, idx + 600);
  assert.match(scope, /checkArchiveCategory\(html, show, siblingCategoriesByShowId\(\)\[showId\]\)/,
    'the TR cached-archive read must call checkArchiveCategory with siblingCategories');
  assert.doesNotMatch(scope, /validateRoundupPageTitle\(/,
    'must not still call the bare, category-blind validateRoundupPageTitle at this site');
});

test('The Stage (TS) archive-cache read no longer calls bare validateRoundupPageTitle', () => {
  const idx = SRC.indexOf("path.join(archBase, 'thestage-roundups'");
  assert.ok(idx > 0, 'must still locate the thestage-roundups archive path');
  const scope = SRC.slice(idx, idx + 600);
  assert.match(scope, /checkArchiveCategory\(html, show, siblingCategoriesByShowId\(\)\[showId\]\)/,
    'the TS cached-archive read must call checkArchiveCategory with siblingCategories');
  assert.doesNotMatch(scope, /validateRoundupPageTitle\(/,
    'must not still call the bare, category-blind validateRoundupPageTitle at this site');
});

test('no gather-reviews.js archive-read site calls validateRoundupPageTitle directly any more', () => {
  // The import line itself still names it (destructured but now unused there,
  // or kept for a different, non-archive caller) — check call SITES only.
  const bareCalls = (SRC.match(/[^.]\bvalidateRoundupPageTitle\(/g) || []).length;
  assert.equal(bareCalls, 0,
    `expected 0 remaining bare validateRoundupPageTitle(...) call sites, found ${bareCalls} — every one of BWW-roundup/LBO/TR/TS must route through checkArchiveCategory()`);
});

// ---------------------------------------------------------------------------
// The 3 validatePageMatchesShow-only sites — checkArchiveCategory must be
// ADDED alongside the existing check, not substituted for it (the "replace
// instead of add" regression BRO-2565's own Codex review caught).
// ---------------------------------------------------------------------------

test('DTLI site: checkArchiveCategory runs ALONGSIDE validatePageMatchesShow, both required', () => {
  const validateIdx = SRC.indexOf('const dtliValidation = await validatePageMatchesShow(dtliResult.html, show.title,');
  assert.ok(validateIdx > 0, 'must still run the year/LLM identity check');
  const catIdx = SRC.indexOf('const dtliCatCheck = checkArchiveCategory(dtliResult.html, show,', validateIdx);
  assert.ok(catIdx > validateIdx, 'must ALSO call checkArchiveCategory, after the identity check');
  const scope = SRC.slice(validateIdx, catIdx + 400);
  assert.match(scope, /if\s*\(\s*!dtliValidation\.valid\s*\|\|\s*!dtliCatCheck\.ok\s*\)/,
    'both checks must be required (OR-of-failures), not one replacing the other');
});

test('Show Score site: checkArchiveCategory runs ALONGSIDE validatePageMatchesShow, both required', () => {
  const validateIdx = SRC.indexOf('const ssValidation = await validatePageMatchesShow(showScoreResult.html, show.title,');
  assert.ok(validateIdx > 0, 'must still run the year/LLM identity check');
  const catIdx = SRC.indexOf('const ssCatCheck = checkArchiveCategory(showScoreResult.html, show,', validateIdx);
  assert.ok(catIdx > validateIdx, 'must ALSO call checkArchiveCategory, after the identity check');
  const scope = SRC.slice(validateIdx, catIdx + 400);
  assert.match(scope, /if\s*\(\s*!ssValidation\.valid\s*\|\|\s*!ssCatCheck\.ok\s*\)/,
    'both checks must be required (OR-of-failures), not one replacing the other');
});

test('BWW roundup validation site: checkArchiveCategory runs ALONGSIDE validatePageMatchesShow, both required', () => {
  const validateIdx = SRC.indexOf('const validation = await validatePageMatchesShow(bwwResult.html, show.title,');
  assert.ok(validateIdx > 0, 'must still run the year/LLM identity check');
  const catIdx = SRC.indexOf('const bwwCatCheck = checkArchiveCategory(bwwResult.html, show,', validateIdx);
  assert.ok(catIdx > validateIdx, 'must ALSO call checkArchiveCategory, after the identity check');
  const scope = SRC.slice(validateIdx, catIdx + 600);
  assert.match(scope, /if\s*\(\s*!validation\.valid\s*\|\|\s*!bwwCatCheck\.ok\s*\)/,
    'both checks must be required (OR-of-failures), not one replacing the other');
});

// ---------------------------------------------------------------------------
// Stagedoor (SD): had ZERO validation of any kind. It has no full HTML page
// (no canonical URL, no market-qualifier badge), so it can't run
// checkArchiveCategory's cross-market-sibling check — but its archive JSON
// does carry the Stagedoor page's own title, so a bare title check
// (pageTitleConfirmsShow, the same predicate validate-archive-productions.js
// uses for title-only comparisons) is added.
// ---------------------------------------------------------------------------

test('Stagedoor (SD) archive read now validates the cached title before extracting reviews', () => {
  const idx = SRC.indexOf("path.join(archBase, 'stagedoor'");
  assert.ok(idx > 0, 'must still locate the stagedoor archive path');
  const scope = SRC.slice(idx, idx + 1200);
  assert.match(scope, /pageTitleConfirmsShow\(data\.title, show\.title\)/,
    'must validate data.title against show.title before extracting criticReviews');
  assert.match(scope, /fs\.renameSync\(sdArchive, sdArchive \+ '\.mismatch'\)/,
    'a title mismatch must quarantine the file, matching the TR/TS/LBO pattern above it');
  // The quarantine check must run BEFORE reviews are read out of the file.
  const checkIdx = scope.indexOf('pageTitleConfirmsShow');
  const extractIdx = scope.indexOf('data.criticReviews');
  assert.ok(checkIdx > 0 && extractIdx > checkIdx,
    'the title check must run BEFORE criticReviews are extracted from the untrusted file');
});
