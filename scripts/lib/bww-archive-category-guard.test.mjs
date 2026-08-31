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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  validateRoundupPageTitle,
  buildSiblingCategoriesByTitle,
} = require('./show-matching.js');

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
  // validateRoundupPageTitle(), so a bare indexOf on the function name matches
  // prose and would stay green even if the real call were deleted — the exact
  // weakness an adversarial review caught in the first version of this test.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  // Anchor on the ASSIGNMENT, which cannot appear in prose.
  const guardIdx = src.indexOf('const catCheck = validateRoundupPageTitle(');
  const writeIdx = src.indexOf('fs.writeFileSync(archivePath, html)');
  assert.ok(guardIdx > 0, 'scraper must call validateRoundupPageTitle and bind the result');
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
