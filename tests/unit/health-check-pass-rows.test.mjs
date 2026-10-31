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

// --- BRO-5164: the remaining zero-row checks ---

test('BRO-5164 rows are core checks (reachable by the --live probe)', () => {
  const core = String(hc.computeCoreHealthResults);
  for (const fn of ['checkFeedbackBacklog', 'checkUncollectedStrands', 'checkCardVerifiabilityBacklog', 'checkCoverageHoles', 'checkStarBandDrift']) {
    assert.match(core, new RegExp(`${fn}\\(\\)`), `${fn} must run inside computeCoreHealthResults`);
  }
});

const FEEDBACK = 'Feedback: needs-manual-review backlog';
test('feedbackBacklogResults: a read that found nothing passes; a skipped or failed read never does', () => {
  assert.equal(probeVerdict(hc.feedbackBacklogResults({ skipped: false, issues: [] }), FEEDBACK), 'absent');
  assert.equal(probeVerdict(hc.feedbackBacklogResults({ skipped: true, issues: [] }), FEEDBACK), 'unknown');
  assert.equal(probeVerdict(hc.feedbackBacklogResults({ skipped: false }), FEEDBACK), 'unknown');
  assert.equal(probeVerdict(hc.feedbackBacklogResults(null), FEEDBACK), 'unknown');
  const open = hc.feedbackBacklogResults({ skipped: false, issues: [{ number: 1, title: 't', createdAt: '2026-10-01T00:00:00Z' }] });
  assert.equal(probeVerdict(open, FEEDBACK), 'present');
});

test('neverRunWorkflowResults: a computed report with no offenders passes; no report passes nothing', () => {
  const name = 'Workflow coverage: never-run';
  assert.equal(probeVerdict(hc.neverRunWorkflowResults({ offenders: [], totalChecked: 9, unknownCount: 0, minAgeDays: 30 }), name), 'absent');
  assert.equal(probeVerdict(hc.neverRunWorkflowResults(null), name), 'unknown');
  assert.equal(probeVerdict(hc.neverRunWorkflowResults({}), name), 'unknown');
  assert.equal(probeVerdict(hc.neverRunWorkflowResults({ offenders: ['a.yml'], minAgeDays: 30 }), name), 'present');
  // Unreadable run counts are dropped from offenders, so they cannot vouch for a clean run.
  assert.equal(probeVerdict(hc.neverRunWorkflowResults({ offenders: [], totalChecked: 9, unknownCount: 2 }), name), 'unknown');
  assert.equal(probeVerdict(hc.neverRunWorkflowResults({ offenders: [], totalChecked: 0, unknownCount: 0 }), name), 'unknown');
  assert.equal(probeVerdict(hc.neverRunWorkflowResults({ offenders: [], totalChecked: 9 }), name), 'unknown', 'older report without unknownCount');
});

const ZERO = 'Data: live show with zero critic reviews on site';
const STRANDS = 'Data: uncollected live review strands';
test('uncollectedStrandResults: fresh clean report passes both names; stale, undated or missing passes none', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const fresh = '2026-10-19T11:00:00Z';
  assertAllAbsent(hc.uncollectedStrandResults({ generatedAt: fresh, findings: [], blackoutShows: [] }, now), [ZERO, STRANDS]);
  assertNoneAbsent(hc.uncollectedStrandResults({ generatedAt: '2026-10-17T00:00:00Z', findings: [], blackoutShows: [] }, now), [ZERO, STRANDS]);
  assertNoneAbsent(hc.uncollectedStrandResults({ findings: [], blackoutShows: [] }, now), [ZERO, STRANDS]);
  assertNoneAbsent(hc.uncollectedStrandResults(null, now), [ZERO, STRANDS]);
  assertNoneAbsent(hc.uncollectedStrandResults({ generatedAt: fresh }, now), [ZERO, STRANDS]);
  // Older report shape with no blackoutShows: the zero-review row was never computed.
  assert.equal(probeVerdict(hc.uncollectedStrandResults({ generatedAt: fresh, findings: [] }, now), ZERO), 'unknown');
});

test('uncollectedStrandResults: strands without a blackout pass the zero-review row only; a blackout keeps it present', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const finding = { showId: 'x', stranded: [{}] };
  const strands = hc.uncollectedStrandResults({ generatedAt: '2026-10-19T11:00:00Z', findings: [finding], strandedFiles: 1, blackoutShows: [] }, now);
  assert.equal(probeVerdict(strands, ZERO), 'absent');
  assert.equal(probeVerdict(strands, STRANDS), 'present');
  const blackout = hc.uncollectedStrandResults({ generatedAt: '2026-10-19T11:00:00Z', findings: [finding], strandedFiles: 1, blackoutShows: ['x'] }, now);
  assert.equal(probeVerdict(blackout, ZERO), 'present');
  assert.notEqual(probeVerdict(blackout, STRANDS), 'absent');
});

test('checkUncollectedStrands: a missing report emits no row (never a pass)', () => {
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (String(p).endsWith('uncollected-live-reviews.json')) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return realRead(p, ...rest);
  };
  try {
    assert.deepEqual(hc.checkUncollectedStrands(), []);
  } finally {
    fs.readFileSync = realRead;
  }
});

const CV_NAMES = ['Data: armed-but-vacuous backlog cards', 'Data: undispatchable Linear backlog cards', 'Data: Linear card-verifiability report stale'];
test('cardVerifiabilityBacklogResults: fresh clean Linear report passes all three; stale or missing passes none', () => {
  const now = Date.parse('2026-10-07T02:15:00Z');
  const clean = { total: 9, refused: [], vacuousChecks: [], generatedAt: '2026-10-06T05:40:00Z' };
  assertAllAbsent(hc.cardVerifiabilityBacklogResults(null, clean, now), CV_NAMES);
  assertNoneAbsent(hc.cardVerifiabilityBacklogResults(null, { ...clean, generatedAt: '2026-09-15T00:00:00Z' }, now), CV_NAMES);
  assertNoneAbsent(hc.cardVerifiabilityBacklogResults(null, { total: 9, refused: [], vacuousChecks: [] }, now), CV_NAMES);
  assertNoneAbsent(hc.cardVerifiabilityBacklogResults({ humanGatedSkips: [] }, null, now), CV_NAMES);
  // A report written before a bucket existed cannot vouch for that bucket.
  const legacy = hc.cardVerifiabilityBacklogResults(null, { total: 9, refused: [], generatedAt: clean.generatedAt }, now);
  assert.equal(probeVerdict(legacy, CV_NAMES[0]), 'unknown');
  assert.equal(probeVerdict(legacy, CV_NAMES[1]), 'absent');
  // An empty or uncounted sweep cannot pass the bucket rows (freshness row may still pass).
  for (const total of [0, undefined, 'x']) {
    const empty = hc.cardVerifiabilityBacklogResults(null, { ...clean, total }, now);
    assertNoneAbsent(empty, CV_NAMES.slice(0, 2));
  }
});

test('coverageHolesResults / starBandDriftResults: fresh clean report passes; stale report does not', () => {
  const now = Date.parse('2026-10-16T05:00:00Z');
  const c = { total: 0, recent: 0, explained: 0 };
  const holes = (generatedAt) => ({ generatedAt, shows: 40, counts: { A: c, B: c, C: c, D: { ...c, published: 0 } } });
  assert.equal(probeVerdict(hc.coverageHolesResults(holes('2026-10-15T20:00:00Z'), now), 'Data: review coverage holes'), 'absent');
  assert.equal(probeVerdict(hc.coverageHolesResults(holes('2026-10-01T00:00:00Z'), now), 'Data: review coverage holes'), 'present');
  // Empty or partial counts are not a clean audit.
  assert.equal(probeVerdict(hc.coverageHolesResults({ generatedAt: '2026-10-15T20:00:00Z', counts: {} }, now), 'Data: review coverage holes'), 'unknown');
  assert.equal(probeVerdict(hc.coverageHolesResults({ generatedAt: '2026-10-15T20:00:00Z', counts: { A: c, B: c, C: c } }, now), 'Data: review coverage holes'), 'unknown');
  // A non-numeric counted field coerces to 0 via ||0; that must not pass.
  for (const D of [{ ...c, published: 'n/a' }, { total: 0, recent: 0, explained: 0 }]) {
    const r = { generatedAt: '2026-10-15T20:00:00Z', counts: { A: c, B: c, C: c, D } };
    assert.equal(probeVerdict(hc.coverageHolesResults(r, now), 'Data: review coverage holes'), 'unknown');
  }
  const badA = { generatedAt: '2026-10-15T20:00:00Z', counts: { A: { total: 0 }, B: c, C: c, D: { ...c, published: 0 } } };
  assert.equal(probeVerdict(hc.coverageHolesResults(badA, now), 'Data: review coverage holes'), 'unknown');
  const SB = "Data: published scores outside the critic's rating";
  const sb = (generatedAt) => ({ generatedAt, publishedJoined: 10, publishedOutOfBand: 0, queuedForRescore: 0 });
  assert.equal(probeVerdict(hc.starBandDriftResults(sb('2026-10-15T20:00:00Z'), now), SB), 'absent');
  assert.equal(probeVerdict(hc.starBandDriftResults(sb('2026-10-01T00:00:00Z'), now), SB), 'present');
  assert.equal(probeVerdict(hc.starBandDriftResults({ generatedAt: '2026-10-15T20:00:00Z' }, now), SB), 'unknown');
  for (const bad of ['n/a', [], {}]) {
    assert.equal(probeVerdict(hc.starBandDriftResults({ ...sb('2026-10-15T20:00:00Z'), publishedOutOfBand: bad }, now), SB), 'unknown', JSON.stringify(bad));
  }
});

// Static guard: every literal row name health-check.js can flag (warn/error,
// not a "Skipped" placeholder) must also be emitted as a pass under the same
// literal name, or be listed here with the reason it cannot or does not.
// A pass twin is `name: '<n>', status: 'pass'|'ok'` or the tour helper `pass('<n>'`.
const NO_LITERAL_PASS_TWIN = {
  'Scoring: batch state': 'pass row built in batchStateResult() from `const name` (health-check-batch-state.test.mjs)',
  'Commercial model drift': 'pass comes from computeCommercialModelDriftStatus() via `status: result.status`',
  'Infra-review: gate telemetry': 'pass returned by computeInfraReviewDigest() in scripts/lib/infra-review-digest.js',
  'Credits: ScrapingDog': 'pass comes from evaluateScrapingdogCredits() via computed `status`',
  'Data: cards the drain cannot finish unattended': 'reads the untracked, Mac-local backlog-drain-metric.json; whether an empty humanGatedSkips means a fresh clean drain or a stale metric is not decidable here',
};

function scanFlaggedWithoutTwin(src) {
  const unq = (s) => s.replace(/\\(.)/g, '$1');
  const flagged = new Set();
  const twins = new Set();
  const obj = /name:\s*'((?:[^'\\]|\\.)*)'\s*,\s*status:\s*'([a-z]+)'\s*,?\s*(message:\s*['`]Skipped)?/g;
  for (const m of src.matchAll(obj)) {
    const n = unq(m[1]);
    if (m[2] === 'warn' || m[2] === 'error') { if (!m[3]) flagged.add(n); } else twins.add(n);
  }
  // Same object written status-first: { status: 'warn', name: '...' }.
  const rev = /status:\s*'([a-z]+)'\s*,\s*name:\s*'((?:[^'\\]|\\.)*)'\s*,?\s*(message:\s*['`]Skipped)?/g;
  for (const m of src.matchAll(rev)) {
    const n = unq(m[2]);
    if (m[1] === 'warn' || m[1] === 'error') { if (!m[3]) flagged.add(n); } else twins.add(n);
  }
  for (const m of src.matchAll(/\bpass\(\s*'((?:[^'\\]|\\.)*)'/g)) twins.add(unq(m[1]));
  return [...flagged].filter((n) => !twins.has(n));
}

test('static guard: every literal flagged row has a pass twin or an allowlist reason', () => {
  const src = fs.readFileSync(new URL('../../scripts/health-check.js', import.meta.url), 'utf8');
  const missing = scanFlaggedWithoutTwin(src);
  const unlisted = missing.filter((n) => !(n in NO_LITERAL_PASS_TWIN));
  assert.deepEqual(unlisted, [], 'emit a same-name pass row when the check ran clean (never on a could-not-run input), or allowlist with a reason');
  const stale = Object.keys(NO_LITERAL_PASS_TWIN).filter((n) => !missing.includes(n));
  assert.deepEqual(stale, [], 'allowlist entry no longer needed (row gained a literal pass twin or was removed)');
});

test('static guard scanner: catches a flagged-only row, accepts pass twins and Skipped placeholders', () => {
  const src = `
    a = { name: 'Only warns', status: 'warn', message: 'x' };
    b = { name: 'Has twin', status: 'error', message: 'x' }; c = { name: 'Has twin', status: 'pass', message: 'y' };
    d = { name: 'Skip only', status: 'warn', message: 'Skipped — no token' };
    e = { name: 'Helper', status: 'warn' }; out.push(pass('Helper', 'ok'));
    f = { status: 'error', name: 'Status first', message: 'x' };`;
  assert.deepEqual(scanFlaggedWithoutTwin(src), ['Only warns', 'Status first']);
});

test('reverseDiscoveryBacklogResults: empty report passes; absent report passes none; core check reaches the --live probe (BRO-4689)', () => {
  const NAME = 'Data: reviewed shows missing from shows.json';
  const now = new Date('2026-10-27T12:00:00Z');
  assertAllAbsent(hc.reverseDiscoveryBacklogResults({ generatedAt: '2026-10-27T10:00:00Z', candidates: [] }, {}, now), [NAME]);
  assertNoneAbsent(hc.reverseDiscoveryBacklogResults(null, {}, now), [NAME]);
  // Stale or undated empty report cannot verify a fix.
  assertNoneAbsent(hc.reverseDiscoveryBacklogResults({ generatedAt: '2026-10-20T10:00:00Z', candidates: [] }, {}, now), [NAME]);
  assertNoneAbsent(hc.reverseDiscoveryBacklogResults({ candidates: [] }, {}, now), [NAME]);
  const flagged = hc.reverseDiscoveryBacklogResults({ candidates: [{ title: 'Zzzz Unlisted Qqq Play', source: 'bww-roundup', market: 'nyc', url: 'u' }] }, {});
  assert.equal(probeVerdict(flagged, NAME), 'present');
  assert.match(String(hc.computeCoreHealthResults), /checkReverseDiscovery\(\)/);
});
