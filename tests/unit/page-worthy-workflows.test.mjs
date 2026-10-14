/**
 * BRO-4603: which workflows may email the owner when they fail.
 *
 * Owner, 2026-10-04: "I only want emails if they're really urgent and need me
 * to act on them." Over 2026-10-01..04 the notify-failure composite action
 * sent 8 "[CRITICAL]" emails plus an "[Investigation]" email, none of which
 * the owner could or needed to act on, because any workflow that wrote
 * severity:'critical' paged directly. scripts/lib/page-worthy-alerts.js
 * PAGE_WORTHY_WORKFLOWS is now the one list; this file keeps the YAML, the
 * action and the list from drifting apart.
 *
 * Run: node --test tests/unit/page-worthy-workflows.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { PAGE_WORTHY_WORKFLOWS, isPageWorthyWorkflow } = require('../../scripts/lib/page-worthy-alerts.js');
const { findCriticalNotifySteps } = require('../../scripts/lib/critical-workflow-notify-cancelled.js');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const ACTION_PATH = path.join(REPO_ROOT, '.github', 'actions', 'notify-failure', 'action.yml');

test('isPageWorthyWorkflow: listed basenames and workflow refs page; everything else does not', () => {
  assert.equal(isPageWorthyWorkflow('opening-night-poller.yml'), true);
  assert.equal(isPageWorthyWorkflow('thomaspryor/Broadwayscore/.github/workflows/opening-night-poller.yml@refs/heads/main'), true);
  assert.equal(isPageWorthyWorkflow('vercel-deploy.yml'), false);
  assert.equal(isPageWorthyWorkflow('card-verifiability-audit.yml'), false);
  assert.equal(isPageWorthyWorkflow(''), false);
  assert.equal(isPageWorthyWorkflow(undefined), false);
});

test('every PAGE_WORTHY_WORKFLOWS entry is a real workflow file', () => {
  for (const file of PAGE_WORTHY_WORKFLOWS) {
    assert.ok(fs.existsSync(path.join(WORKFLOWS_DIR, file)), `${file} is listed as page-worthy but does not exist`);
  }
});

test("the set of severity:'critical' notify-failure workflows equals PAGE_WORTHY_WORKFLOWS", () => {
  const critical = new Set(findCriticalNotifySteps(WORKFLOWS_DIR, yaml.load).map((s) => s.file));
  const extra = [...critical].filter((f) => !PAGE_WORTHY_WORKFLOWS.has(f)).sort();
  const missing = [...PAGE_WORTHY_WORKFLOWS].filter((f) => !critical.has(f)).sort();
  assert.deepEqual(extra, [],
    `These workflows ask notify-failure for severity:'critical' but are not page-worthy. The owner only wants email when it is urgent AND they must act. ` +
    `Use severity:'warning' (the morning digest reports it), or add the file to PAGE_WORTHY_WORKFLOWS in scripts/lib/page-worthy-alerts.js with the reason the owner must act: ${extra.join(', ')}`);
  assert.deepEqual(missing, [],
    `These are listed as page-worthy but have no severity:'critical' notify-failure step, so they can never page: ${missing.join(', ')}`);
});

test('notify-failure checks the page-worthy policy before cooldown/streak and only sends when it allows', () => {
  const action = yaml.load(fs.readFileSync(ACTION_PATH, 'utf-8'));
  const steps = action.runs.steps;
  const policyIdx = steps.findIndex((s) => s.id === 'policy');
  const cooldownIdx = steps.findIndex((s) => s.id === 'cooldown');
  const send = steps.find((s) => s.name === 'Send failure alert');
  assert.ok(policyIdx >= 0, 'no step with id: policy in notify-failure/action.yml');
  assert.ok(policyIdx < cooldownIdx, 'the policy step must run before the cooldown/streak step (streak mode returns early)');
  assert.match(steps[policyIdx].with.script, /isPageWorthyWorkflow\(/, 'policy step must call isPageWorthyWorkflow');
  assert.match(String(steps[cooldownIdx].if), /steps\.policy\.outputs\.page == 'true'/);
  assert.match(String(send.if), /steps\.policy\.outputs\.page == 'true'/);
  // A non-paging call must report suppressed='true'; an empty value let
  // investigate-alert.yml dispatches gated on `!= 'true'` email anyway.
  assert.match(String(action.outputs.suppressed.value), /steps\.policy\.outputs\.page != 'true' && 'true'/);
});

test('investigate-alert.yml (always emails) is only dispatched by page-worthy workflows or behind the notify suppressed gate', () => {
  const offenders = [];
  for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    if (file === 'investigate-alert.yml') continue;
    const doc = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8')) || {};
    for (const [jobId, job] of Object.entries(doc.jobs || {})) {
      for (const step of job.steps || []) {
        const run = String(step.run || '');
        if (!/workflow run investigate-alert\.yml|investigate-alert\.yml\/dispatches/.test(run)) continue;
        if (PAGE_WORTHY_WORKFLOWS.has(file)) continue;
        if (/suppressed != 'true'/.test(String(step.if || ''))) continue;
        offenders.push(`${file} / ${jobId} / ${step.name || '(unnamed)'}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'These steps dispatch investigate-alert.yml (which always emails the owner) from a workflow that is not page-worthy, ' +
    "without the `steps.<notify>.outputs.suppressed != 'true'` gate: " + offenders.join('; '));
});
