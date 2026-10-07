/**
 * BRO-2713 — test-summary must go red on a CANCELLED needs job (a job-level
 * timeout reports 'cancelled', not 'failure'), not only on 'failure'.
 * BRO-4752 — and on ANY result that is not success/skipped: run 37364141042
 * had five needs jobs starved of a runner, whose needs result matched neither
 * 'failure' nor 'cancelled', and Check results printed "All tests passed".
 * So the check is an allowlist over toJSON(needs), exercised here by running
 * the real step script under bash against fixture needs objects.
 * Parsed with js-yaml (comments ignored), not grepped. PR cancel-in-progress
 * supersession is safe: the superseded run is replaced by the newer commit's
 * run, and main uses a per-sha non-cancelling group (test.yml concurrency).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const wf = yaml.load(fs.readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'));
const job = wf.jobs['test-summary'];
const step = job.steps.find((s) => s.name === 'Check results');

function runCheck(needs) {
  return spawnSync('bash', ['-e', '-c', step.run], {
    encoding: 'utf8',
    env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) },
  });
}

const allGreen = () => Object.fromEntries(job.needs.map((n) => [n, { result: 'success', outputs: {} }]));

test('test-summary runs always and has a Check results step', () => {
  assert.equal(job.if, 'always()');
  assert.ok(step && typeof step.run === 'string');
});

test('Check results reads every needs result via toJSON(needs), not a per-value contains()', () => {
  assert.equal(step.env?.NEEDS_JSON, '${{ toJSON(needs) }}');
  assert.doesNotMatch(step.run, /contains\(needs/);
});

test('all success (visual-regression skipped) passes', () => {
  const needs = allGreen();
  needs['visual-regression'] = { result: 'skipped', outputs: {} };
  const r = runCheck(needs);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All tests passed/);
});

for (const result of ['failure', 'cancelled', 'abandoned', 'timed_out', '']) {
  test(`a needs job with result '${result}' fails the check`, () => {
    const needs = allGreen();
    needs['unit-tests'] = { result, outputs: {} };
    const r = runCheck(needs);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Some tests failed/);
    assert.match(r.stdout, /unit-tests/);
  });
}

test('unparseable NEEDS_JSON fails closed', () => {
  const r = spawnSync('bash', ['-e', '-c', step.run], { encoding: 'utf8', env: { ...process.env, NEEDS_JSON: 'not json' } });
  assert.notEqual(r.status, 0);
});

test('Check results is not scoped away from PRs/non-main (no step-level if)', () => {
  assert.equal(step.if, undefined);
});
