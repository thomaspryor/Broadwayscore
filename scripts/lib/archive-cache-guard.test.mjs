// timebomb-audit-exempt: archive-cache-guard.js measures cache age as
//   (Date.now() - fs.statSync(archivePath).mtimeMs). audit-time-bomb-
//   tests.js shifts the PROCESS clock but cannot shift the FILESYSTEM, so
//   under a shifted run every cache fixture written by these tests reads as
//   decades old. Not a real time bomb — production compares two readings of
//   the same real clock. Same class as tests/unit/ttl-cache.test.mjs; see
//   that file's exemption for the general note in
//   scripts/audit-time-bomb-tests.js's own docstring.
//
// Regression guard for the poisoned aggregator-archive-cache class.
//
// A regional premiere and its later Broadway transfer share a title, so
// validatePageMatchesShow() / validateRoundupPageTitle() without sibling
// categories (title + opening year, or bare word-match) cannot separate
// them: the transfer's page carries the transfer's own year. BRO-2547/2549
// fixed this for BroadwayWorld's /reviews/ and roundup archives by wiring
// checkArchiveCategory() (validateRoundupPageTitle() + a punctuation-mismatch
// rescue + the cross-market-sibling check) into both the write path and the
// read path. Three caches were quarantined 2026-08-23 and re-created
// verbatim by the next scrape run on 2026-08-30 (472e288ba68) BEFORE the
// read-path guard existed — proof that a write-time-only guard doesn't hold.
//
// BRO-2565 generalized that predicate out of bww-archive-category-guard.js
// into this file (archive-cache-guard.js) and wired it into DTLI, Playbill
// Verdict, NYC Theatre, and London Box Office — the other 4 aggregator
// scrapers that read a cached archive file on disk without re-validating it
// against the show it's filed under.
//
// These tests require() the real functions — production changes must break
// them.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  validateRoundupPageTitle,
  buildSiblingCategoriesByTitle,
} = require('./show-matching.js');
const { readCachedArchiveIfValid, checkArchiveCategory } = require('./archive-cache-guard.js');

const page = (title) => `<html><head><title>${title}</title></head><body>feedbacks</body></html>`;

// ---------------------------------------------------------------------------
// The shared predicate — buildSiblingCategoriesByTitle / validateRoundupPageTitle
// / checkArchiveCategory. Every scraper below delegates to exactly this, so
// proving it correct once covers the behavior all 5 scrapers depend on.
// ---------------------------------------------------------------------------

test('buildSiblingCategoriesByTitle surfaces the transfer category for a same-title regional show', () => {
  const showById = {
    'little-bear-ridge-road-regional-2024': { id: 'little-bear-ridge-road-regional-2024', title: 'Little Bear Ridge Road', category: 'regional' },
    'little-bear-ridge-road-2025': { id: 'little-bear-ridge-road-2025', title: 'Little Bear Ridge Road', category: 'broadway' },
    'unrelated-2025': { id: 'unrelated-2025', title: 'Something Else', category: 'broadway' },
  };
  const idx = buildSiblingCategoriesByTitle(showById);
  assert.deepEqual(idx['little-bear-ridge-road-regional-2024'], ['broadway']);
  assert.deepEqual(idx['little-bear-ridge-road-2025'], ['regional']);
  // A title with no same-title sibling must yield an empty list, never undefined —
  // validateRoundupPageTitle treats a missing list as "no cross-market signal".
  assert.deepEqual(idx['unrelated-2025'], []);
});

test('ACCEPTANCE: a Broadway-qualified page is REJECTED for the regional sibling (the poisoned-cache case)', () => {
  const idx = buildSiblingCategoriesByTitle({
    'little-bear-ridge-road-regional-2024': { id: 'little-bear-ridge-road-regional-2024', title: 'Little Bear Ridge Road', category: 'regional' },
    'little-bear-ridge-road-2025': { id: 'little-bear-ridge-road-2025', title: 'Little Bear Ridge Road', category: 'broadway' },
  });
  const v = validateRoundupPageTitle(
    page('Little Bear Ridge Road Broadway Reviews'),
    'Little Bear Ridge Road',
    'regional',
    idx['little-bear-ridge-road-regional-2024'],
  );
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.equal(v.reason, 'cross-market-sibling', JSON.stringify(v));
});

test('the same page is ACCEPTED for the Broadway show itself (guard does not over-block)', () => {
  const idx = buildSiblingCategoriesByTitle({
    'little-bear-ridge-road-regional-2024': { id: 'little-bear-ridge-road-regional-2024', title: 'Little Bear Ridge Road', category: 'regional' },
    'little-bear-ridge-road-2025': { id: 'little-bear-ridge-road-2025', title: 'Little Bear Ridge Road', category: 'broadway' },
  });
  const v = validateRoundupPageTitle(
    page('Little Bear Ridge Road Broadway Reviews'),
    'Little Bear Ridge Road',
    'broadway',
    idx['little-bear-ridge-road-2025'],
  );
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('an unqualified page is ACCEPTED for the regional show (no false positive on the common case)', () => {
  const v = validateRoundupPageTitle(
    page('Little Bear Ridge Road Reviews'),
    'Little Bear Ridge Road',
    'regional',
    ['broadway'],
  );
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('checkArchiveCategory rescues a punctuation-formatting false positive (matches the audit\'s policy)', () => {
  const check = checkArchiveCategory(
    page('ON YOUR FEET Broadway Reviews | Broadway World'),
    { title: 'On Your Feet!', category: 'broadway' },
    [],
  );
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.rescued, true, JSON.stringify(check));
});

test('checkArchiveCategory does NOT rescue cross-market-sibling (distinct, deliberate check)', () => {
  const idx = buildSiblingCategoriesByTitle({
    'little-bear-ridge-road-regional-2024': { id: 'little-bear-ridge-road-regional-2024', title: 'Little Bear Ridge Road', category: 'regional' },
    'little-bear-ridge-road-2025': { id: 'little-bear-ridge-road-2025', title: 'Little Bear Ridge Road', category: 'broadway' },
  });
  const check = checkArchiveCategory(
    page('Little Bear Ridge Road Broadway Reviews'),
    { title: 'Little Bear Ridge Road', category: 'regional' },
    idx['little-bear-ridge-road-regional-2024'],
  );
  assert.equal(check.ok, false, JSON.stringify(check));
  assert.equal(check.reason, 'cross-market-sibling', JSON.stringify(check));
});

// ---------------------------------------------------------------------------
// readCachedArchiveIfValid — the TTL-aware read-path wrapper scrape-bww-
// reviews.js calls directly. data/aggregator-archive/ is gitignored (private
// repo, CLAUDE.md §11), so fixtures live in a temp dir with the same shape
// rather than being committed — readCachedArchiveIfValid() takes an
// arbitrary path.
// ---------------------------------------------------------------------------

function makeArchiveDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

test('ACCEPTANCE: a poisoned cache entry under the TTL is purged, not served', () => {
  const dir = makeArchiveDir('archive-cache-guard');
  const archivePath = path.join(dir, 'gin-game-regional.html');
  // A Broadway transfer's page cached under the regional show's id — the
  // exact contamination class the write-time guard exists for.
  fs.writeFileSync(archivePath, page('The Gin Game Broadway Reviews'));

  const result = readCachedArchiveIfValid(
    archivePath, 14, { title: 'The Gin Game', category: 'regional' }, ['broadway'],
  );

  assert.equal(result.valid, false, JSON.stringify(result));
  assert.equal(result.purged, true, JSON.stringify(result));
  assert.equal(result.check.reason, 'cross-market-sibling', JSON.stringify(result));
  assert.equal(fs.existsSync(archivePath), false,
    'poisoned file must be deleted so the caller falls through to a fresh fetch');
});

test('a valid cache entry under the TTL is served', () => {
  const dir = makeArchiveDir('archive-cache-guard');
  const archivePath = path.join(dir, 'heated-rivalry-2026.html');
  fs.writeFileSync(archivePath, page('Heated Rivalry Reviews'));

  const result = readCachedArchiveIfValid(
    archivePath, 14, { title: 'Heated Rivalry', category: 'broadway' }, [],
  );

  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.html, page('Heated Rivalry Reviews'));
  assert.equal(fs.existsSync(archivePath), true, 'a valid cache entry is left in place');
});

test('no cache file returns null (normal cold-cache path, unchanged)', () => {
  const dir = makeArchiveDir('archive-cache-guard');
  assert.equal(
    readCachedArchiveIfValid(path.join(dir, 'does-not-exist.html'), 14, { title: 'X', category: 'broadway' }, []),
    null,
  );
});

test('a poisoned entry older than the cache window returns null without purging (age check already forces a refetch)', () => {
  const dir = makeArchiveDir('archive-cache-guard');
  const archivePath = path.join(dir, 'gin-game-regional.html');
  fs.writeFileSync(archivePath, page('The Gin Game Broadway Reviews'));
  const fifteenDaysAgo = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(archivePath, fifteenDaysAgo, fifteenDaysAgo);

  const result = readCachedArchiveIfValid(
    archivePath, 14, { title: 'The Gin Game', category: 'regional' }, ['broadway'],
  );

  assert.equal(result, null, JSON.stringify(result));
  // The existing age-based refetch already handles this case; the read-path
  // guard only needs to act inside the trusted-cache window.
  assert.equal(fs.existsSync(archivePath), true);
});

// ---------------------------------------------------------------------------
// Per-scraper wiring. Each of the 5 scrapers below has its own bespoke
// cache-freshness logic (no TTL for DTLI, custom slug-fallback TTL for
// Playbill Verdict/NYC Theatre/LBO), so unlike scrape-bww-reviews.js they
// call checkArchiveCategory() directly rather than through
// readCachedArchiveIfValid()'s wrapper. These tests anchor on the actual
// call sites (assignment statements, which cannot appear in prose/comments)
// to prove: (1) both the read path and the write path call
// checkArchiveCategory(), (2) a failed read-path check purges the cache
// file, and (3) the write-path check runs BEFORE the archive is persisted.
// ---------------------------------------------------------------------------

function stripComments(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

function readScraperSource(relPath) {
  return stripComments(fs.readFileSync(new URL(relPath, import.meta.url), 'utf8'));
}

test('scrape-bww-reviews.js calls checkArchiveCategory before writing the archive (BWW write-path wiring)', () => {
  const src = readScraperSource('../scrape-bww-reviews.js');

  const guardIdx = src.indexOf('const catCheck = checkArchiveCategory(');
  const writeIdx = src.indexOf('fs.writeFileSync(archivePath, html)');
  assert.ok(guardIdx > 0, 'scraper must call checkArchiveCategory and bind the result');
  assert.ok(writeIdx > 0, 'scraper must still write the archive');
  assert.ok(guardIdx < writeIdx,
    'the category guard must run BEFORE the cache write — otherwise the poisoned page is already on disk');

  const between = src.slice(guardIdx, writeIdx);
  assert.match(between, /if\s*\(\s*!catCheck\.ok\s*\)/,
    'the guard result must be branched on');
  assert.match(between, /continue\s*;/,
    'a failed category check must `continue` to the next slug, not fall through to the write');
});

test('scrape-bww-reviews.js runs the read-path guard on BOTH cache lookups before returning the cached html', () => {
  const src = readScraperSource('../scrape-bww-reviews.js');

  const calls = src.match(/const cached = readCachedArchiveIfValid\(/g) || [];
  assert.equal(calls.length, 2,
    'both fetchBwwReviewsPage() and discoverBwwRoundup() must validate their cached HTML before returning it');

  const NEEDLE = 'const cached = readCachedArchiveIfValid(';
  const starts = [];
  for (let from = 0; ; ) {
    const at = src.indexOf(NEEDLE, from);
    if (at === -1) break;
    starts.push(at);
    from = at + NEEDLE.length;
  }
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : start + 1200;
    const scope = src.slice(start, end);
    assert.match(scope, /if\s*\(\s*cached\.valid\s*\)/, `call site ${i + 1} must branch on cached.valid`);
    assert.match(scope, /return cached\.html/, `call site ${i + 1} must return cached.html only on the valid branch`);
  });
});

test('scrape-bww-reviews.js roundup write paths carry the same category guard the /reviews/ write path has (BRO-2549)', () => {
  const src = readScraperSource('../scrape-bww-reviews.js');
  const guardCalls = (src.match(/const catCheck = checkArchiveCategory\(/g) || []).length;
  assert.equal(guardCalls, 3,
    'expected 3 catCheck call sites: /reviews/ write, forceRoundupUrl write, and the main roundup-search write');
});

test('scrape-dtli.js (BRO-2565): write-path guard runs before the fetched page is returned for archiving', () => {
  const src = readScraperSource('../scrape-dtli.js');

  const guardIdx = src.indexOf('const catCheck = checkArchiveCategory(result.html, show,');
  const returnIdx = src.indexOf('return { url, html: result.html, slug };');
  assert.ok(guardIdx > 0, 'findDTLIPage() must call checkArchiveCategory on the fetched html');
  assert.ok(returnIdx > 0, 'findDTLIPage() must still return the matched page');
  assert.ok(guardIdx < returnIdx,
    'the category guard must run BEFORE the page is returned (and later archived) — otherwise a poisoned page is cached first');

  const between = src.slice(guardIdx, returnIdx);
  assert.match(between, /if\s*\(\s*!catCheck\.ok\s*\)/, 'the guard result must be branched on');
  assert.match(between, /continue\s*;/, 'a failed category check must `continue` to the next URL variation');
});

test('scrape-dtli.js (BRO-2565): read-path guard purges a poisoned cache entry before it is trusted', () => {
  const src = readScraperSource('../scrape-dtli.js');

  const guardIdx = src.indexOf('const cacheValidation = checkArchiveCategory(archiveContent, show,');
  assert.ok(guardIdx > 0, 'processShow() must re-validate the cached archive with checkArchiveCategory');

  const scope = src.slice(guardIdx, guardIdx + 500);
  assert.match(scope, /if\s*\(\s*!cacheValidation\.ok\s*\)/, 'the read-path check must be branched on');
  assert.match(scope, /fs\.unlinkSync\(archivePath\)/, 'a failed read-path check must delete the poisoned cache file');
});

test('scrape-playbill-verdict.js (BRO-2565): processShowViaGoogle write-path guard runs before the archive is written', () => {
  const src = readScraperSource('../scrape-playbill-verdict.js');

  const guardIdx = src.indexOf('const catCheck = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);');
  const writeIdx = src.indexOf('fs.writeFileSync(existingArchive, html);');
  assert.ok(guardIdx > 0, 'processShowViaGoogle() must call checkArchiveCategory on the fetched article');
  assert.ok(writeIdx > 0, 'processShowViaGoogle() must still write the archive');
  assert.ok(guardIdx < writeIdx,
    'the category guard must run BEFORE the cache write');

  const between = src.slice(guardIdx, writeIdx);
  assert.match(between, /if\s*\(\s*!catCheck\.ok\s*\)/, 'the guard result must be branched on');
  assert.match(between, /continue\s*;/, 'a failed category check must `continue` to the next candidate URL');
});

test('scrape-playbill-verdict.js (BRO-2565): processShowViaGoogle read-path guard purges a poisoned cache entry', () => {
  const src = readScraperSource('../scrape-playbill-verdict.js');

  const guardIdx = src.indexOf('const cacheValidation = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);');
  assert.ok(guardIdx > 0, 'processShowViaGoogle() must re-validate the cached archive with checkArchiveCategory');

  const scope = src.slice(guardIdx, guardIdx + 500);
  assert.match(scope, /if\s*\(\s*!cacheValidation\.ok\s*\)/, 'the read-path check must be branched on');
  assert.match(scope, /fs\.unlinkSync\(effectiveArchive\)/, 'a failed read-path check must delete the poisoned cache file');
});

test('scrape-nyc-theatre-roundups.js (BRO-2565): write-path guard runs before the archive is written', () => {
  const src = readScraperSource('../scrape-nyc-theatre-roundups.js');

  const guardIdx = src.indexOf('const catCheck = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);');
  const writeIdx = src.indexOf('fs.writeFileSync(archivePath, html);');
  assert.ok(guardIdx > 0, 'the fresh-fetch path must call checkArchiveCategory on the fetched page');
  assert.ok(writeIdx > 0, 'the fresh-fetch path must still write the archive');
  assert.ok(guardIdx < writeIdx,
    'the category guard must run BEFORE the cache write');

  const between = src.slice(guardIdx, writeIdx);
  assert.match(between, /if\s*\(\s*!catCheck\.ok\s*\)/, 'the guard result must be branched on');
  assert.match(between, /continue\s*;/, 'a failed category check must `continue` to the next show');
});

test('scrape-nyc-theatre-roundups.js (BRO-2565): read-path guard purges a poisoned cache entry', () => {
  const src = readScraperSource('../scrape-nyc-theatre-roundups.js');

  const guardIdx = src.indexOf('const validation = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);');
  assert.ok(guardIdx > 0, 'the cache-hit branch must re-validate with checkArchiveCategory');

  const scope = src.slice(guardIdx, guardIdx + 500);
  assert.match(scope, /if\s*\(\s*!validation\.ok\s*\)/, 'the read-path check must be branched on');
  assert.match(scope, /fs\.unlinkSync\(effectiveArchivePath\)/, 'a failed read-path check must delete the poisoned cache file');
});

test('scrape-london-box-office-roundups.js (BRO-2565): the shared read/write validation site uses checkArchiveCategory with siblingCategories, not a bare validateRoundupPageTitle call', () => {
  const src = readScraperSource('../scrape-london-box-office-roundups.js');

  assert.ok(!/validateRoundupPageTitle\(/.test(src),
    'LBO should no longer call validateRoundupPageTitle directly — checkArchiveCategory wraps it with the punctuation rescue and the cross-market-sibling check');

  const guardIdx = src.indexOf('const validation = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);');
  const writeIdx = src.indexOf('fs.writeFileSync(archivePath, `<!-- Source: ${url} -->\\n${html}`);');
  assert.ok(guardIdx > 0, 'the roundup loop must call checkArchiveCategory with siblingCategories');
  assert.ok(writeIdx > 0, 'the roundup loop must still write the archive');
  assert.ok(guardIdx < writeIdx,
    'the category guard must run BEFORE the cache write (this loop handles both the cache-hit and fresh-fetch cases with one check)');

  const between = src.slice(guardIdx, writeIdx);
  assert.match(between, /if\s*\(\s*!validation\.ok\s*\)/, 'the guard result must be branched on');
  assert.match(between, /if\s*\(\s*archiveFresh\s*\)\s*fs\.unlinkSync\(archivePath\)/,
    'a cache-hit that fails re-validation must purge the poisoned file (BRO-2549 read-path pattern), not just skip silently for up to 14 more days');
});
