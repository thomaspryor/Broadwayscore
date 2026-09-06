import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const D = require('./doubled-market-ids.js');
const here = path.dirname(fileURLToPath(import.meta.url));

test('the real defect: a title that absorbed its market doubles it in the id', () => {
  const parts = D.doubledMarketParts('1536-west-end-off-west-end-2026');
  assert.deepEqual(parts, {
    prefix: '1536-west-end',
    market: 'off-west-end',
    year: '2026',
    doubledWord: 'west-end',
  });
  assert.equal(D.isUnallowlistedDoubledMarketId('1536-west-end-off-west-end-2026'), true);
});

test('the corrected id no longer doubles', () => {
  assert.equal(D.doubledMarketParts('1536-off-west-end-2026'), null);
  assert.equal(D.isUnallowlistedDoubledMarketId('1536-off-west-end-2026'), false);
});

// This is the case a GREEDY prefix silently misses: `(?:off-)?` is optional, so
// the longer prefix "...-of-broadway-off" plus market "broadway" also matches,
// and that prefix ends in "off", which is not a market word. MEASURED: revert
// the `?` in TRAILING_MARKET_RE and 8 of these 17 tests go red. The plain
// zero-flagged corpus assertion is NOT one of them — it stays GREEN under that
// break, because a detector that matches nothing flags nothing. That is the
// whole reason 'the detector still DETECTS every allowlisted row' exists beside
// it. Re-measure this number if you add or remove a test; do not carry it
// forward on faith.
test('an "off-" market segment is read whole, not split into a trailing "off"', () => {
  const parts = D.doubledMarketParts('lauder-scotlands-kilted-king-of-broadway-off-broadway-2026');
  assert.notEqual(parts, null, 'greedy prefix split "off-broadway" and lost the row');
  assert.equal(parts.market, 'off-broadway');
  assert.equal(parts.prefix, 'lauder-scotlands-kilted-king-of-broadway');
  assert.equal(parts.doubledWord, 'broadway');
});

test('allowlisted ids are detected but not flagged', () => {
  for (const id of D.ALLOWLIST.keys()) {
    assert.notEqual(D.doubledMarketParts(id), null, `${id} should still be DETECTED`);
    assert.equal(D.isUnallowlistedDoubledMarketId(id), false, `${id} should not be FLAGGED`);
  }
});

test('every allowlist entry carries a non-trivial reason', () => {
  for (const [id, reason] of D.ALLOWLIST) {
    assert.ok(reason && reason.length > 40, `${id} needs a reason recording what was checked`);
  }
});

test('a market word in the MIDDLE of the title is not a doubling', () => {
  // "Shrek's Adventure! London Standard Entry" — "london" is inside the title,
  // not at the seam, so nothing leaked across the join.
  assert.equal(D.doubledMarketParts('shreks-adventure-london-standard-entry-off-west-end-2026'), null);
});

test('an ordinary id with one market segment is not a doubling', () => {
  for (const id of [
    '1536-west-end-2026',
    'redwood-2025',
    'music-city-off-broadway-2026',
    'paranormal-activity-chicago-regional-2025',
    'hamilton-broadway-2015',
  ]) {
    assert.equal(D.doubledMarketParts(id), null, `${id} should not be a doubling`);
  }
});

test('ids with no year suffix and junk input are non-matches, not throws', () => {
  for (const id of ['', null, undefined, 'no-year-here', 'broadway', 'broadway-2026']) {
    assert.equal(D.doubledMarketParts(id), null);
  }
});

test('the vocabulary is borrowed from playbill-title-match, not copied', () => {
  const src = fs.readFileSync(path.join(here, 'doubled-market-ids.js'), 'utf8');
  assert.ok(
    /require\('\.\/playbill-title-match'\)/.test(src),
    'MARKET_KEYWORDS must come from playbill-title-match.js',
  );
  assert.ok(
    !/const MARKET_KEYWORDS\s*=\s*\[/.test(src),
    'a second copy of the market vocabulary is exactly the drift BRO-2894 is about',
  );
});

test('sweepShows separates flagged from allowlisted', () => {
  const { flagged, allowlisted } = D.sweepShows([
    { id: '1536-west-end-off-west-end-2026', title: '1536 West End' },
    { id: 'lauder-scotlands-kilted-king-of-broadway-off-broadway-2026', title: 'Lauder' },
    { id: 'redwood-2025', title: 'Redwood' },
  ]);
  assert.deepEqual(flagged.map((r) => r.id), ['1536-west-end-off-west-end-2026']);
  assert.deepEqual(allowlisted.map((r) => r.id), [
    'lauder-scotlands-kilted-king-of-broadway-off-broadway-2026',
  ]);
  assert.ok(allowlisted[0].reason.length > 40);
});

// SYNTHETIC COVERAGE OVER THE WHOLE VOCABULARY, so the detector cannot be
// narrowed to "recognise the three ids we happen to have" and stay green. The
// corpus assertions below pin only today's three rows; on their own, a
// doubledMarketParts() rewritten as a lookup of those three literals passes
// every one of them. This table is what makes that mutation fail: every
// keyword, in bare and "off-" form, against every market segment form.
// A TRIPWIRE, NOT A CARDINALITY FLOOR. The matrix below is exhaustive over
// whatever MARKET_KEYWORDS holds, so it cannot go stale — but "exhaustive over a
// list that quietly lost an entry" is still zero coverage for that entry.
// Measured: stub the import without 'london' and every other assertion in this
// file stays green while "bar-london-off-west-end-2026" starts returning null,
// because 'london' is named in only one test and that test asserts null. So the
// vocabulary itself is pinned here. This is NOT a copy of the list (the module
// still imports it, and another test asserts that): it is a statement that
// changing the list is a decision someone must come here and confirm.
const EXPECTED_VOCABULARY = ['broadway', 'regional', 'tour', 'west-end', 'london'];

test('the borrowed market vocabulary has not changed underneath this detector', () => {
  const { MARKET_KEYWORDS } = require('./playbill-title-match.js');
  assert.deepEqual(
    [...MARKET_KEYWORDS].sort(),
    [...EXPECTED_VOCABULARY].sort(),
    'MARKET_KEYWORDS changed in playbill-title-match.js. That may be right — but '
      + 'a REMOVED keyword silently stops being detected here, and an ADDED one '
      + 'arrives with no allowlist review. Update EXPECTED_VOCABULARY deliberately.',
  );
});

test('every MARKET_KEYWORDS x market-segment pair at the seam is detected', () => {
  const { MARKET_KEYWORDS } = require('./playbill-title-match.js');
  const segments = MARKET_KEYWORDS.flatMap((k) => [k, `off-${k}`]);
  // Varied, ordinary-looking title slugs rather than one synthetic marker, so a
  // mutation cannot special-case the fixture prefix and stay green.
  const prefixes = ['a-quiet-place', 'the-winters-tale', 'hadestown', '1776', 'jajas-african-hair-braiding'];
  let checked = 0;
  for (const seamWord of MARKET_KEYWORDS) {
    for (const segment of segments) {
      const stem = prefixes[checked % prefixes.length];
      const id = `${stem}-${seamWord}-${segment}-2026`;
      const parts = D.doubledMarketParts(id);
      assert.notEqual(parts, null, `${id} should be detected`);
      assert.equal(parts.market, segment, `${id}: market should be the whole segment`);
      assert.equal(parts.prefix, `${stem}-${seamWord}`, `${id}: prefix should stop at the seam`);
      assert.equal(parts.doubledWord, seamWord, `${id}: seam word should be ${seamWord}`);
      assert.equal(parts.year, '2026');
      checked += 1;
    }
  }
  assert.equal(checked, MARKET_KEYWORDS.length * segments.length);
});

test('a mixed pair is detected and reports BOTH words, not one', () => {
  // The seam word and the market segment need not match — this is the shape the
  // header calls out, and the pair that would vanish if equality were required.
  const parts = D.doubledMarketParts('some-comic-tour-off-broadway-2026');
  assert.equal(parts.doubledWord, 'tour');
  assert.equal(parts.market, 'off-broadway');
});

// ASSERTING "zero flagged" ALONE IS NOT A TEST OF THIS DETECTOR. A detector that
// matches nothing at all also reports zero flagged rows, so a broken regex makes
// this file greener, not redder — MEASURED: reverting the lazy quantifier turns
// 8 of these 17 tests red while the zero-flagged corpus assertion stays GREEN.
// That is why the detected-set assertion sits beside it.
//
// AND A SKIPPED TEST IS NOT A PASSING ONE. These read data/shows.json, which a
// worktree does not have. They used to `return` on a missing file, which node
// reports as a pass — so "13/13 pass" could mean the corpus was never opened.
// They now skip VISIBLY, so the runner prints what did not run.
function loadCorpus() {
  const showsPath = path.join(here, '..', '..', 'data', 'shows.json');
  if (!fs.existsSync(showsPath)) return null;
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
}
const NO_CORPUS = 'data/shows.json absent (worktree without core data) — NOT a pass';

test('the live corpus has zero unallowlisted doubled-market ids', (t) => {
  const shows = loadCorpus();
  if (!shows) return t.skip(NO_CORPUS);
  const { flagged } = D.sweepShows(shows);
  return assert.deepEqual(
    flagged.map((r) => `${r.id} ${JSON.stringify(r.title)}`),
    [],
    'fix the title, or allowlist the id with the source you checked',
  );
});

test('the detector still DETECTS every allowlisted row in the live corpus', (t) => {
  const shows = loadCorpus();
  if (!shows) return t.skip(NO_CORPUS);
  const { allowlisted } = D.sweepShows(shows);
  return assert.deepEqual(
    allowlisted.map((r) => r.id).sort(),
    [...D.ALLOWLIST.keys()].sort(),
    'the detected set no longer matches the allowlist — either detection broke '
      + '(every allowlisted row silently stopped matching) or a row was renamed',
  );
});

// Not just "these three ids were detected" — the PARSE of each is pinned. The
// first review's mutation was to return an arbitrary doubledWord for the rows
// nothing asserted the parts of; only Lauder's were checked.
test('every allowlisted corpus row parses to the expected parts', (t) => {
  const shows = loadCorpus();
  if (!shows) return t.skip(NO_CORPUS);
  const byId = new Map(D.sweepShows(shows).allowlisted.map((r) => [r.id, r]));
  const expected = {
    'lauder-scotlands-kilted-king-of-broadway-off-broadway-2026':
      { prefix: 'lauder-scotlands-kilted-king-of-broadway', market: 'off-broadway', doubledWord: 'broadway', year: '2026' },
    'september-l-davis-the-apology-tour-off-broadway-2026':
      { prefix: 'september-l-davis-the-apology-tour', market: 'off-broadway', doubledWord: 'tour', year: '2026' },
    'paranormal-activity-national-tour-regional-2025':
      { prefix: 'paranormal-activity-national-tour', market: 'regional', doubledWord: 'tour', year: '2025' },
  };
  assert.deepEqual(Object.keys(expected).sort(), [...D.ALLOWLIST.keys()].sort(),
    'this table and ALLOWLIST have drifted apart');
  for (const [id, want] of Object.entries(expected)) {
    const got = byId.get(id);
    assert.ok(got, `${id} was not detected at all`);
    assert.deepEqual(
      { prefix: got.prefix, market: got.market, doubledWord: got.doubledWord, year: got.year },
      want,
      `${id} parsed differently than recorded`,
    );
  }
  return undefined;
});

test('no allowlist key is stale — every one names a show that still exists', (t) => {
  const shows = loadCorpus();
  if (!shows) return t.skip(NO_CORPUS);
  const ids = new Set(shows.map((s) => s.id));
  const missing = [...D.ALLOWLIST.keys()].filter((id) => !ids.has(id));
  return assert.deepEqual(
    missing,
    [],
    'an allowlisted id is not in shows.json. A rename or a year correction '
      + 'leaves the key matching nothing while the renamed row rejoins the '
      + 'flagged set — update the key, do not delete the reason.',
  );
});
