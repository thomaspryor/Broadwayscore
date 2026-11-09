// BRO-6978: pins how process-review-submission.yml emails submitters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';

const wf = yaml.load(fs.readFileSync(new URL('../../.github/workflows/process-review-submission.yml', import.meta.url), 'utf8'));
const steps = wf.jobs.validate.steps;
const emailSteps = steps.filter(s => typeof s.run === 'string' && s.run.includes('to:[e.EMAIL]'));
const NOTIFY = "(github.event_name != 'workflow_dispatch' || inputs.notify)";

test('every submitter email can be switched off on a re-check, and stays on for new issues', () => {
  assert.equal(emailSteps.length, 3, emailSteps.map(s => s.name).join(', '));
  for (const s of emailSteps) assert.ok(String(s.if).includes(NOTIFY), `${s.name}: ${s.if}`);
  assert.equal(wf.on.workflow_dispatch.inputs.notify.type, 'boolean');
  assert.equal(wf.on.workflow_dispatch.inputs.notify.default, true);
});

test('a review we already list gets its own close + email, never the reject path', () => {
  const names = steps.map(s => s.name);
  assert.ok(names.includes('Close - Already listed'));
  assert.ok(names.includes('Notify submitter - Already listed'));
  const reject = steps.find(s => s.name === 'Notify submitter - Rejected');
  assert.match(reject.if, /== 'reject'/);
});

test('no submitter email carries the old generic rejection text', () => {
  const all = JSON.stringify(steps);
  assert.doesNotMatch(all, /unable to add it to our database|Common reasons/);
});

test('a re-check reopens the issue and drops the stale invalid label', () => {
  const s = steps.find(x => x.name === 'Reopen issue for a re-check');
  assert.equal(s.if, "github.event_name == 'workflow_dispatch'");
  assert.match(s.with.script, /name: 'invalid'/);
  assert.match(s.with.script, /state: 'open'/);
});
