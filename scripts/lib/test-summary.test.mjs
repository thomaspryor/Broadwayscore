/**
 * BRO-2713 — test-summary must go red on a CANCELLED needs job (a job-level
 * timeout reports 'cancelled', not 'failure'), not only on 'failure'.
 * Parsed with js-yaml (comments ignored), not grepped. PR cancel-in-progress
 * supersession is safe: the superseded run is replaced by the newer commit's
 * run, and main uses a per-sha non-cancelling group (test.yml concurrency).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';

const wf = yaml.load(fs.readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'));
const job = wf.jobs['test-summary'];
const step = job.steps.find((s) => s.name === 'Check results');

test('test-summary runs always and has a Check results step', () => {
  assert.equal(job.if, 'always()');
  assert.ok(step && typeof step.run === 'string');
});

test('Check results fails on failure OR cancelled across all needs', () => {
  const m = step.run.match(/if \[ "\$\{\{ contains\(needs\.\*\.result, 'failure'\) \}\}" == "true" \] \|\| \[ "\$\{\{ contains\(needs\.\*\.result, 'cancelled'\) \}\}" == "true" \]; then/);
  assert.ok(m, 'failure || cancelled condition missing');
  assert.match(step.run, /exit 1/);
});

test('Check results is not scoped away from PRs/non-main (no step-level if)', () => {
  assert.equal(step.if, undefined);
});
