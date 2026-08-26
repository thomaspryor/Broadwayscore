// BRO-89: opening-night dispatch-storm regression tests.
//
// Two failure modes shipped in T1-retrieval Sprint 2 and were caught by a
// later two-model ship-check against live code:
//   1. Dispatch-storm — censusMissing (the hard, roundup-named bucket) counted
//      EVERY tier, so a show with 3+ unscored T3 blogs (no real T1/T2 gap)
//      still went `dispatchable` + `severity:'major'` and re-fired a FULL
//      gather+collect every audit run.
//   2. Phantom census outlets — an outletId that doesn't exist in
//      outlet-registry.json at all (a mis-normalized critic name — see
//      review-census.js's normalizeOutlet) must be excluded from tier
//      counting without throwing, not crash the audit.
//
// scripts/lib/t1-ledger.js's computeDispatchDecision() is the pure function
// audit-opening-night-coverage.js's main() calls for this decision (extracted
// per CLAUDE.md's test-extraction rule — no logic is duplicated here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeDispatchDecision } = require('./lib/t1-ledger.js');
const { computeShowCells } = require('./audit-opening-night-coverage.js');

const OUTLETS = {
  nytimes: { tier: 1, displayName: 'The New York Times' },
  nypost: { tier: 2, displayName: 'New York Post' },
  variety: { tier: 1, displayName: 'Variety' },
  // A T3 blog IS registered (has a tier), just not dispatch-tier.
  'some-blog': { tier: 3, displayName: 'Some Blog' },
};

test('dispatch storm: 3+ T3 census-missing outlets alone must NOT make a show dispatchable or major', () => {
  const censusMissing = ['some-blog', 'another-blog', 'third-blog', 'fourth-blog'];
  const { censusMissingT12, dispatchable, severity } = computeDispatchDecision({ censusMissing, outlets: OUTLETS, isTripped: () => false });
  assert.deepEqual(censusMissingT12, [], 'no T1/T2 outlet is missing — only T3/unregistered noise');
  assert.equal(dispatchable, false, 'a T3-only census gap must never re-fire a gather (the storm)');
  assert.equal(severity, 'minor', 'T3 volume alone must never escalate to major');
});

test('dispatch storm: phantom (completely unregistered) outletIds are excluded from tier counting without throwing', () => {
  const censusMissing = ['phantom-outlet-1', 'phantom-outlet-2', 'phantom-outlet-3', 'variety'];
  assert.doesNotThrow(() => computeDispatchDecision({ censusMissing, outlets: OUTLETS, isTripped: () => false }));
  const { censusMissingT12, censusMissingActionable, dispatchable, severity } =
    computeDispatchDecision({ censusMissing, outlets: OUTLETS, isTripped: () => false });
  assert.deepEqual(censusMissingT12, ['variety'], 'phantom outletIds (undefined tier) must not count as T1/T2');
  assert.deepEqual(censusMissingActionable, ['variety']);
  assert.equal(dispatchable, true, 'the one real T1 gap must still be dispatchable');
  assert.equal(severity, 'minor', 'a single actionable miss stays minor regardless of phantom-outlet count');
});

test('dispatch storm: 3+ real T1/T2 misses correctly escalate to dispatchable + major', () => {
  const censusMissing = ['nytimes', 'nypost', 'variety', 'some-blog'];
  const { censusMissingT12, dispatchable, severity } = computeDispatchDecision({ censusMissing, outlets: OUTLETS, isTripped: () => false });
  assert.deepEqual(censusMissingT12.sort(), ['nypost', 'nytimes', 'variety']);
  assert.equal(dispatchable, true);
  assert.equal(severity, 'major', '3 actionable T1/T2 misses must still escalate');
});

test('dispatch storm: a circuit-open T1/T2 outlet is visible in censusMissingT12 but excluded from dispatchable/severity', () => {
  const censusMissing = ['nytimes', 'nypost', 'variety'];
  const { censusMissingT12, circuitOpenIds, censusMissingActionable, dispatchable, severity } = computeDispatchDecision({
    censusMissing, outlets: OUTLETS, isTripped: (id) => id === 'nytimes',
  });
  assert.deepEqual(censusMissingT12.sort(), ['nypost', 'nytimes', 'variety'], 'tripped outlet stays visible');
  assert.deepEqual(circuitOpenIds, ['nytimes']);
  assert.deepEqual(censusMissingActionable.sort(), ['nypost', 'variety']);
  assert.equal(dispatchable, true, 'the other two non-tripped T1/T2 misses still make it dispatchable');
  assert.equal(severity, 'minor', 'only 2 actionable misses — below the major threshold once the tripped outlet is excluded');
});

test('dispatch storm: a broken census extractor escalates to major even with zero actionable misses', () => {
  const { dispatchable, severity } = computeDispatchDecision({
    censusMissing: [], outlets: OUTLETS, censusExtractorBroken: true, isTripped: () => false,
  });
  assert.equal(dispatchable, false, 'no actionable outlet to fetch — extractor breakage alone must not storm-dispatch');
  assert.equal(severity, 'major', 'a broken extractor is still alert-worthy at major severity');
});

// --- Ledger path (computeShowCells): a phantom census entry must not crash
// the T1 coverage ledger and must not mint a phantom SLA cell. ---

const NOW_MS = Date.parse('2026-07-30T12:00:00.000Z');
const SHOW_ID = 'test-show-2026';

function show(overrides = {}) {
  return {
    id: SHOW_ID, slug: SHOW_ID, title: 'Test Show',
    category: 'broadway', status: 'open', openingDate: '2026-07-20',
    ...overrides,
  };
}

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

test('ledger path: a phantom (unregistered) census outletId does not crash computeShowCells and is excluded from cells/coverage', () => {
  const fixture = makeArchiveFixture();
  const s = show();
  const censusOpts = {
    archiveDir: fixture.archiveDir,
    sources: [fixture.realSource('bww-roundup', [
      { outlet: 'The New York Times', outletId: 'nytimes', critic: 'Unknown', stars: null, url: '' },
      // A completely unregistered outletId — the phantom-census-outlet case.
      { outlet: 'Some Nobody Blog', outletId: 'phantom-outlet-xyz', critic: 'Unknown', stars: null, url: '' },
    ])],
  };
  assert.doesNotThrow(() => computeShowCells(s, [], OUTLETS, NOW_MS, null, censusOpts));
  const { cells, coverage } = computeShowCells(s, [], OUTLETS, NOW_MS, null, censusOpts);
  assert.deepEqual(cells.map((c) => c.outletId).sort(), ['nytimes'], 'phantom outletId must never mint a ledger cell');
  assert.equal(coverage.totalTier, 1, 'phantom outletId must not inflate the T1/T2 denominator');
});
