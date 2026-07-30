import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeShowCells } = require('./audit-opening-night-coverage.js');

// Minimal outlet registry mirroring data/outlet-registry.json's shape.
const OUTLETS = {
  nytimes: { tier: 1, displayName: 'The New York Times', standingCoverage: true, standingMarkets: ['broadway'] },
  nypost: { tier: 2, displayName: 'New York Post', standingCoverage: true, standingMarkets: ['broadway'] },
  variety: { tier: 1, displayName: 'Variety' },
  // CI-unfetchable (review-census.js's CI_UNFETCHABLE_OUTLETS) AND registry
  // says it doesn't apply here — exercises the suppressedMissing/NO_REVIEW_EXPECTED
  // interaction (adversarial review finding).
  wsj: { tier: 1, displayName: 'The Wall Street Journal', coverageExpectation: 'none', coverageExpectationDecidedAt: '2026-07-25T00:00:00.000Z' },
  // A London-alias pair (censusVerdict's variants() treats these as the same
  // outlet for covered/missing purposes) used to exercise totalTier's dedup.
  timeout: { tier: 1, displayName: 'Time Out' },
  'timeout-london': { tier: 1, displayName: 'Time Out (London)' },
};

const NOW_MS = Date.parse('2026-07-30T12:00:00.000Z');
const SHOW_ID = 'test-show-2026';

function show(overrides = {}) {
  return {
    id: SHOW_ID, slug: SHOW_ID, title: 'Test Show',
    category: 'broadway', status: 'open', openingDate: '2026-07-20',
    ...overrides,
  };
}

// buildCensusFromArchives checks fs.existsSync for every non-pseudo source
// (dir/ext are required — path.join throws on undefined), so a "real archive
// source" fixture needs an actual file on disk even though its content is
// ignored (fn(html, showId) below returns a fixed entries array regardless).
function makeArchiveFixture() {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-test-'));
  return {
    archiveDir,
    realSource(name, entries) {
      fs.mkdirSync(path.join(archiveDir, name), { recursive: true });
      fs.writeFileSync(path.join(archiveDir, name, `${SHOW_ID}.html`), '<html></html>');
      return { name, dir: name, fn: () => entries };
    },
  };
}

test('coverage math: a supplementary-only-sourced entry is dropped from `cells` but still counts as missing in `coverage`', () => {
  // variety is named ONLY by a supplementary source (playbill-verdict) — the
  // ledger soft-skips it (not a real retrieval SLA cell), but it must still
  // count against coverage.covered, or the % silently inflates.
  const fixture = makeArchiveFixture();
  const s = show();
  const censusOpts = {
    archiveDir: fixture.archiveDir,
    sources: [fixture.realSource('playbill-verdict', [
      { outlet: 'Variety', outletId: 'variety', critic: 'Unknown', stars: null, url: '' },
    ])],
  };
  const { cells, coverage } = computeShowCells(s, [], OUTLETS, NOW_MS, null, censusOpts);
  assert.equal(cells.length, 0, 'supplementary-only entry is soft-skipped from ledger cells');
  assert.ok(coverage, 'coverage must still be computed');
  assert.equal(coverage.totalTier, 1);
  assert.equal(coverage.denominator, 1);
  assert.equal(coverage.covered, 0, 'supplementary-only-missing entry must NOT be counted as covered');
});

test('coverage math: a REAL-archive-sourced missing entry counts as missing in both `cells` and `coverage`', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const censusOpts = {
    archiveDir: fixture.archiveDir,
    sources: [fixture.realSource('bww-roundup', [
      { outlet: 'Variety', outletId: 'variety', critic: 'Unknown', stars: null, url: '' },
    ])],
  };
  const { cells, coverage } = computeShowCells(s, [], OUTLETS, NOW_MS, null, censusOpts);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].outletId, 'variety');
  assert.equal(coverage.covered, 0);
  assert.equal(coverage.denominator, 1);
});

test('coverage math: a scored real-archive entry counts as covered', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const censusOpts = {
    archiveDir: fixture.archiveDir,
    sources: [fixture.realSource('bww-roundup', [
      { outlet: 'Variety', outletId: 'variety', critic: 'Unknown', stars: null, url: '' },
    ])],
  };
  const reviews = [{ showId: SHOW_ID, outletId: 'variety', assignedScore: 80 }];
  const { cells, coverage } = computeShowCells(s, reviews, OUTLETS, NOW_MS, null, censusOpts);
  assert.equal(cells.length, 0);
  assert.equal(coverage.covered, 1);
  assert.equal(coverage.denominator, 1);
});

test('fan-out cap: a cell confirmed by BOTH a real source and standing-outlets is never capped, even at cap=0', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const counter = { used: 0, cap: 0 };
  const standingCtx = { existingCellKeys: new Set(), counter };
  const censusOpts = {
    archiveDir: fixture.archiveDir,
    sources: [fixture.realSource('bww-roundup', [
      { outlet: 'The New York Times', outletId: 'nytimes', critic: 'Unknown', stars: null, url: '' },
    ])],
  };
  const { cells } = computeShowCells(s, [], OUTLETS, NOW_MS, standingCtx, censusOpts);
  const nyt = cells.find((c) => c.outletId === 'nytimes');
  assert.ok(nyt, 'a real-archive-confirmed cell must show even when the standing-outlets cap is exhausted');
  assert.equal(counter.used, 0, 'a cell also named by a real source must not consume the fan-out cap budget');
});

test('fan-out cap: a standing-outlets-ONLY cell IS capped when the budget is exhausted, but STILL counts as missing in coverage', () => {
  // Regression guard (adversarial review 2026-07-30): a capped-out cell is
  // excluded from `cells` (ledger display) but must never be silently counted
  // as covered — a bug that moved coverageMissing++ to after the cap check
  // would pass every other fan-out test while inflating coverage.covered.
  const fixture = makeArchiveFixture();
  const s = show();
  const counter = { used: 0, cap: 0 };
  const standingCtx = { existingCellKeys: new Set(), counter };
  const censusOpts = { archiveDir: fixture.archiveDir, sources: [] }; // no real archive names nytimes/nypost
  const { cells, coverage } = computeShowCells(s, [], OUTLETS, NOW_MS, standingCtx, censusOpts);
  assert.equal(cells.find((c) => c.outletId === 'nytimes'), undefined);
  assert.equal(cells.find((c) => c.outletId === 'nypost'), undefined);
  assert.equal(coverage.totalTier, 2);
  assert.equal(coverage.denominator, 2);
  assert.equal(coverage.covered, 0, 'both capped-out cells must still count as missing, not covered');
});

test('fan-out cap: a standing-outlets-ONLY cell is allowed through when budget remains, and consumes it', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const counter = { used: 0, cap: 1 };
  const standingCtx = { existingCellKeys: new Set(), counter };
  const censusOpts = { archiveDir: fixture.archiveDir, sources: [] };
  const { cells } = computeShowCells(s, [], OUTLETS, NOW_MS, standingCtx, censusOpts);
  // nytimes and nypost both apply (standingMarkets includes broadway); with cap=1
  // only one of the two standing-only discoveries fits this run.
  const standingCellIds = cells.filter((c) => ['nytimes', 'nypost'].includes(c.outletId)).map((c) => c.outletId);
  assert.equal(standingCellIds.length, 1);
  assert.equal(counter.used, 1);
});

test('fan-out cap: an already-tracked cell key is never re-throttled, even at cap=0', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const counter = { used: 0, cap: 0 };
  const standingCtx = { existingCellKeys: new Set([`${SHOW_ID}::nytimes`]), counter };
  const censusOpts = { archiveDir: fixture.archiveDir, sources: [] };
  const { cells } = computeShowCells(s, [], OUTLETS, NOW_MS, standingCtx, censusOpts);
  assert.ok(cells.find((c) => c.outletId === 'nytimes'), 'previously-tracked cell must survive a zero-budget run');
  assert.equal(cells.find((c) => c.outletId === 'nypost'), undefined, 'a genuinely new discovery still gets capped');
});

test('regional category never gets standingOutlets applied, even when standingCtx is provided', () => {
  const fixture = makeArchiveFixture();
  const s = show({ category: 'regional', id: 'regional-tryout-2026' });
  const standingCtx = { existingCellKeys: new Set(), counter: { used: 0, cap: 100 } };
  const censusOpts = { archiveDir: fixture.archiveDir, sources: [] };
  const { cells, coverage } = computeShowCells(s, [], OUTLETS, NOW_MS, standingCtx, censusOpts);
  assert.deepEqual(cells, []);
  assert.equal(coverage, null);
});

test('broadway category with no real source still gets standingOutlets applied (the B1 pseudo-source)', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const standingCtx = { existingCellKeys: new Set(), counter: { used: 0, cap: 100 } };
  const censusOpts = { archiveDir: fixture.archiveDir, sources: [] };
  const { cells, coverage } = computeShowCells(s, [], OUTLETS, NOW_MS, standingCtx, censusOpts);
  const ids = cells.map((c) => c.outletId).sort();
  assert.deepEqual(ids, ['nypost', 'nytimes']);
  assert.equal(coverage.totalTier, 2);
});

test('censusOpts is allowlisted to sources/archiveDir only — an accidental extra key cannot clobber computed show/market/outlets', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const standingCtx = { existingCellKeys: new Set(), counter: { used: 0, cap: 100 } };
  // A hypothetical future caller accidentally passes `outlets: undefined` (or
  // any other computed key) through censusOpts — this must be silently
  // ignored, not allowed to disable standing-coverage insertion (adversarial
  // review finding: censusOpts was previously blind-spread AFTER the computed
  // opts, so this would have suppressed the pseudo-source entirely).
  const censusOpts = { archiveDir: fixture.archiveDir, sources: [], outlets: undefined, market: 'bogus' };
  const { cells, coverage } = computeShowCells(s, [], OUTLETS, NOW_MS, standingCtx, censusOpts);
  const ids = cells.map((c) => c.outletId).sort();
  assert.deepEqual(ids, ['nypost', 'nytimes'], 'standing coverage must still apply despite the extraneous censusOpts keys');
  assert.equal(coverage.totalTier, 2);
});

test('coverage math: suppressedMissing (CI-unfetchable) entries respect NO_REVIEW_EXPECTED just like ordinary missing entries', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const censusOpts = {
    archiveDir: fixture.archiveDir,
    sources: [fixture.realSource('bww-roundup', [
      { outlet: 'The Wall Street Journal', outletId: 'wsj', critic: 'Unknown', stars: null, url: '' },
    ])],
  };
  const { cells, coverage } = computeShowCells(s, [], OUTLETS, NOW_MS, null, censusOpts);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].outletId, 'wsj');
  assert.equal(cells[0].state, 'SUPPRESSED', 'ledger display state is unaffected — CI-unfetchable still shows as SUPPRESSED');
  assert.equal(coverage.totalTier, 1);
  // wsj is BOTH CI-unfetchable (suppressedMissing) AND NO_REVIEW_EXPECTED here —
  // it must be excluded from the denominator entirely, not counted as a missing
  // (uncovered) cell the way plain CI-unfetchable-but-still-expected outlets are.
  assert.equal(coverage.denominator, 0, 'a NO_REVIEW_EXPECTED suppressed outlet must be excluded from the denominator');
  assert.equal(coverage.covered, 0);
});

test('coverage math: totalTier dedupes London-alias pairs (timeout/timeout-london) so one logical outlet is not double-counted', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const censusOpts = {
    archiveDir: fixture.archiveDir,
    sources: [fixture.realSource('bww-roundup', [
      { outlet: 'Time Out', outletId: 'timeout', critic: 'Unknown', stars: null, url: '' },
    ])].concat([{
      name: 'dtli', dir: null,
      fn: () => [{ outlet: 'Time Out (London)', outletId: 'timeout-london', critic: 'Unknown', stars: null, url: '' }],
    }]),
  };
  // Give the second synthetic source its own real archive file too.
  fs.mkdirSync(path.join(fixture.archiveDir, 'dtli'), { recursive: true });
  fs.writeFileSync(path.join(fixture.archiveDir, 'dtli', `${SHOW_ID}.html`), '<html></html>');
  censusOpts.sources[1].dir = 'dtli';
  const { coverage } = computeShowCells(s, [], OUTLETS, NOW_MS, null, censusOpts);
  assert.equal(coverage.totalTier, 1, 'timeout + timeout-london are the same logical outlet — must count once');
});
