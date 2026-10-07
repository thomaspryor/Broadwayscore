/**
 * BRO-3616: opening-night-poller.js has its OWN independent set of aggregator
 * archive-read/write call sites — separate from both the 5 scraper scripts
 * (BRO-2565) and gather-reviews.js (BRO-3610) — that never got the
 * checkArchiveCategory() guard. This is the 3rd unreconciled reader
 * scripts/lib/show-matching.js's validateRoundupPageTitle jsdoc names as the
 * root cause of the Stuart King (LBO Head Reviewer) mis-attribution incident
 * (2026-04-25).
 *
 * checkArchiveCategory()'s own behavior (word-match, punctuation-false-
 * positive rescue, cross-market-sibling rejection) is already fully
 * regression-tested in scripts/lib/archive-cache-guard.test.mjs against the
 * REAL function. These tests don't re-prove that predicate — they prove
 * opening-night-poller.js's own call sites are actually WIRED to it (not a
 * bare validatePageMatchesShow call, and not a REPLACEMENT of an existing
 * check where one already existed) — the same static-source-inspection
 * pattern tests/unit/gather-reviews-archive-guard.test.mjs already uses for
 * gather-reviews.js, since opening-night-poller.js's relevant function
 * (runAggregators) reaches these archive reads only after live SERP/HTTP
 * calls this suite cannot make.
 *
 * Run: node --test tests/unit/opening-night-poller-archive-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW = fs.readFileSync(fileURLToPath(new URL('../../scripts/opening-night-poller.js', import.meta.url)), 'utf8');
const SRC = stripComments(RAW);

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
  assert.match(SRC, /function siblingCategoriesByShowId\(\)/, 'must define a memoized siblingCategoriesByShowId() helper, mirroring gather-reviews.js (BRO-3610)');
});

// ---------------------------------------------------------------------------
// DTLI / Show Score: checkArchiveCategory must be ADDED alongside the
// existing validatePageMatchesShow check, not substituted for it (the
// "replace instead of add" regression BRO-2565's own Codex review caught,
// and the exact same pattern BRO-3610 had to preserve for gather-reviews.js).
// ---------------------------------------------------------------------------

test('DTLI site: checkArchiveCategory runs ALONGSIDE validatePageMatchesShow, both required', () => {
  const validateIdx = SRC.indexOf('const validation = await validatePageMatchesShow(dtli.html, show.title,');
  assert.ok(validateIdx > 0, 'must still run the year/LLM identity check');
  const catIdx = SRC.indexOf('const dtliCatCheck = checkArchiveCategory(dtli.html, show,', validateIdx);
  assert.ok(catIdx > validateIdx, 'must ALSO call checkArchiveCategory, after the identity check');
  const scope = SRC.slice(validateIdx, catIdx + 400);
  assert.match(scope, /if\s*\(\s*validation\.valid\s*&&\s*dtliCatCheck\.ok\s*\)/,
    'both checks must be required (AND-of-passes), not one replacing the other');
});

test('Show Score site: checkArchiveCategory runs ALONGSIDE validatePageMatchesShow, both required', () => {
  const validateIdx = SRC.indexOf('const validation = await validatePageMatchesShow(ss.html, show.title,');
  assert.ok(validateIdx > 0, 'must still run the year/LLM identity check');
  const catIdx = SRC.indexOf('const ssCatCheck = checkArchiveCategory(ss.html, show,', validateIdx);
  assert.ok(catIdx > validateIdx, 'must ALSO call checkArchiveCategory, after the identity check');
  const scope = SRC.slice(validateIdx, catIdx + 400);
  assert.match(scope, /if\s*\(\s*validation\.valid\s*&&\s*ssCatCheck\.ok\s*\)/,
    'both checks must be required (AND-of-passes), not one replacing the other');
});

// ---------------------------------------------------------------------------
// theatre.reviews (TR): freshly-discovered HTML was written straight to the
// archive with ZERO validation before either the write or the extraction.
// ---------------------------------------------------------------------------

test('theatre.reviews (TR) site validates before BOTH the archive write and the extraction', () => {
  const trIdx = SRC.indexOf('const tr = await discoverTrRoundupHtml(show);');
  assert.ok(trIdx > 0, 'must still discover the TR roundup HTML');
  const catIdx = SRC.indexOf('const trCatCheck = checkArchiveCategory(tr.html, show,', trIdx);
  assert.ok(catIdx > trIdx, 'must call checkArchiveCategory on the discovered HTML');
  const writeIdx = SRC.indexOf('fs.writeFileSync(archivePath, tr.html)', catIdx);
  const extractIdx = SRC.indexOf('extractTheatreReviews(tr.html, show.id)', catIdx);
  assert.ok(writeIdx > catIdx, 'the archive write must happen AFTER the category check');
  assert.ok(extractIdx > catIdx, 'the extraction must happen AFTER the category check');
});

// ---------------------------------------------------------------------------
// Stagedoor (SD): had ZERO validation of any kind, mirroring the identical
// gap BRO-3610 fixed in gather-reviews.js's own SD read.
// ---------------------------------------------------------------------------

test('Stagedoor (SD) archive read validates cached identity before extracting reviews, and fails CLOSED on a missing title', () => {
  const idx = SRC.indexOf("path.join(DATA_DIR, 'aggregator-archive', 'stagedoor'");
  assert.ok(idx > 0, 'must still locate the stagedoor archive path');
  const scope = SRC.slice(idx, idx + 1800);
  assert.match(scope, /pageTitleConfirmsShow\(sdData\.title \|\| '', show\.title\)/,
    'must validate sdData.title against show.title, defaulting a missing title to "" so it fails CLOSED (not skipped) rather than passing vacuously');
  assert.match(scope, /sdData\.ourShowId && sdData\.ourShowId !== show\.id/,
    'must also cross-check the archive\'s own ourShowId field against show.id');
  assert.match(scope, /fs\.renameSync\(sdArchivePath, sdArchivePath \+ '\.mismatch'\)/,
    'an identity mismatch must quarantine the file, matching the TR/TS pattern');
  const checkIdx = scope.indexOf('sdIdentityMismatch');
  const extractIdx = scope.indexOf('sdData.criticReviews');
  assert.ok(checkIdx > 0 && extractIdx > checkIdx,
    'the identity check must run BEFORE criticReviews are extracted from the untrusted file');
});

// ---------------------------------------------------------------------------
// The Stage (TS): the archive-read branch had zero validation before
// extraction (the separate live-fetch branch has its own paywall/star checks).
// ---------------------------------------------------------------------------

test('The Stage (TS) archive-read branch validates before trusting the cached HTML, and falls through to live fetch on mismatch', () => {
  const idx = SRC.indexOf("path.join(tsArchiveDir, `${show.id}.html`)");
  assert.ok(idx > 0, 'must still locate the thestage-roundups archive path');
  const scope = SRC.slice(idx, idx + 1200);
  assert.match(scope, /checkArchiveCategory\(candidateHtml, show, siblingCategoriesByShowId\(\)\[show\.id\]\)/,
    'the TS cached-archive read must call checkArchiveCategory with siblingCategories');
  assert.match(scope, /tsHtml = candidateHtml/, 'must only trust the archive HTML after the check passes');
  assert.match(scope, /fs\.renameSync\(tsArchivePath, tsArchivePath \+ '\.mismatch'\)/,
    'an identity mismatch must quarantine the archive file');
});

test('The Stage (TS) live-fetch write ALSO requires checkArchiveCategory, not just content-shape checks', () => {
  const idx = SRC.indexOf('const hasStars = tsHtml &&');
  assert.ok(idx > 0, 'must still locate the live-fetch content-shape guard');
  const scope = SRC.slice(idx, idx + 1200);
  assert.match(scope, /const tsLiveCatCheck = tsHtml \? checkArchiveCategory\(tsHtml, show, siblingCategoriesByShowId\(\)\[show\.id\]\) : /,
    'the live-fetched HTML must ALSO be checked before being archived — content-shape checks (stars/paywall/length) alone do not verify identity, and roundupUrl was chosen by title-only matchTitleToShow');
  const writeIdx = scope.indexOf('fs.writeFileSync(tsArchivePath, tsHtml)');
  const gateIdx = scope.indexOf('if (tsHtml && hasStars && !hasPaywall && tsHtml.length > 2000 && tsLiveCatCheck.ok)');
  assert.ok(gateIdx >= 0 && gateIdx < writeIdx,
    'tsLiveCatCheck.ok must gate the write alongside the existing content-shape checks, not replace them');
});

// ---------------------------------------------------------------------------
// WestEndTheatre (WET): write-only metadata marker, never read back for
// content — confirmed via grep, no additional guard is applicable here.
// ---------------------------------------------------------------------------

test('WestEndTheatre (WET) archive write is documented as a checked no-op site (write-only marker, no content read back)', () => {
  const idx = RAW.indexOf("path.join(DATA_DIR, 'aggregator-archive', 'westendtheatre')");
  assert.ok(idx > 0, 'must still locate the westendtheatre archive dir');
  const scope = RAW.slice(Math.max(0, idx - 700), idx);
  assert.match(scope, /BRO-3616 checked/, 'must document that this write-only marker was explicitly checked, not assumed safe');
});
