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

test('shouldRetryTombstone: open show with day-old empty tombstone is retried (BRO-7479)', () => {
  const { shouldRetryTombstone } = require('./lib/cast-tombstone.js');
  const now = Date.parse('2026-11-14T12:00:00Z');
  const open = { status: 'open', openingDate: '2026-11-08' };
  const old = { openingNightCast: [], scrapedAt: '2026-11-11T13:43:34Z' };
  assert.strictEqual(shouldRetryTombstone(old, open, now), true);
  assert.strictEqual(shouldRetryTombstone({ ...old, scrapedAt: '2026-11-14T08:00:00Z' }, open, now), false);
  assert.strictEqual(shouldRetryTombstone({ ...old, openingNightCast: [{ name: 'x' }] }, open, now), false);
  assert.strictEqual(shouldRetryTombstone(old, { status: 'previews', openingDate: '2026-12-01' }, now), false);
  assert.strictEqual(shouldRetryTombstone(old, { status: 'closed' }, now), false);
});

test('backfill-cast.js default pass is wired to shouldRetryTombstone (BRO-7479 guard)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./backfill-cast.js', import.meta.url), 'utf8');
  assert.match(src, /shouldRetryTombstone\(JSON\.parse/);
});

test('shouldRetryTombstone: bounded window, and no openingDate means no daily retry (BRO-7479 review)', () => {
  const { shouldRetryTombstone } = require('./lib/cast-tombstone.js');
  const old = { openingNightCast: [], scrapedAt: '2026-01-01T00:00:00Z' };
  const now = Date.parse('2026-11-14T12:00:00Z');
  assert.strictEqual(shouldRetryTombstone(old, { status: 'open', openingDate: '2026-11-10' }, now), true);
  assert.strictEqual(shouldRetryTombstone(old, { status: 'open', openingDate: '2026-10-01' }, now), false);
  assert.strictEqual(shouldRetryTombstone(old, { status: 'previews' }, now), false);
  assert.strictEqual(shouldRetryTombstone(old, { status: 'open' }, now), false);
});

// BRO-7504 class guard: the health row ("Sync: cast coverage") and the backfill's default pass
// must agree. Any state the classifier calls a gap-in-flight must be selected by the backfill,
// and the health check must use the shared classifier (not its own copy of the rules).
test('classifyCastCoverage agrees with backfill default-pass selection (BRO-7504)', async () => {
  const { classifyCastCoverage, shouldRetryTombstone } = await import('./lib/cast-tombstone.js').then(m => m.default || m);
  const now = Date.parse('2026-11-14T12:00:00Z');
  const empty = (at) => ({ openingNightCast: [], scrapedAt: at });
  const shows = [
    { status: 'open', openingDate: '2026-11-08' },
    { status: 'open', openingDate: '2026-09-01' },
    { status: 'open' },
    { status: 'previews', openingDate: '2026-12-01' },
    { status: 'previews', openingDate: '2026-11-10' },
  ];
  for (const show of shows) {
    const file = empty('2026-11-13T00:00:00Z'); // >20h old so the backfill 20h gate is open
    const state = classifyCastCoverage(show, file, now);
    // retrying <=> backfill will pick it up; exhausted <=> it will not (and the row must fire)
    assert.strictEqual(state === 'retrying', shouldRetryTombstone(file, show, now), JSON.stringify(show));
    if (state === 'pre-opening') continue;
    assert.ok(['retrying', 'exhausted'].includes(state));
  }
  // Fresh tombstone: in flight. 48h+ stale tombstone inside the window: the daily job is not fixing it, report.
  assert.strictEqual(classifyCastCoverage(shows[0], empty('2026-11-14T08:00:00Z'), now), 'retrying');
  assert.strictEqual(classifyCastCoverage(shows[0], empty('2026-11-11T13:43:34Z'), now), 'exhausted');
  assert.strictEqual(classifyCastCoverage(shows[0], null, now), 'missing');
  assert.strictEqual(classifyCastCoverage(shows[0], { openingNightCast: [{ name: 'x' }] }, now), 'ok');
  assert.strictEqual(classifyCastCoverage(shows[3], null, now), 'pre-opening');
});

// BRO-7665 shape (without the not-applicable allowlist): an empty tombstone written during
// previews is weeks old on opening day. The daily retry has not run yet, so the row must not fire
// until 48h after opening; if it is still empty after that, it must.
test('classifyCastCoverage: previews-era tombstone gets 48h grace from opening, not from scrape (BRO-7504)', async () => {
  const { classifyCastCoverage, shouldRetryTombstone } = await import('./lib/cast-tombstone.js').then(m => m.default || m);
  const show = { id: 'some-new-show-2026', status: 'open', openingDate: '2026-11-17' };
  const file = { openingNightCast: [], scrapedAt: '2026-09-24T13:56:13Z' };
  const openingDayMorning = Date.parse('2026-11-17T12:34:00Z');
  assert.strictEqual(classifyCastCoverage(show, file, openingDayMorning), 'retrying');
  assert.ok(shouldRetryTombstone(file, show, openingDayMorning), 'the daily pass must pick it up');
  assert.strictEqual(classifyCastCoverage(show, file, Date.parse('2026-11-18T23:00:00Z')), 'retrying');
  assert.strictEqual(classifyCastCoverage(show, file, Date.parse('2026-11-19T01:00:00Z')), 'exhausted');
  // A retry on opening day that came back empty restarts the clock from that scrape.
  const rescraped = { openingNightCast: [], scrapedAt: '2026-11-18T14:20:00Z' };
  assert.strictEqual(classifyCastCoverage(show, rescraped, Date.parse('2026-11-19T06:45:00Z')), 'retrying');
  assert.strictEqual(classifyCastCoverage(show, rescraped, Date.parse('2026-11-20T15:00:00Z')), 'exhausted');
});

test('health-check cast coverage uses the shared classifier (BRO-7504 guard)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./health-check.js', import.meta.url), 'utf8');
  assert.match(src, /classifyCastCoverage\(show, cast\)/);
});
