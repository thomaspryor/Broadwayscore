/**
 * health-check.js "Main: mid-setup cancels" row wiring (checkCiMidSetupCancels, BRO-2512).
 * Pins that scripts/ci-health-check.sh has a scheduled caller (data-health-check.yml runs
 * health-check.js daily) and that exit 0/1/2 map to pass / warn-with-numbers / warn-no-reading.
 * Also runs the real script against a stubbed `gh` for a healthy and an unhealthy sample.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ghApiCache = require('./lib/gh-api-cache.js');
mock.method(ghApiCache, 'hasLowHeadroom', () => false);
process.env.GH_TOKEN = process.env.GH_TOKEN || 'test-token';
const { checkCiMidSetupCancels } = require('./health-check.js');

const REPORT = (n, pct, total = 20) => `=== CI Health: test.yml on main (last ${total} completed runs, 0 skipped) ===\n  Mid-setup cancelled (never validated):        ${n} (${pct}%)\n`;

test('exit 0 → pass row with the rate', () => {
  const [row] = checkCiMidSetupCancels({ exec: () => REPORT(1, 5) });
  assert.equal(row.name, 'Main: mid-setup cancels');
  assert.equal(row.status, 'pass');
  assert.match(row.message, /^5% of the last 20 /);
});

test('exit 1 is a reading: warn row WITH the numbers', () => {
  const exec = () => { const e = new Error('exit 1'); e.status = 1; e.stdout = REPORT(12, 60); throw e; };
  const [row] = checkCiMidSetupCancels({ exec });
  assert.equal(row.status, 'warn');
  assert.match(row.message, /^60% \(12 of 20\)/);
  assert.match(row.message, /audit-workflow-concurrency/);
});

test('exit 2 / spawn failure is a warn row that says no reading, never pass', () => {
  const exec = () => { const e = new Error('x'); e.status = 2; e.stderr = '::error::run listing failed\nmore'; throw e; };
  const [row] = checkCiMidSetupCancels({ exec });
  assert.equal(row.status, 'warn');
  assert.match(row.message, /^ci-health-check\.sh failed \(exit 2\) — no reading: ::error::run listing failed$/);
});

test('the headroom row is present on every path, as "no reading" when unmeasured (absent reads as fixed)', () => {
  const exec = () => { const e = new Error('x'); e.status = 2; e.stderr = 'boom'; throw e; };
  const rows = checkCiMidSetupCancels({ exec });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, 'Main: job time headroom');
  assert.equal(rows[1].status, 'warn');
  assert.match(rows[1].message, /no reading/);
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
  try {
    const skipped = checkCiMidSetupCancels({ exec });
    assert.deepEqual(skipped.map((r) => [r.name, r.status]), [['Main: mid-setup cancels', 'warn'], ['Main: job time headroom', 'warn']]);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

function runWithStub(conclusions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cihc-'));
  const runs = conclusions.map((c, i) => ({ databaseId: 100 + i, status: 'completed', conclusion: c.run }));
  const detail = Object.fromEntries(conclusions.map((c, i) => [100 + i, { conclusion: c.run, jobs: c.jobs.map((j) => (typeof j === 'string' ? { conclusion: j } : j)) }]));
  fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify(runs));
  fs.writeFileSync(path.join(dir, 'detail.json'), JSON.stringify(detail));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash
D="${dir}"
if [ "$1" = "run" ] && [ "$2" = "view" ]; then jq ".\\"$3\\"" "$D/detail.json"; exit 0; fi
if [ "$1" = "api" ]; then cat "$D/runs.json"; exit 0; fi
exit 1
`, { mode: 0o755 });
  return { dir, ...spawnSync('bash', [path.resolve('scripts/ci-health-check.sh'), String(conclusions.length), '30'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }) };
}

test('real script (stubbed gh): healthy sample exits 0, cancel storm exits 1', () => {
  const healthy = runWithStub(Array.from({ length: 5 }, () => ({ run: 'success', jobs: ['success'] })));
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /Mid-setup cancelled \(never validated\):\s+0 \(0%\)/);
  const bad = runWithStub(Array.from({ length: 5 }, () => ({ run: 'cancelled', jobs: [] })));
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /\(100%\)/);
  const validated = runWithStub(Array.from({ length: 5 }, () => ({ run: 'cancelled', jobs: ['success'] })));
  assert.equal(validated.status, 0, 'cancelled-after-validating is not mid-setup');
});

// --- BRO-7102 stage 4: "Main: job time headroom" ---
const { timeoutHeadroom, readJobTimeouts } = require('./lib/cron-health.js');
const { jobHeadroomRow } = require('./health-check.js');
const T0 = Date.parse('2026-11-07T00:00:00Z');
const job = (name, conclusion, minutes, i = 0) => ({
  name, conclusion,
  startedAt: new Date(T0 + i * 3600000).toISOString(),
  completedAt: new Date(T0 + i * 3600000 + minutes * 60000).toISOString(),
});
// The 30 days to 2026-11-07, shape-for-shape: green runs 24-29 min, two killed at the 30 min limit.
const UNIT_TESTS_NOV = [24, 25, 25, 26, 27, 28, 29].map((m, i) => job('Unit Tests', 'success', m, i))
  .concat([job('Unit Tests', 'cancelled', 30.2, 8), job('Unit Tests', 'cancelled', 30.1, 9)]);

test('timeoutHeadroom: the November Unit Tests sample is tight at 30 min and roomy at 45', () => {
  const [at30] = timeoutHeadroom(UNIT_TESTS_NOV, { 'Unit Tests': 30 });
  assert.equal(at30.n, 9, 'timeout-cancelled jobs count (no survivor bias)');
  assert.ok(at30.p90Min > 30 && at30.tight);
  const [at45] = timeoutHeadroom(UNIT_TESTS_NOV, { 'Unit Tests': 45 });
  assert.equal(at45.tight, false);
});

test('timeoutHeadroom: concurrency cancels, skips, unmatched names and small samples say nothing', () => {
  const jobs = [
    ...[10, 11, 12, 13, 14].map((m, i) => job('Lint', 'success', m, i)),
    job('Lint', 'cancelled', 2, 6), job('Lint', 'skipped', 0, 7),
    job('E2E (1/4)', 'success', 50), job('Build', 'success', 9),
  ];
  const rows = timeoutHeadroom(jobs, { Lint: 20, Build: 10 });
  assert.deepEqual(rows.map((r) => [r.name, r.n]), [['Lint', 5]]);
  assert.equal(rows[0].p90Min, 14);
});

test('the real test.yml limit for Unit Tests is read by display name', () => {
  const t = readJobTimeouts('test.yml');
  assert.equal(t['Unit Tests'], t['unit-tests']);
  assert.ok(t['Unit Tests'] > 0, 'Unit Tests has a timeout-minutes the headroom row can read');
});

test('jobHeadroomRow: warn names the job and the speed-up card; pass names the tightest; no line is no reading', () => {
  const line = (jobs) => `x\nJOB-DURATIONS: ${JSON.stringify(jobs)}\n`;
  const warn = jobHeadroomRow(line(UNIT_TESTS_NOV), { timeouts: { 'Unit Tests': 30 } });
  assert.equal(warn.name, 'Main: job time headroom');
  assert.equal(warn.status, 'warn');
  assert.match(warn.message, /Unit Tests p90 30 of 30 min .*BRO-7113/);
  const pass = jobHeadroomRow(line(UNIT_TESTS_NOV), { timeouts: { 'Unit Tests': 45 } });
  assert.equal(pass.status, 'pass');
  // Kills at 30 min are not timeout-shaped against a 45 min limit, so only the 7 green runs count.
  assert.match(pass.message, /tightest: Unit Tests p90 29 of 45 min \(64%, n=7\)/);
  assert.match(jobHeadroomRow('no line here').message, /no reading/);
  assert.match(jobHeadroomRow(line([]), { timeouts: {} }).message, /no reading/);
});

test('real script (stubbed gh) prints the job durations health-check reads, no extra gh calls', () => {
  const r = runWithStub(UNIT_TESTS_NOV.map((j) => ({ run: j.conclusion, jobs: [j] })));
  const out = r.stdout.split('\n').find((l) => l.startsWith('JOB-DURATIONS: '));
  assert.ok(out, r.stdout + r.stderr);
  assert.equal(JSON.parse(out.slice(15)).length, 9);
  const rows = checkCiMidSetupCancels({ exec: () => r.stdout });
  assert.equal(rows[1].name, 'Main: job time headroom');
  // Read against the real test.yml limit, whatever it is now.
  assert.match(rows[1].message, /Unit Tests p90 \d+ of \d+ min/);
});

test('matrix shards (`Unit Test Shard (2)`) pool under the workflow name and read the real limit', () => {
  const t = readJobTimeouts('test.yml');
  assert.ok(t['Unit Test Shard'] > 0, 'the shard job has a timeout-minutes');
  const shards = [1, 2, 3, 4].flatMap((k) => [8, 9, 10].map((m, i) => job(`Unit Test Shard (${k})`, 'success', m, k * 10 + i)));
  const [row] = timeoutHeadroom(shards, t);
  assert.equal(row.name, 'Unit Test Shard');
  assert.equal(row.n, 12);
  assert.equal(row.p90Min, 10);
});
