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

function runWithStub(conclusions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cihc-'));
  const runs = conclusions.map((c, i) => ({ databaseId: 100 + i, status: 'completed', conclusion: c.run }));
  const detail = Object.fromEntries(conclusions.map((c, i) => [100 + i, { conclusion: c.run, jobs: c.jobs.map((j) => ({ conclusion: j })) }]));
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
