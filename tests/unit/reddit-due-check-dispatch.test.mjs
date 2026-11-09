// BRO-6987: GitHub drops many runs of reddit-engagement-digest.yml's hourly
// cron, so the opening-night poller dispatches the same due check after each
// verified deploy. These pins keep the dispatch, the input and the job
// selection in step: a due_check dispatch must run the due gate (and the
// drafter only when due), never the daily digest, and in report-only mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const load = f => yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8'));

const digest = load('reddit-engagement-digest.yml');
const poller = load('opening-night-poller.yml');
const HOURLY = "(github.event.schedule == '41 * * * *' || inputs.due_check == true)";

test('digest workflow takes a boolean due_check dispatch input, default off', () => {
  const input = digest.on.workflow_dispatch.inputs.due_check;
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, false);
});

test('a due_check dispatch selects the hourly path everywhere the cron does', () => {
  assert.ok(digest.concurrency.group.includes(`${HOURLY} && 'hourly'`), 'shares the hourly concurrency group');
  assert.ok(digest.jobs.due.if.includes(HOURLY), 'runs the due gate');
  assert.ok(digest.jobs['draft-opening-posts'].if.includes(`!${HOURLY} || needs.due.outputs.due == 'true'`), 'drafter only when due');
  const reviewStep = digest.jobs['draft-opening-posts'].steps.find(s => s.env && s.env.REVIEW_CHECK_MODE);
  assert.ok(reviewStep.env.REVIEW_CHECK_MODE.includes(HOURLY), 'review check is report-only on the hourly path');
  // No other step may still key on the bare cron string.
  const raw = fs.readFileSync(path.join(root, '.github', 'workflows', 'reddit-engagement-digest.yml'), 'utf8');
  const bare = raw.split('\n').filter(l => l.includes("schedule == '41 * * * *'") && !l.includes(HOURLY));
  assert.deepEqual(bare, [], 'every hourly check also accepts due_check');
});

test('a due_check dispatch never runs the daily digest', () => {
  assert.match(digest.jobs.digest.if, /inputs\.due_check != true/);
});

test('poller dispatches the due check only after a verified deploy, without failing the poll', () => {
  const steps = poller.jobs[Object.keys(poller.jobs).find(j => (poller.jobs[j].steps || []).some(s => s.id === 'deploy_verify'))].steps;
  const vi = steps.findIndex(s => s.id === 'deploy_verify');
  const di = steps.findIndex(s => typeof s.run === 'string' && s.run.includes('reddit-engagement-digest.yml -f due_check=true'));
  assert.ok(di > vi, 'dispatch step comes after deploy_verify');
  const step = steps[di];
  assert.equal(step.if, "steps.deploy_verify.outputs.verified == 'true'");
  assert.equal(step['continue-on-error'], true);
  assert.match(step.env.GH_TOKEN, /secrets\.GITHUB_TOKEN/);
  assert.equal(poller.permissions.actions, 'write', 'GITHUB_TOKEN may dispatch');
});
