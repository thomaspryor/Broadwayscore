import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'rebuild-reviews.yml');

/**
 * BRO-346: "Rebuild Reviews Data" failed 7x/24h, same signature as BRO-334's
 * same-day fix on the sibling rebuild-fast.yml — "FAILED in 90s" (push-with-
 * retry.sh's default GIT_NET_TIMEOUT_SEC) with zero git --progress output,
 * i.e. a pre-transfer connection hang, not a slow transfer. At the 90s
 * default only ~6 attempts fit inside PUSH_DEADLINE_SEC=900 before the step
 * gives up. The "Commit and push changes" step overrides GIT_NET_TIMEOUT_SEC
 * down to 30s so a hung connection costs less and more attempts fit in the
 * same deadline. This test pins that override so a future edit doesn't
 * silently drop it back to the 90s shared default.
 */
function loadWorkflow() {
  return yaml.load(fs.readFileSync(WORKFLOW, 'utf-8'));
}

function findPushStep(doc) {
  const job = doc.jobs.rebuild;
  assert.ok(job, 'rebuild job must exist in rebuild-reviews.yml');
  const step = job.steps.find((s) => s.name === 'Commit and push changes');
  assert.ok(step, '"Commit and push changes" step must exist');
  return step;
}

test('rebuild-reviews push step overrides GIT_NET_TIMEOUT_SEC below the 90s shared default', () => {
  const step = findPushStep(loadWorkflow());
  const env = step.env || {};
  assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
  const val = Number(env.GIT_NET_TIMEOUT_SEC);
  assert.ok(Number.isFinite(val) && val > 0, 'GIT_NET_TIMEOUT_SEC must be a positive number');
  assert.ok(val < 90, 'GIT_NET_TIMEOUT_SEC must be lower than push-with-retry.sh\'s 90s default — that headroom is the whole point of this override (more attempts inside PUSH_DEADLINE_SEC)');
});

test('rebuild-reviews push step still sets the existing deadline/reconcile overrides', () => {
  const step = findPushStep(loadWorkflow());
  const env = step.env || {};
  assert.equal(env.PUSH_DEADLINE_SEC, '900');
  assert.equal(env.PUSH_RECONCILE_MERGED_JSON, '1');
});

test('rebuild-reviews push step invokes push-with-retry.sh with a generous retry budget', () => {
  const step = findPushStep(loadWorkflow());
  assert.match(step.run, /push-with-retry\.sh\s+25\s+main/);
});
