import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'rebuild-fast.yml');

/**
 * BRO-334: "Rebuild Reviews (Fast)" failed 11x/24h, all with the identical
 * signature in the durable push-retry-failures ledger — "FAILED in 90s"
 * (push-with-retry.sh's default GIT_NET_TIMEOUT_SEC) with zero git --progress
 * output, i.e. a pre-transfer connection hang, not a slow transfer. At the
 * 90s default only ~4 attempts fit inside PUSH_DEADLINE_SEC=600 before the
 * step gives up. The "Commit and push changes" step overrides
 * GIT_NET_TIMEOUT_SEC down to 30s so a hung connection costs less and more
 * attempts fit in the same deadline. This test pins that override so a
 * future edit doesn't silently drop it back to the 90s shared default.
 */
function loadWorkflow() {
  return yaml.load(fs.readFileSync(WORKFLOW, 'utf-8'));
}

function findPushStep(doc) {
  const job = doc.jobs['rebuild-fast'];
  assert.ok(job, 'rebuild-fast job must exist in rebuild-fast.yml');
  const step = job.steps.find((s) => s.name === 'Commit and push changes');
  assert.ok(step, '"Commit and push changes" step must exist');
  return step;
}

test('rebuild-fast push step overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value', () => {
  const step = findPushStep(loadWorkflow());
  const env = step.env || {};
  assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
  // Pins the exact shipped value, not just "< 90" — a drift to e.g. 1s (still
  // technically under the shared default) would pass a loose bound while
  // silently starving every fetch/push of real transfer time.
  assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
});

test('rebuild-fast push step still sets the existing deadline/reconcile overrides', () => {
  const step = findPushStep(loadWorkflow());
  const env = step.env || {};
  assert.equal(env.PUSH_DEADLINE_SEC, '600');
  assert.equal(env.PUSH_RECONCILE_MERGED_JSON, '1');
});

test('rebuild-fast push step invokes push-with-retry.sh with a generous retry budget', () => {
  const step = findPushStep(loadWorkflow());
  assert.match(step.run, /push-with-retry\.sh\s+20\s+main/);
});
