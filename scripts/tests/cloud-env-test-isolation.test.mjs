// BRO-7609 class guard. A test suite that depends on the cloud/session environment (CLAUDE_CODE_REMOTE=true arms
// the BRO-7554 dispatch refusal; CLAUDE_CODE_REMOTE_SESSION_ID adds a session footer to Linear comments) passes
// on the Mac and goes red in every cloud worker's pre-landing check, a false red that trains workers to ignore
// real ones. This runs the suites that drive linear-brain / linear-next / linear-session under a simulated
// cloud environment and under a clean one, and fails when their pass/fail counts differ or either run fails.
//
// To cover a new suite: add it to SUITES. To fix a red: have the suite call scrubCloudEnv()
// (tests/helpers/cloud-env.mjs) or pass an explicit env to what it spawns. Do not loosen the assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD_ENV_KEYS, simulatedCloudEnv } from '../../tests/helpers/cloud-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SUITES = [
  'tests/unit/linear-brain-cancel-gate.test.mjs',
  'tests/unit/linear-brain-done-gate.test.mjs',
  'tests/unit/linear-brain-duplicate-gate.test.mjs',
  'tests/unit/linear-brain-reopen-warning.test.mjs',
  'tests/unit/linear-brain-model-flag.test.mjs',
  'tests/unit/linear-session-done-gate.test.mjs',
  'tests/unit/linear-next.test.mjs',
  'scripts/tests/linear-next-dispatch.test.mjs',
  'scripts/tests/linear-next-overlap-guards.test.mjs',
];

function cleanEnv() {
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
  for (const k of CLOUD_ENV_KEYS) delete env[k];
  return env;
}

function runSuite(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const num = (label) => Number((out.match(new RegExp(`^# ${label} (\\d+)`, 'm')) || [])[1]);
      const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
      resolve({ file, code, pass: num('pass'), fail: num('fail'), cancelled: num('cancelled'), failed });
    });
  });
}

test('every Linear-driving suite gives the same result in a simulated cloud container as in a clean world', async () => {
  // Two batches of 9 (not 18 at once) so CI resource contention cannot time a suite out.
  const cloud = await Promise.all(SUITES.map((f) => runSuite(f, simulatedCloudEnv(cleanEnv()))));
  const clean = await Promise.all(SUITES.map((f) => runSuite(f, cleanEnv())));
  const problems = [];
  SUITES.forEach((f, i) => {
    const a = cloud[i], b = clean[i];
    if (![a.pass, a.fail, b.pass, b.fail].every(Number.isFinite)) { problems.push(`${f}: could not parse TAP totals (cloud ${a.pass}/${a.fail}, clean ${b.pass}/${b.fail}); the suite crashed or the reporter format changed`); return; }
    if (!(b.pass > 0) || b.fail !== 0) problems.push(`${f}: broken even in a clean world (pass ${b.pass}, fail ${b.fail}): ${b.failed.join('; ')}`);
    if (a.pass !== b.pass || a.fail !== b.fail || a.code !== b.code || a.cancelled !== b.cancelled) {
      problems.push(`${f}: cloud pass ${a.pass}/fail ${a.fail} vs clean pass ${b.pass}/fail ${b.fail}; red only in cloud: ${a.failed.join('; ')}. Call scrubCloudEnv() from tests/helpers/cloud-env.mjs.`);
    }
  });
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the SUITES list names real files', async () => {
  const { existsSync } = await import('node:fs');
  for (const f of SUITES) assert.ok(existsSync(path.join(ROOT, f)), `${f} does not exist`);
});
