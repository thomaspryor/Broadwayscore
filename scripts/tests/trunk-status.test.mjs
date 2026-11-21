/**
 * trunk-status.test.mjs — task #1003.
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
  summarizeTrunkRuns, extractFailingPaths, renderTrunkDigestLine,
} = require(path.join(REPO, 'scripts/lib/trunk-status.js'));

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
  // Green streak stops at the failure 4h back. The cancelled run is not
  // decided, so it neither breaks the streak nor counts toward it.
  assert.equal(t.consecutiveSuccesses, 1);
  assert.equal(t.greenSince, hoursAgo(1));
  assert.ok(Math.abs(t.greenForHours - 1) < 0.01, `greenForHours ${t.greenForHours}`);
  assert.equal(t.greenDurationIsFloor, false);
});

// The green-streak mirror of the redDurationIsFloor case below. Added with
// scripts/verify-main-green-streak.test.mjs (card 3bd637c5-416f-81ed): that
// probe asks "has main STAYED green for 24h?", which the GREEN branch could
// not answer before — it recorded only that the latest run passed.
test('summarizeTrunkRuns: GREEN records the streak length and duration, not just the latest run', () => {
  const t = summarizeTrunkRuns(
    [{ conclusion: 'success', createdAt: hoursAgo(1) },
     { conclusion: 'success', createdAt: hoursAgo(10) },
     { conclusion: 'success', createdAt: hoursAgo(30) },
     { conclusion: 'failure', createdAt: hoursAgo(40) },
     { conclusion: 'success', createdAt: hoursAgo(50) }],
    { now: NOW }
  );
  assert.equal(t.state, 'GREEN');
  assert.equal(t.consecutiveSuccesses, 3);
  assert.equal(t.greenSince, hoursAgo(30));
  assert.ok(t.greenForHours >= 24, `greenForHours ${t.greenForHours} should clear the 24h hold`);
  // A failure exists in the window, so the duration is exact, not a floor.
  assert.equal(t.greenDurationIsFloor, false);
});

test('summarizeTrunkRuns: an all-green window reports a FLOOR duration (streak runs off the end)', () => {
  const t = summarizeTrunkRuns(
    [{ conclusion: 'success', createdAt: hoursAgo(1) },
     { conclusion: 'cancelled', createdAt: hoursAgo(2) },
     { conclusion: 'success', createdAt: hoursAgo(6) }],
    { now: NOW }
  );
  assert.equal(t.state, 'GREEN');
  assert.equal(t.consecutiveSuccesses, 2);
  assert.equal(t.greenDurationIsFloor, true,
    'no failure anywhere in the window means the real green duration is AT LEAST greenForHours');
});

test('summarizeTrunkRuns: RED emits explicit zero/null green fields, never undefined', () => {
  const t = summarizeTrunkRuns(
    [{ conclusion: 'failure', createdAt: hoursAgo(1) },
     { conclusion: 'success', createdAt: hoursAgo(9) }],
    { now: NOW }
  );
  assert.equal(t.state, 'RED');
  // JSON.stringify drops undefined, so an undefined here would vanish from the
  // committed snapshot and the acceptance probe could not tell "red" from
  // "old snapshot that predates these fields".
  const round = JSON.parse(JSON.stringify(t));
  assert.equal(round.consecutiveSuccesses, 0);
  assert.equal(round.greenSince, null);
  assert.equal(round.greenForHours, null);
  assert.equal(round.greenDurationIsFloor, false);
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

test('a truncated failure block does not leak attribution into the next job', () => {
  // Real shape when a step dies mid-diagnostic: the `not ok` YAML block never
  // closes, and the next job's lines follow immediately. Latching across that
  // boundary would blame an innocent card for someone else's failure.
  const log = [
    'Unit Tests\tRun unit tests\t2026-08-04T03:54:50.5Z not ok 2 - verified TodayTix-gap shows carry a real Ticketmaster link',
    "Unit Tests\tRun unit tests\t2026-08-04T03:54:50.5Z   location: '/home/runner/work/Broadwayscore/Broadwayscore/scripts/tests/tm-gap-links.test.mjs:55:1'",
    'Lint Workflows\tCheck workflow lint\t2026-08-04T03:51:48.4Z reading scripts/lib/innocent-helper.js',
    'Lint Workflows\tCheck workflow lint\t2026-08-04T03:51:48.4Z scanned src/components/Innocent.tsx',
  ].join('\n');
  const names = extractFailingPaths(log).map((p) => p.path);
  assert.deepEqual(names, ['scripts/tests/tm-gap-links.test.mjs']);
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
