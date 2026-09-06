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
// and that prefix ends in "off", which is not a market word. Revert the `?` in
// TRAILING_MARKET_RE and this test — and only this one plus the two below it —
// goes red.
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

test('the live corpus has zero unallowlisted doubled-market ids', () => {
  const showsPath = path.join(here, '..', '..', 'data', 'shows.json');
  if (!fs.existsSync(showsPath)) return; // a worktree without core data symlinked
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const { flagged } = D.sweepShows(shows);
  assert.deepEqual(
    flagged.map((r) => `${r.id} ${JSON.stringify(r.title)}`),
    [],
    'fix the title, or allowlist the id with the source you checked',
  );
});
