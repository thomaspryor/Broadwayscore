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
  isPunctuationFalsePositive,
  checkTitleMatchSiblingGuards,
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

// BRO-3607: the rescue path used to return ok:true before any sibling guard
// ran, because validateRoundupPageTitle() only runs them after a word match
// and a 'page-title-mismatch' returns early. "Q.E.D." vs "QED" is a
// mismatch the punctuation rescue accepts, so a "(Broadway)" page in the
// regional show's cache slipped through.
test('BRO-3607: a punctuation-RESCUED page carrying a sibling market qualifier is REJECTED for the regional show', () => {
  const html = page('QED (Broadway) Reviews');
  const show = { title: 'Q.E.D.', category: 'regional' };
  // Precondition: this really is the rescue path, not the word-match path.
  const raw = validateRoundupPageTitle(html, show.title, show.category, ['broadway']);
  assert.equal(raw.reason, 'page-title-mismatch', JSON.stringify(raw));
  assert.equal(isPunctuationFalsePositive(raw.pageTitle, show.title), true);

  const check = checkArchiveCategory(html, show, ['broadway']);
  assert.equal(check.ok, false, JSON.stringify(check));
  assert.equal(check.reason, 'cross-market-sibling', JSON.stringify(check));
  assert.equal(check.pageMarketQualifier, 'broadway', JSON.stringify(check));
  assert.equal(check.rescuedTitle, true, JSON.stringify(check));
});

test('BRO-3607: the same rescued page is still ACCEPTED for the Broadway show and for a regional show with no sibling there', () => {
  const html = page('QED (Broadway) Reviews');
  const broadway = checkArchiveCategory(html, { title: 'Q.E.D.', category: 'broadway' }, ['regional']);
  assert.equal(broadway.ok, true, JSON.stringify(broadway));
  assert.equal(broadway.rescued, true, JSON.stringify(broadway));
  // Regional show whose only sibling is off-broadway: the "(Broadway)"
  // qualifier names no sibling market, so the rescue stands.
  const regional = checkArchiveCategory(html, { title: 'Q.E.D.', category: 'regional' }, ['off-broadway']);
  assert.equal(regional.ok, true, JSON.stringify(regional));
  assert.equal(regional.rescued, true, JSON.stringify(regional));
});

test('BRO-3607: a normal rescue for a regional show with an unqualified page is still ok', () => {
  const check = checkArchiveCategory(
    page('QED Reviews'),
    { title: 'Q.E.D.', category: 'regional' },
    ['broadway'],
  );
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.rescued, true, JSON.stringify(check));
});

// Cousin of the above, found by the integrity audit once it shared this
// predicate: nyc-theatre/and-juliet-tour-2024.html held the "Romeo + Juliet"
// roundup. Word matching fails ("& Juliet" has one significant word), the
// rescue accepted it on "juliet", and the containing-title-sibling guard
// never ran. findContainingTitleSibling() indexes data/shows.json (private
// data, absent in a fresh checkout), so this one skips without it; the
// cross-market tests above are hermetic.
const showsJsonHasRomeoJuliet = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8'));
    return (Array.isArray(raw) ? raw : raw.shows || []).some(s => /^romeo \+ juliet$/i.test(s.title || ''));
  } catch { return false; }
})();
test('BRO-3607: a punctuation-rescued page naming a LONGER containing title is REJECTED (containing-title-sibling)',
  { skip: !showsJsonHasRomeoJuliet && 'data/shows.json missing or has no "Romeo + Juliet" entry' }, () => {
  const pageTitle = 'Reviews: Review Roundup: Romeo + Juliet - News from New York City Theatre';
  const raw = validateRoundupPageTitle(page(pageTitle), '& Juliet', 'tour', []);
  assert.equal(raw.reason, 'page-title-mismatch', JSON.stringify(raw));
  assert.equal(isPunctuationFalsePositive(pageTitle, '& Juliet'), true);

  const check = checkArchiveCategory(page(pageTitle), { title: '& Juliet', category: 'tour' }, []);
  assert.equal(check.ok, false, JSON.stringify(check));
  assert.equal(check.reason, 'containing-title-sibling', JSON.stringify(check));
});

test('BRO-3607: checkTitleMatchSiblingGuards is the one sibling check validateRoundupPageTitle also uses', () => {
  const html = page('Little Bear Ridge Road (Broadway)');
  const direct = checkTitleMatchSiblingGuards(html, 'Little Bear Ridge Road (Broadway)', 'Little Bear Ridge Road', 'regional', ['broadway']);
  const viaValidator = validateRoundupPageTitle(html, 'Little Bear Ridge Road', 'regional', ['broadway']);
  assert.equal(direct.reason, 'cross-market-sibling');
  assert.equal(viaValidator.reason, direct.reason);
  assert.equal(viaValidator.pageMarketQualifier, direct.pageMarketQualifier);
  assert.equal(checkTitleMatchSiblingGuards(html, 'Little Bear Ridge Road (Broadway)', 'Little Bear Ridge Road', 'broadway', ['regional']), null);
});

test('BRO-3607: the integrity audit uses checkArchiveCategory, not its own copy of the rescue', () => {
  // BRO-6141: the scan lives in lib/aggregator-archive-scan.js, shared by the audit and the quarantine script.
  const audit = fs.readFileSync(new URL('../audit-aggregator-archive-integrity.js', import.meta.url), 'utf8');
  const src = fs.readFileSync(new URL('./aggregator-archive-scan.js', import.meta.url), 'utf8');
  assert.match(audit, /require\('\.\/lib\/aggregator-archive-scan'\)/);
  assert.match(src, /checkArchiveCategory\(html, show, siblingCategoriesById\[showId\]\)/);
  assert.doesNotMatch(src + audit, /isPunctuationFalsePositive\(/);
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

test('scrape-dtli.js (BRO-2565): read-path guard runs BOTH validatePageMatchesShow (year/LLM) and checkArchiveCategory, not a replacement', () => {
  const src = readScraperSource('../scrape-dtli.js');

  // Anchor on the validatePageMatchesShow call, which is unique to the read
  // path (the write path's equivalent call, inside findDTLIPage(), uses a
  // differently-shaped argument list). A prior version of this fix REPLACED
  // this call with a bare checkArchiveCategory() — losing year-mismatch
  // detection for a same-title, same-category stale revival, which the
  // category-aware check cannot see. Flagged in review; both must now run.
  const validateIdx = src.indexOf('const cacheValidation = await validatePageMatchesShow(archiveContent, show.title,');
  assert.ok(validateIdx > 0, 'processShow() must still run the year/LLM identity check on the cached archive');

  const catIdx = src.indexOf('const catCheck = checkArchiveCategory(archiveContent, show,');
  assert.ok(catIdx > validateIdx, 'processShow() must ALSO run checkArchiveCategory, after the identity check');

  const scope = src.slice(validateIdx, catIdx + 500);
  assert.match(scope, /if\s*\(\s*!cacheValidation\.valid\s*\|\|\s*!catCheck\.ok\s*\)/,
    'the read-path check must require BOTH checks to pass, not just one');
  assert.match(scope, /fs\.unlinkSync\(archivePath\)/, 'a failed read-path check must delete the poisoned cache file');
});

test('scrape-playbill-verdict.js (BRO-2565): processShowViaGoogle write-path guard runs before the archive is written', () => {
  const src = readScraperSource('../scrape-playbill-verdict.js');

  // Anchor on the write path's own identity-check variable name
  // (articleValidation) — checkArchiveCategory's call arguments are
  // byte-identical between the read and write sites in this file, so
  // anchoring on that call alone would silently match the wrong site.
  const articleValidationIdx = src.indexOf('const articleValidation = await validatePageMatchesShow(html, show.title,');
  assert.ok(articleValidationIdx > 0, 'processShowViaGoogle() must still run the identity check on the fetched article');

  const guardIdx = src.indexOf('const catCheck = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);', articleValidationIdx);
  const writeIdx = src.indexOf('fs.writeFileSync(existingArchive, html);');
  assert.ok(guardIdx > articleValidationIdx, 'processShowViaGoogle() must call checkArchiveCategory on the fetched article');
  assert.ok(writeIdx > 0, 'processShowViaGoogle() must still write the archive');
  assert.ok(guardIdx < writeIdx,
    'the category guard must run BEFORE the cache write');

  const between = src.slice(guardIdx, writeIdx);
  assert.match(between, /if\s*\(\s*!catCheck\.ok\s*\)/, 'the guard result must be branched on');
  assert.match(between, /continue\s*;/, 'a failed category check must `continue` to the next candidate URL');
});

test('scrape-playbill-verdict.js (BRO-2565): processShowViaGoogle read-path guard runs BOTH checks, not a replacement', () => {
  const src = readScraperSource('../scrape-playbill-verdict.js');

  // Anchor on the read path's own identity-check variable name
  // (cacheValidation) to disambiguate from the write path's identical
  // checkArchiveCategory() call arguments (see the write-path test above).
  const cacheValidationIdx = src.indexOf('const cacheValidation = await validatePageMatchesShow(html, show.title,');
  assert.ok(cacheValidationIdx > 0, 'processShowViaGoogle() must still run the year/category identity check on the cached HTML');

  const catIdx = src.indexOf('const catCheck = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);', cacheValidationIdx);
  assert.ok(catIdx > cacheValidationIdx, 'processShowViaGoogle() must ALSO run checkArchiveCategory, after the identity check');

  const scope = src.slice(cacheValidationIdx, catIdx + 500);
  assert.match(scope, /if\s*\(\s*!cacheValidation\.valid\s*\|\|\s*!catCheck\.ok\s*\)/,
    'the read-path check must require BOTH checks to pass, not just one');
  assert.match(scope, /fs\.unlinkSync\(effectiveArchive\)/, 'a failed read-path check must delete the poisoned cache file');
});

test('scrape-nyc-theatre-roundups.js (BRO-2565): write-path guard runs before the archive is written', () => {
  const src = readScraperSource('../scrape-nyc-theatre-roundups.js');

  // Anchor on the write path's own identity-check call (openingYear-only
  // options, no cacheValidation/catCheck naming ambiguity issue here since
  // the read path uses the differently-named `cacheValidation` variable —
  // see the read-path test below).
  const validationIdx = src.indexOf('const validation = await validatePageMatchesShow(html, show.title,');
  assert.ok(validationIdx > 0, 'the fresh-fetch path must still run the identity check on the fetched page');

  const guardIdx = src.indexOf('const catCheck = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);', validationIdx);
  const writeIdx = src.indexOf('fs.writeFileSync(archivePath, html);');
  assert.ok(guardIdx > validationIdx, 'the fresh-fetch path must call checkArchiveCategory on the fetched page');
  assert.ok(writeIdx > 0, 'the fresh-fetch path must still write the archive');
  assert.ok(guardIdx < writeIdx,
    'the category guard must run BEFORE the cache write');

  const between = src.slice(guardIdx, writeIdx);
  assert.match(between, /if\s*\(\s*!catCheck\.ok\s*\)/, 'the guard result must be branched on');
  assert.match(between, /continue\s*;/, 'a failed category check must `continue` to the next show');
});

test('scrape-nyc-theatre-roundups.js (BRO-2565): read-path guard runs BOTH checks, not a replacement', () => {
  const src = readScraperSource('../scrape-nyc-theatre-roundups.js');

  // Anchor on the read path's own identity-check variable name
  // (cacheValidation, renamed from `validation` specifically to disambiguate
  // from the write path's identically-named pre-existing variable).
  const cacheValidationIdx = src.indexOf('const cacheValidation = await validatePageMatchesShow(html, show.title,');
  assert.ok(cacheValidationIdx > 0, 'the cache-hit branch must still run the identity check on the cached HTML');

  const catIdx = src.indexOf('const catCheck = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);', cacheValidationIdx);
  assert.ok(catIdx > cacheValidationIdx, 'the cache-hit branch must ALSO run checkArchiveCategory, after the identity check');

  const scope = src.slice(cacheValidationIdx, catIdx + 500);
  assert.match(scope, /if\s*\(\s*!cacheValidation\.valid\s*\|\|\s*!catCheck\.ok\s*\)/,
    'the read-path check must require BOTH checks to pass, not just one');
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
  assert.match(between, /if\s*\(\s*archiveFresh\s*&&\s*!DRY_RUN\s*\)\s*fs\.unlinkSync\(archivePath\)/,
    'a cache-hit that fails re-validation must purge the poisoned file (BRO-2549 read-path pattern), not just skip silently for up to 14 more days — but never during --dry-run, which promises to write nothing');
});

test('makeArchiveShowChecker: a page saved under one show id but about another show fails (BRO-4563)', () => {
  const { makeArchiveShowChecker } = require('./archive-cache-guard.js');
  const shows = [
    { id: 'richard-ii-off-west-end-2026', title: 'Richard II', category: 'off-west-end' },
    { id: 'hay-fever-west-end-2026', title: 'Hay Fever', category: 'west-end' },
  ];
  const check = makeArchiveShowChecker(shows);
  const page = t => `<html><head><title>${t}</title></head><body></body></html>`;
  const hayFever = page('Review Roundup: Richard E. Grant & Christine Baranski in HAY FEVER, UK / West End | BroadwayWorld');
  const bad = check(hayFever, 'richard-ii-off-west-end-2026');
  assert.ok(bad, 'the Hay Fever roundup must not pass as Richard II');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(check(hayFever, 'hay-fever-west-end-2026'), null, 'the same page passes for its own show');
  assert.strictEqual(check(page('Review Roundup: RICHARD II at the Bridge Theatre, UK / West End | BroadwayWorld'), 'richard-ii-off-west-end-2026'), null);
  assert.strictEqual(check(hayFever, 'not-in-shows-json'), null, 'an id with no show is left to the caller');
});

// BRO-6141: the containing-title-sibling guard flagged a page as a sibling's when the
// "sibling" was only another market's production of the same work. Uses the real
// shows.json titles (the containment index reads it); skipped where it is absent.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const showsPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'shows.json');
  const all = fs.existsSync(showsPath) ? (() => { const r = JSON.parse(fs.readFileSync(showsPath, 'utf8')); return r.shows || r; })() : [];
  const byId = Object.fromEntries(all.map(s => [s.id, s]));
  const { checkArchiveCategory } = require('./archive-cache-guard.js');
  const html = (t, canonical = '') => `<html><head><title>${t}</title>${canonical}</head><body></body></html>`;
  const have = (...ids) => ids.every(id => byId[id]);

  test('BRO-6141: Broadway page "Tina: The Tina Turner Musical on Broadway" is Tina\'s, not the West End sibling\'s', { skip: !have('tina-2019', 'tina-the-tina-turner-musical-west-end-2018') }, () => {
    const show = byId['tina-2019'];
    assert.equal(checkArchiveCategory(html('Read the Reviews for Tina: The Tina Turner Musical on Broadway | Playbill'), show, []).ok, true);
    const dtli = html('TINA, The Tina Turner Musical - Did They Like It?', '<link rel="canonical" href="https://didtheylikeit.com/shows/tina-the-tina-turner-musical-review/" />');
    assert.equal(checkArchiveCategory(dtli, show, []).ok, true, 'Did They Like It is a Broadway site');
    assert.equal(checkArchiveCategory(html('TINA, The Tina Turner Musical - Did They Like It?'), show, []).ok, false, 'no market signal at all stays rejected');
  });

  test('BRO-6141: Show Score "(West End)" page for the West End Old Friends passes; the Broadway-titled roundup does not', { skip: !have('old-friends-west-end-2023', 'stephen-sondheims-old-friends-2025') }, () => {
    const show = byId['old-friends-west-end-2023'];
    assert.equal(checkArchiveCategory(html("Show Score | Stephen Sondheim's Old Friends (West End) London Reviews and Tickets"), show, []).ok, true);
    const bad = checkArchiveCategory(html("Review Roundup: STEPHEN SONDHEIM'S OLD FRIENDS Opens On Broadway"), show, []);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'containing-title-sibling');
  });

  test('BRO-6141: a longer title that exists in the page\'s own market is still a different show', { skip: !have('a-christmas-carol-west-end-2022', 'christmas-carol-goes-wrong-apollo-west-end-2025') }, () => {
    const bad = checkArchiveCategory(html('Review Round-Up: CHRISTMAS CAROL GOES WRONG at the Apollo Theatre (West End)'), byId['a-christmas-carol-west-end-2022'], []);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'containing-title-sibling');
  });

  test('BRO-6141: a West End-only longer title is NOT rescued for a show outside the verified list', { skip: !have('a-christmas-carol-2022', 'christmas-carol-goes-wrong-apollo-west-end-2025') }, () => {
    const bad = checkArchiveCategory(html('Christmas Carol Goes Wrong (Broadway) Reviews | Show Score'), byId['a-christmas-carol-2022'], []);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'containing-title-sibling');
  });
}
