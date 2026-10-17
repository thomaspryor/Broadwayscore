// BRO-3833 / BRO-3697 prevention: scripts/lib/health-row-probe.js calls a
// health row fixed ('absent') ONLY when the row is present with a non-skip,
// non-warn/error status. A core check that returns [] when healthy can
// therefore never verify a fix — every card targeting it reads 'unknown'
// forever. These tests require() the real functions (CLAUDE.md §15) and pin
// both halves of the contract for every converted check:
//   1. read-and-found-nothing  -> a pass row under EVERY name it can flag;
//   2. could-not-run (missing input) -> no pass row (or a "Skipped" row),
//      because a pass there would be a false 'absent'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const hc = require('../../scripts/health-check.js');
const { isSkipPlaceholder } = require('../../scripts/lib/health-row-probe.js');

// What health-row-probe.js would conclude for `name` given these rows.
function probeVerdict(rows, name) {
  const m = rows.find((r) => r.name === name);
  if (!m || isSkipPlaceholder(m)) return 'unknown';
  return m.status === 'error' || m.status === 'warn' ? 'present' : 'absent';
}

function assertAllAbsent(rows, names) {
  for (const n of names) assert.equal(probeVerdict(rows, n), 'absent', `${n} should verify absent`);
}
function assertNoneAbsent(rows, names) {
  for (const n of names) assert.notEqual(probeVerdict(rows, n), 'absent', `${n} must not read absent when the input is missing`);
}

const OB_NAMES = ['Data: OB shows no closing signal can detect', 'Data: OB closing candidates awaiting review'];

test('obClosingBacklogResults: empty valid report passes both names; absent report passes none', () => {
  const empty = { reviewTextSweep: { candidates: [] }, todaytixStaleness: { candidates: [] }, unmonitoredOpenShows: [] };
  assertAllAbsent(hc.obClosingBacklogResults(empty), OB_NAMES);
  assertNoneAbsent(hc.obClosingBacklogResults(null), OB_NAMES);
  assertNoneAbsent(hc.obClosingBacklogResults({}), OB_NAMES);
  // Report from before unmonitoredOpenShows existed: that row was never computed.
  const legacy = hc.obClosingBacklogResults({ reviewTextSweep: { candidates: [] } });
  assert.equal(probeVerdict(legacy, OB_NAMES[0]), 'unknown');
  assert.equal(probeVerdict(legacy, OB_NAMES[1]), 'absent');
});

test('obClosingBacklogResults: a flagged row stays present while the other passes', () => {
  const rows = hc.obClosingBacklogResults({
    reviewTextSweep: { candidates: [{ showId: 'x', proposedClosingDate: '2026-05-10', confidence: 'medium' }] },
    unmonitoredOpenShows: [],
  });
  assert.equal(probeVerdict(rows, OB_NAMES[0]), 'absent');
  assert.equal(probeVerdict(rows, OB_NAMES[1]), 'present');
});

test('tourAutomationResults: healthy reports pass every flaggable name; missing reports pass none', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const at = new Date(now.getTime() - 3600000).toISOString();
  const rows = hc.tourAutomationResults({
    sweep: { generatedAt: at, held: [] },
    dates: { generatedAt: at, tours: [] },
    autocreate: { generatedAt: at, created: [], reopened: [], lifecycle: { undecided: [] },
      discovery: { error: null, coverage: { a: { seenAt: at, checkedAt: at } } } },
  }, now);
  const names = [
    'Data: tour automation stopped reporting',
    'Data: tour review sweep held',
    'Data: tour dates need a look',
    'Data: running-tour discovery failed',
    'Data: Tours To You pages not checked',
    'Data: national tours added automatically',
    'Data: closed national tours reopened automatically',
    'Data: closed national tour lists new dates',
  ];
  assertAllAbsent(rows, names);
  // Before the jobs are expected, missing reports are not flagged — and not passed either.
  assertNoneAbsent(hc.tourAutomationResults({}, new Date('2026-10-01T12:00:00Z')), names);
});

const MEM_NAMES = ['Memory: cloud mirror reconcile failing', 'Memory: cloud notes not reaching the Mac'];

test('cloudMemoryDriftResults: clean report passes both; absent report passes none; failed reconcile cannot pass the notes row', () => {
  assertAllAbsent(hc.cloudMemoryDriftResults({ waitingForMac: [] }), MEM_NAMES);
  assertNoneAbsent(hc.cloudMemoryDriftResults(null), MEM_NAMES);
  const failed = hc.cloudMemoryDriftResults({ error: 'could not clone', waitingForMac: [] });
  assert.equal(probeVerdict(failed, MEM_NAMES[0]), 'present');
  assert.equal(probeVerdict(failed, MEM_NAMES[1]), 'unknown');
});

// --- Data freshness gaps (BRO-3697) ---

function withFreshnessReport(report, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3697-'));
  try {
    if (report !== undefined) fs.writeFileSync(path.join(dir, 'freshness-report.json'), JSON.stringify(report));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('checkDataFreshnessGaps: is a core check (row reachable by the --live probe)', () => {
  assert.match(String(hc.computeCoreHealthResults), /checkDataFreshnessGaps\(\)/);
});

test('checkDataFreshnessGaps: clean fresh report passes; gaps warn with the digest message shape', () => {
  const name = hc.DATA_FRESHNESS_GAPS_CHECK;
  const now = Date.parse('2026-10-12T12:00:00Z');
  const generatedAt = '2026-10-12T06:00:00Z';
  withFreshnessReport({ generatedAt, dataQuality: { hasIssues: [] } }, (dataDir) => {
    assert.equal(probeVerdict(hc.checkDataFreshnessGaps({ dataDir, now }), name), 'absent');
  });
  // Low-severity issues only: the digest's summarizer ignores them, so does the row.
  withFreshnessReport({ generatedAt, dataQuality: { hasIssues: [{ id: 'a', title: 'A', issues: [{ type: 'missing_cast', severity: 'low' }] }] } }, (dataDir) => {
    assert.equal(probeVerdict(hc.checkDataFreshnessGaps({ dataDir, now }), name), 'absent');
  });
  withFreshnessReport({ generatedAt, dataQuality: { hasIssues: [
    { id: 'a', title: 'A', issues: [{ type: 'missing_poster', severity: 'high' }] },
    { id: 'b', title: 'B', issues: [{ type: 'missing_tickets', severity: 'high' }] },
  ] } }, (dataDir) => {
    const [row] = hc.checkDataFreshnessGaps({ dataDir, now });
    assert.equal(row.name, name);
    assert.equal(row.status, 'warn');
    assert.match(row.message, /^2 open show\(s\) missing critical data/);
  });
});

test('checkDataFreshnessGaps: missing, stale or malformed report is a Skipped row, never a pass', () => {
  const name = hc.DATA_FRESHNESS_GAPS_CHECK;
  const now = Date.parse('2026-10-12T12:00:00Z');
  withFreshnessReport(undefined, (dataDir) => {
    assert.equal(probeVerdict(hc.checkDataFreshnessGaps({ dataDir, now }), name), 'unknown');
  });
  withFreshnessReport({ generatedAt: '2026-10-10T00:00:00Z', dataQuality: { hasIssues: [] } }, (dataDir) => {
    assert.equal(probeVerdict(hc.checkDataFreshnessGaps({ dataDir, now }), name), 'unknown', 'stale (>36h, the digest bar) must not verify');
  });
  withFreshnessReport({ generatedAt: '2026-10-12T06:00:00Z', dataQuality: {} }, (dataDir) => {
    assert.equal(probeVerdict(hc.checkDataFreshnessGaps({ dataDir, now }), name), 'unknown');
  });
});

// BRO-3697 digest side: the local rollups fold in only when the snapshot lacks
// the same-name core row, so a card is never filed twice and its name always
// matches what check-health-row-absent.js --live probes.
test('localRollupIssues: no duplicate when the snapshot already carries the row', () => {
  const { localRollupIssues, ROLLUP_ROW_NAMES } = require('../../scripts/lib/digest-autofix.js');
  const health = { errors: [], warns: [{ name: ROLLUP_ROW_NAMES.stuck }, ROLLUP_ROW_NAMES.freshness] };
  assert.deepEqual(localRollupIssues({ health, freshnessCount: 4, stuckCount: 2 }), []);
});

test('localRollupIssues: adds same-name rows when the snapshot lacks them', () => {
  const { localRollupIssues, ROLLUP_ROW_NAMES } = require('../../scripts/lib/digest-autofix.js');
  const out = localRollupIssues({ health: { errors: [], warns: [] }, freshnessCount: 4, stuckCount: 2 });
  assert.deepEqual(out.map((r) => r.name), [ROLLUP_ROW_NAMES.freshness, ROLLUP_ROW_NAMES.stuck]);
  assert.match(out[0].message, /^4 open show/);
  assert.match(out[1].message, /^2 pipeline signal/);
  // Names must equal the core rows so a filed card is verifiable.
  assert.equal(ROLLUP_ROW_NAMES.freshness, hc.DATA_FRESHNESS_GAPS_CHECK);
  assert.equal(ROLLUP_ROW_NAMES.stuck, 'Stuck pipeline items');
  assert.match(require('fs').readFileSync(new URL('../../scripts/health-check.js', import.meta.url), 'utf8'),
    /name: 'Stuck pipeline items', status: 'pass'/);
});

test('localRollupIssues: nothing when both counts are zero or health is missing', () => {
  const { localRollupIssues } = require('../../scripts/lib/digest-autofix.js');
  assert.deepEqual(localRollupIssues({ health: null, freshnessCount: 0, stuckCount: 0 }), []);
  assert.deepEqual(localRollupIssues(), []);
  assert.equal(localRollupIssues({ health: undefined, stuckCount: 1 }).length, 1);
});
