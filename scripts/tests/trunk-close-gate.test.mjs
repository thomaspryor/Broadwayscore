/**
 * trunk-close-gate.test.mjs — task #1003.
 *
 * Every case runs against the REAL 2026-08-04 trunk failure:
 * tests/fixtures/trunk-failed-log-2026-08-04.txt is a verbatim excerpt of
 * `gh run view 30875902502 --log-failed` (main, test.yml), carrying all three
 * independent failures that were live that day — the tm-gap-links assertion
 * (#956), the duplicateOf gate (Data Validation), and the orphan-test audit
 * (#990/#993).
 *
 * CLAUDE.md §15: this require()s the real functions. No logic is re-stated here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  summarizeTrunkRuns, extractFailingPaths, collectOwnedPaths,
  evaluateCloseGate, renderTrunkDigestLine, GATE_REASONS,
} = require(path.join(REPO, 'scripts/lib/trunk-close-gate.js'));

const REAL_LOG = fs.readFileSync(
  path.join(REPO, 'tests/fixtures/trunk-failed-log-2026-08-04.txt'), 'utf8'
);

const NOW = Date.parse('2026-08-04T04:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();

// The real run list shape from `gh run list --workflow=test.yml --branch=main
// --json databaseId,conclusion,createdAt,url` on 2026-08-04.
const RED_RUNS = [
  { databaseId: 30876289257, conclusion: null, createdAt: hoursAgo(0.02), url: 'u/0' }, // in flight
  { databaseId: 30875902502, conclusion: 'failure', createdAt: hoursAgo(0.2), url: 'https://github.com/thomaspryor/Broadwayscore/actions/runs/30875902502' },
  { databaseId: 30874926563, conclusion: 'failure', createdAt: hoursAgo(0.5), url: 'u/2' },
  { databaseId: 30873935560, conclusion: 'cancelled', createdAt: hoursAgo(0.9), url: 'u/3' },
  { databaseId: 30872052993, conclusion: 'failure', createdAt: hoursAgo(1.5), url: 'u/4' },
  { databaseId: 30800000000, conclusion: 'failure', createdAt: hoursAgo(30), url: 'u/5' },
  { databaseId: 30700000000, conclusion: 'success', createdAt: hoursAgo(48), url: 'u/6' },
];

function redSnapshot(extra = {}) {
  const trunk = summarizeTrunkRuns(RED_RUNS, { now: NOW });
  return {
    generatedAt: new Date(NOW - 5 * 60e3).toISOString(),
    workflow: 'test.yml', branch: 'main',
    ...trunk,
    failingJobs: [
      { name: 'Unit Tests', steps: ['Run unit tests (no-data-dependency)'] },
      { name: 'Data Validation', steps: ['Audit stale duplicateOf flags'] },
      { name: 'Lint Workflows', steps: ['Audit — no orphan unit tests'] },
      { name: 'Test Summary', steps: ['Check results'] },
    ],
    topFailingJob: 'Unit Tests',
    failingPaths: extractFailingPaths(REAL_LOG),
    ...extra,
  };
}

test('summarizeTrunkRuns: cancelled runs are not red, in-flight runs are not decided', () => {
  const t = summarizeTrunkRuns(RED_RUNS, { now: NOW });
  assert.equal(t.state, 'RED');
  // 4 failures lead the list; the cancelled run in the middle is skipped
  // entirely (~75% of this repo's main runs cancel on data-commit churn).
  assert.equal(t.consecutiveFailures, 4);
  assert.equal(t.lastSuccessAt, hoursAgo(48));
  assert.equal(t.latestFailedRunId, '30875902502');
  assert.ok(t.redForHours > 29 && t.redForHours < 31, `redForHours=${t.redForHours}`);
});

test('summarizeTrunkRuns: latest decided run green → GREEN, no streak', () => {
  const t = summarizeTrunkRuns(
    [{ conclusion: 'cancelled', createdAt: hoursAgo(0.1) },
     { conclusion: 'success', createdAt: hoursAgo(1) },
     { conclusion: 'failure', createdAt: hoursAgo(4) }],
    { now: NOW }
  );
  assert.equal(t.state, 'GREEN');
  assert.equal(t.consecutiveFailures, 0);
});

test('summarizeTrunkRuns: nothing decided → UNKNOWN (never a false GREEN)', () => {
  assert.equal(summarizeTrunkRuns([{ conclusion: null, createdAt: hoursAgo(1) }], { now: NOW }).state, 'UNKNOWN');
  assert.equal(summarizeTrunkRuns([], { now: NOW }).state, 'UNKNOWN');
});

test('extractFailingPaths: real log yields exactly the implicated files, not remediation advice', () => {
  const paths = extractFailingPaths(REAL_LOG);
  const names = paths.map((p) => p.path).sort();
  assert.deepEqual(names, [
    'scripts/audit-cross-outlet-attributions.test.mjs',
    'scripts/tests/tm-gap-links.test.mjs',
  ]);
  // The orphan audit's own output tells you to edit test.yml and
  // audit-orphan-tests.js. Attributing those would refuse closure to every
  // card that touched CI config over somebody else's orphan.
  assert.ok(!names.includes('.github/workflows/test.yml'));
  assert.ok(!names.includes('scripts/audit-orphan-tests.js'));

  const tm = paths.find((p) => p.path === 'scripts/tests/tm-gap-links.test.mjs');
  assert.equal(tm.job, 'Unit Tests');
  assert.match(tm.evidence, /not ok 2 - verified TodayTix-gap shows/);
  const orphan = paths.find((p) => p.path === 'scripts/audit-cross-outlet-attributions.test.mjs');
  assert.equal(orphan.job, 'Lint Workflows');
});

test('(a) card #956, whose OWN test is failing on main, is refused closure', () => {
  const res = evaluateCloseGate({
    trunk: redSnapshot(),
    // Verbatim shape of a Key Files field.
    keyFiles: 'scripts/tests/tm-gap-links.test.mjs — new invariant test\nscripts/enrich-fallback-ticket-links.js',
    changedFiles: ['data/shows.json'],
    now: NOW,
  });
  assert.equal(res.allowed, false);
  assert.equal(res.reason, GATE_REASONS.OWN_FAILURE);
  assert.deepEqual(res.blocking.map((b) => b.path), ['scripts/tests/tm-gap-links.test.mjs']);
  assert.match(res.message, /cannot close/);
  assert.match(res.message, /tm-gap-links\.test\.mjs/);
  assert.match(res.message, /Unit Tests/);
});

test('(a2) the orphaned-test card (#990/#993) is refused via its branch diff alone', () => {
  const res = evaluateCloseGate({
    trunk: redSnapshot(),
    keyFiles: '',
    changedFiles: ['scripts/audit-cross-outlet-attributions.js', 'scripts/audit-cross-outlet-attributions.test.mjs'],
    now: NOW,
  });
  assert.equal(res.allowed, false);
  assert.deepEqual(res.blocking.map((b) => b.path), ['scripts/audit-cross-outlet-attributions.test.mjs']);
});

test('(b) an unrelated card closes normally while trunk is red', () => {
  const res = evaluateCloseGate({
    trunk: redSnapshot(),
    keyFiles: 'scripts/lib/scraper.js — SB exhaustion latch\nscripts/lib/scraper.test.mjs',
    changedFiles: ['scripts/lib/url-discovery.js'],
    now: NOW,
  });
  assert.equal(res.allowed, true);
  assert.equal(res.reason, GATE_REASONS.UNRELATED);
  assert.equal(res.trunkState, 'RED');
  assert.deepEqual(res.blocking, []);
});

test('gate fails OPEN: no snapshot, stale snapshot, unattributable red, no owned files', () => {
  const base = { keyFiles: 'scripts/tests/tm-gap-links.test.mjs', now: NOW };
  assert.equal(evaluateCloseGate({ ...base, trunk: null }).reason, GATE_REASONS.NO_SNAPSHOT);
  assert.equal(
    evaluateCloseGate({ ...base, trunk: redSnapshot({ generatedAt: new Date(NOW - 9 * 3600e3).toISOString() }) }).reason,
    GATE_REASONS.STALE_SNAPSHOT
  );
  // Log download failed → no attribution → must not block anyone.
  assert.equal(evaluateCloseGate({ ...base, trunk: redSnapshot({ failingPaths: [] }) }).reason, GATE_REASONS.UNATTRIBUTABLE);
  assert.equal(
    evaluateCloseGate({ trunk: redSnapshot(), keyFiles: '', changedFiles: [], now: NOW }).reason,
    GATE_REASONS.NO_OWNED_PATHS
  );
  assert.equal(evaluateCloseGate({ ...base, trunk: redSnapshot(), disabled: true }).reason, GATE_REASONS.DISABLED);
  for (const r of [null, redSnapshot({ generatedAt: new Date(NOW - 9 * 3600e3).toISOString() }), redSnapshot({ failingPaths: [] })]) {
    assert.equal(evaluateCloseGate({ ...base, trunk: r }).allowed, true);
  }
});

test('a green trunk never blocks', () => {
  const green = { generatedAt: new Date(NOW).toISOString(), state: 'GREEN', failingPaths: [] };
  const res = evaluateCloseGate({ trunk: green, keyFiles: 'scripts/tests/tm-gap-links.test.mjs', now: NOW });
  assert.equal(res.allowed, true);
  assert.equal(res.reason, GATE_REASONS.GREEN);
});

test('collectOwnedPaths: Key Files prose + diff, data files excluded', () => {
  const owned = collectOwnedPaths({
    keyFiles: '`scripts/lib/trunk-close-gate.js` (new), tests/fixtures/x.json, data/shows.json',
    changedFiles: ['scripts/produce-trunk-snapshot.js', 'data/reviews.json', ''],
  });
  assert.deepEqual(owned.sort(), ['scripts/lib/trunk-close-gate.js', 'scripts/produce-trunk-snapshot.js']);
});

test('(c) digest line renders RED with the consecutive-failure count, and is the headline past 24h', () => {
  const line = renderTrunkDigestLine(redSnapshot());
  assert.equal(line.level, 'critical');
  assert.match(line.text, /^trunk: RED \(4 consecutive failures/);
  assert.match(line.text, /top failing job: Unit Tests/);
  assert.match(line.text, /red for 30h/);
  // Red for ~30h on 2026-08-04 → this is the headline, not a buried row.
  assert.equal(line.headline, true);
  assert.equal(line.bannerText, line.text);
  assert.deepEqual(line.items.map((i) => i.title), [
    'scripts/tests/tm-gap-links.test.mjs',
    'scripts/audit-cross-outlet-attributions.test.mjs',
  ]);
});

test('(c3) streak running off the end of the window reports a FLOOR duration and still headlines', () => {
  // The live 2026-08-04 shape: 23 consecutive failures and no success
  // anywhere in the fetched window, so elapsed in-window time (8h) is a floor,
  // not the real age of the red.
  const runs = Array.from({ length: 23 }, (_, i) => ({
    databaseId: 30876000000 + i, conclusion: 'failure', createdAt: hoursAgo(0.2 + i * 0.35), url: `u/${i}`,
  }));
  const t = summarizeTrunkRuns(runs, { now: NOW });
  assert.equal(t.consecutiveFailures, 23);
  assert.equal(t.lastSuccessAt, null);
  assert.equal(t.redDurationIsFloor, true);

  const line = renderTrunkDigestLine({ ...t, generatedAt: new Date(NOW).toISOString(), topFailingJob: 'Unit Tests' });
  assert.match(line.text, /^trunk: RED \(23 consecutive failures, red for 8h\+/);
  // Under 24h in-window, but 23 straight failures with no green at all is the
  // same emergency — it must still be the headline.
  assert.equal(line.headline, true);
});

test('(c2) freshly-red trunk reports RED but does not take the headline', () => {
  const fresh = summarizeTrunkRuns(
    [{ conclusion: 'failure', createdAt: hoursAgo(2) }, { conclusion: 'success', createdAt: hoursAgo(3) }],
    { now: NOW }
  );
  const line = renderTrunkDigestLine({ ...fresh, generatedAt: new Date(NOW).toISOString(), topFailingJob: 'Unit Tests' });
  assert.match(line.text, /^trunk: RED \(1 consecutive failure,/);
  assert.equal(line.headline, false);
});

test('digest line: GREEN renders, UNKNOWN renders nothing at all', () => {
  const green = renderTrunkDigestLine({ state: 'GREEN', generatedAt: new Date(NOW).toISOString() });
  assert.equal(green.level, 'ok');
  assert.match(green.text, /^trunk: GREEN/);
  assert.equal(renderTrunkDigestLine({ state: 'UNKNOWN' }), null);
  assert.equal(renderTrunkDigestLine(null), null);
});
