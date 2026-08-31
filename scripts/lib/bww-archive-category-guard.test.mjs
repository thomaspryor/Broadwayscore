// Regression guard for the poisoned bww-reviews cache class.
//
// A regional premiere and its later Broadway transfer share a title, so
// scrape-bww-reviews.js's validatePageMatchesShow() (title + opening year)
// cannot separate them: the transfer's page carries the transfer's own year.
// Three caches were quarantined 2026-08-23 ("fix: quarantine 3 poisoned
// bww-reviews caches") and re-created verbatim by the next scrape run on
// 2026-08-30 (472e288ba68), reddening Data Validation step 34 again.
//
// The fix re-uses the audit's own predicate at cache-write time. These tests
// require() the real functions — production changes must break them.
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
const { readCachedArchiveIfValid, checkArchiveCategory } = require('./bww-archive-category-guard.js');

const page = (title) => `<html><head><title>${title}</title></head><body>feedbacks</body></html>`;

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

test('scrape-bww-reviews.js actually calls the guard before writing the archive', () => {
  const fs = require('fs');
  const raw = fs.readFileSync(new URL('../scrape-bww-reviews.js', import.meta.url), 'utf8');

  // Strip comments first. The block comment above the guard NAMES
  // checkArchiveCategory(), so a bare indexOf on the function name matches
  // prose and would stay green even if the real call were deleted — the exact
  // weakness an adversarial review caught in the first version of this test.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  // Anchor on the ASSIGNMENT, which cannot appear in prose.
  const guardIdx = src.indexOf('const catCheck = checkArchiveCategory(');
  const writeIdx = src.indexOf('fs.writeFileSync(archivePath, html)');
  assert.ok(guardIdx > 0, 'scraper must call checkArchiveCategory and bind the result');
  assert.ok(writeIdx > 0, 'scraper must still write the archive');
  assert.ok(guardIdx < writeIdx,
    'the category guard must run BEFORE the cache write — otherwise the poisoned page is already on disk');

  // ...and that a failed check actually short-circuits rather than logging on.
  const between = src.slice(guardIdx, writeIdx);
  assert.match(between, /if\s*\(\s*!catCheck\.ok\s*\)/,
    'the guard result must be branched on');
  assert.match(between, /continue\s*;/,
    'a failed category check must `continue` to the next slug, not fall through to the write');
});

// ---------------------------------------------------------------------------
// BRO-2549: the write-time guard above only stops a poisoned page being
// WRITTEN. Nothing stopped a poisoned page already on disk (a restore, a
// manual copy, a different writer, a rolled-back deploy) from being SERVED
// for up to 14 days — the 2026-08-23 quarantine had to be repeated by hand
// on 2026-08-30 for exactly this reason. readCachedArchiveIfValid() runs the
// same validateRoundupPageTitle() check on cached HTML before it is trusted,
// deleting and reporting-as-unusable anything that fails.
//
// data/aggregator-archive/ is gitignored (private repo, CLAUDE.md §11), so
// fixtures live in a temp dir with the same shape rather than being
// committed — readCachedArchiveIfValid() takes an arbitrary path.
// ---------------------------------------------------------------------------

function makeArchiveDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bww-reviews-'));
}

test('BRO-2549 ACCEPTANCE: a poisoned cache entry under 14 days old is purged, not served', () => {
  const dir = makeArchiveDir();
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

test('BRO-2549: a valid cache entry under 14 days old is served', () => {
  const dir = makeArchiveDir();
  const archivePath = path.join(dir, 'heated-rivalry-2026.html');
  fs.writeFileSync(archivePath, page('Heated Rivalry Reviews'));

  const result = readCachedArchiveIfValid(
    archivePath, 14, { title: 'Heated Rivalry', category: 'broadway' }, [],
  );

  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.html, page('Heated Rivalry Reviews'));
  assert.equal(fs.existsSync(archivePath), true, 'a valid cache entry is left in place');
});

test('BRO-2549: no cache file returns null (normal cold-cache path, unchanged)', () => {
  const dir = makeArchiveDir();
  assert.equal(
    readCachedArchiveIfValid(path.join(dir, 'does-not-exist.html'), 14, { title: 'X', category: 'broadway' }, []),
    null,
  );
});

test('BRO-2549: a poisoned entry older than the cache window returns null without purging (age check already forces a refetch)', () => {
  const dir = makeArchiveDir();
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

test('BRO-2549: roundup write paths now carry the same category guard the /reviews/ write path has (BRO-2547 never covered roundups)', () => {
  const fs2 = require('fs');
  const raw = fs2.readFileSync(new URL('../scrape-bww-reviews.js', import.meta.url), 'utf8');
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  // Without this, the read-path guard above (which DOES check
  // checkArchiveCategory on roundup archives) would be the only place that
  // validator ever ran against a roundup page — purging and refetching the
  // same file forever since the write path kept re-writing content the read
  // path then rejected. All three sites use checkArchiveCategory (not a bare
  // validateRoundupPageTitle call) so the write path shares the read path's
  // punctuation-false-positive rescue too — see the next test.
  const guardCalls = (src.match(/const catCheck = checkArchiveCategory\(/g) || []).length;
  assert.equal(guardCalls, 3,
    'expected 3 catCheck call sites: /reviews/ write, forceRoundupUrl write, and the main roundup-search write');
});

test('BRO-2549: a punctuation-formatting false positive is rescued, not purged (matches the audit\'s policy)', () => {
  const dir = makeArchiveDir();
  const archivePath = path.join(dir, 'on-your-feet-2026.html');
  // Same page-title-mismatch false positive documented in
  // show-matching.punctuation-fp-guard.test.mjs — the aggregator drops the
  // "!" and adds a site suffix.
  fs.writeFileSync(archivePath, page('ON YOUR FEET Broadway Reviews | Broadway World'));

  const result = readCachedArchiveIfValid(
    archivePath, 14, { title: 'On Your Feet!', category: 'broadway' }, [],
  );

  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(fs.existsSync(archivePath), true, 'a rescued false positive must not be deleted');
});

test('BRO-2549: checkArchiveCategory (what the WRITE paths call directly) rescues the same false positive', () => {
  // Round-1 adversarial review caught that the write-time guards initially
  // called bare validateRoundupPageTitle() with no rescue, while the
  // read-time guard rescued this exact case — meaning a rescued page could
  // be read from cache but never re-written after a fresh fetch, an
  // unrecoverable miss. All three write sites now call checkArchiveCategory
  // directly (see the wiring test above), so this is the function that must
  // rescue, independent of readCachedArchiveIfValid.
  const check = checkArchiveCategory(
    page('ON YOUR FEET Broadway Reviews | Broadway World'),
    { title: 'On Your Feet!', category: 'broadway' },
    [],
  );
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.rescued, true, JSON.stringify(check));
});

test('BRO-2549: checkArchiveCategory does NOT rescue cross-market-sibling (distinct, deliberate check)', () => {
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

test('BRO-2549: scrape-bww-reviews.js runs the read-path guard on BOTH cache lookups before returning the cached html', () => {
  const raw = fs.readFileSync(new URL('../scrape-bww-reviews.js', import.meta.url), 'utf8');
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  const calls = src.match(/const cached = readCachedArchiveIfValid\(/g) || [];
  assert.equal(calls.length, 2,
    'both fetchBwwReviewsPage() and discoverBwwRoundup() must validate their cached HTML before returning it');

  // For each call site, confirm an invalid result is purged-and-refetched
  // rather than returned: `cached.valid` must be branched on ahead of any
  // `return cached.html`.
  const NEEDLE = 'const cached = readCachedArchiveIfValid(';
  const starts = [];
  for (let from = 0; ; ) {
    const at = src.indexOf(NEEDLE, from);
    if (at === -1) break;
    starts.push(at);
    from = at + NEEDLE.length;
  }
  assert.equal(starts.length, calls.length, 'sanity: same call sites found both ways');
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : start + 1200;
    const scope = src.slice(start, end);
    assert.match(scope, /if\s*\(\s*cached\.valid\s*\)/, `call site ${i + 1} must branch on cached.valid`);
    assert.match(scope, /return cached\.html/, `call site ${i + 1} must return cached.html only on the valid branch`);
  });
});
