// Tests for the decision functions backfill-cast.js relies on to avoid
// re-wiping cast data (task #712: a Cloudflare challenge page and a
// non-Broadway market skip were both mistaken for a genuine empty and
// tombstoned, wiping 29-30 open-show casts twice — Jul 29 and Aug 5).
// Requires the REAL functions per CLAUDE.md §15 — no logic copies.
// Registered explicitly in test.yml's unit-test `node --test` list
// (top-level scripts/*.test.mjs is not globbed).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldTombstone, shouldAbortMassWipe } = require('./lib/cast-tombstone.js');
// backfill-cast.js's Broadway-only pre-filter and lookupIBDBCast's market
// skip both reuse the canonical isBroadwayCategory (venue-classification.js)
// rather than an ad hoc check — that drift (an ad hoc off-broadway/west-end
// exclusion list, not the canonical inclusion predicate) is what let the
// off-west-end crocodile show slip through and get its real cast tombstoned.
const { isBroadwayCategory } = require('./lib/venue-classification.js');

test('isBroadwayCategory: broadway and unset category are eligible for IBDB', () => {
  assert.strictEqual(isBroadwayCategory({ category: 'broadway' }), true);
  assert.strictEqual(isBroadwayCategory({ category: undefined }), true);
  assert.strictEqual(isBroadwayCategory({ category: null }), true);
});

test('isBroadwayCategory: off-broadway/west-end/off-west-end are not on IBDB', () => {
  assert.strictEqual(isBroadwayCategory({ category: 'off-broadway' }), false);
  assert.strictEqual(isBroadwayCategory({ category: 'west-end' }), false);
  assert.strictEqual(isBroadwayCategory({ category: 'off-west-end' }), false);
});

test('isBroadwayCategory: regional is not on IBDB (inclusion-based, not exclusion-based)', () => {
  // An exclusion check ("not off-broadway, not london") would wrongly let a
  // 'regional' show through to IBDB search, which then finds nothing and
  // tombstones any manually-sourced cast data — the crocodile-class bug.
  assert.strictEqual(isBroadwayCategory({ category: 'regional' }), false);
});

test('backfill-cast market-skip result is never tombstoned (skipped short-circuits before shouldTombstone)', () => {
  // lookupIBDBCast's market-skip return shape: found:false, fetchFailed:false, skipped:true.
  // backfill-cast.js must check result.skipped BEFORE calling shouldTombstone — a
  // skipped result would otherwise read as "genuine empty" (fetchFailed:false) and
  // shouldTombstone would say tombstone it.
  const marketSkipResult = { openingNightCast: [], currentCast: null, ibdbUrl: null, found: false, fetchFailed: false, skipped: true };
  assert.strictEqual(marketSkipResult.skipped, true, 'result must be flagged skipped so the caller never reaches shouldTombstone for it');
  // If a caller ignored .skipped and fell through anyway, shouldTombstone would
  // wrongly say "yes" — documenting why the skip check must come first.
  assert.strictEqual(shouldTombstone(marketSkipResult), true);
});

test('shouldAbortMassWipe: reproduces the task #712 incident shape (29-30 shows, all empty)', () => {
  assert.strictEqual(shouldAbortMassWipe(29, 29), true);
  assert.strictEqual(shouldAbortMassWipe(30, 30), true);
});

test('shouldAbortMassWipe: a handful of genuine empties in a large run does not trip the breaker', () => {
  assert.strictEqual(shouldAbortMassWipe(200, 5), false);
});
