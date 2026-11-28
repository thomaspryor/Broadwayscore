// BRO-6775: newsletter-draft-refresh.yml can email the owner a [DRAFT] preview
// (Sunday 9am ET, fired by an external Claude scheduled task via
// workflow_dispatch sendPreview=1, with a late-cron fallback).
//
// What must stay true, each of which a well-meaning cleanup could silently break:
//  1. sendPreview is a STRING input ('1' convention, like allowGaps). A boolean
//     renders "true"/"false", never '1', so the preview would silently never send.
//  2. The preview step is the transactional owner send (send-test.mjs), gated on
//     the decide step, and runs AFTER the de-dup commit so a preview failure can
//     never skip the ledger commit.
//  3. Nothing in this workflow can broadcast: no /send call, no --send flag.
//  4. The run-name tags preview runs "(preview)" and the decide step looks for
//     that tag, otherwise the cron fallback cannot see that a preview went out
//     and the owner gets a duplicate every Sunday.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = '.github/workflows/newsletter-draft-refresh.yml';
const wf = fs.readFileSync(path.join(repo, WF), 'utf8');

// Slice one step (from its "- name:" line to the next step or EOF).
function stepBlock(nameFragment) {
  const lines = wf.split('\n');
  const start = lines.findIndex((l) => /^\s{6}- name:/.test(l) && l.includes(nameFragment));
  assert.ok(start !== -1, `step containing "${nameFragment}" not found in ${WF}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{6}- name:/.test(lines[i])) { end = i; break; }
  }
  return { text: lines.slice(start, end).join('\n'), index: start };
}

test('sendPreview is a workflow_dispatch input and a STRING, never type: boolean', () => {
  assert.match(wf, /^\s{6}sendPreview:/m, `${WF} lost its sendPreview input`);
  const m = wf.match(/^\s{6}sendPreview:\n((?:\s{8}.*\n|\s*#.*\n|\n)*)/m);
  assert.ok(m, 'could not locate the sendPreview input block');
  assert.doesNotMatch(m[1], /type:\s*boolean/,
    "sendPreview must NOT be type: boolean: GitHub sends \"true\"/\"false\" and the gate tests === '1'");
});

test("the decide step gates on the exact string '1' for sendPreview", () => {
  const { text } = stepBlock('Decide whether to send owner preview');
  assert.match(text, /\[ "\$\{INPUT_SENDPREVIEW\}" = "1" \]/);
  assert.match(text, /github\.event\.inputs\.sendPreview/);
});

test('the decide step has a cron fallback keyed on the (preview) run-name tag', () => {
  const { text } = stepBlock('Decide whether to send owner preview');
  assert.match(text, /EVENT_NAME.*=.*"schedule"/);
  assert.match(text, /gh run list/);
  assert.match(text, /endswith\(\\"\(preview\)\\"\)/);
  assert.match(wf, /^run-name:.*\(preview\)/m,
    'run-name must tag preview runs "(preview)" or the cron fallback cannot see them');
});

test('preview step is the transactional owner send via send-test.mjs', () => {
  const { text } = stepBlock('Send [DRAFT] preview to owner');
  assert.match(text, /node scripts\/newsletter\/send-test\.mjs/);
  assert.match(text, /NEWSLETTER_TEST_RECIPIENT:\s*\$\{\{\s*secrets\.OWNER_EMAIL\s*\}\}/);
  assert.match(text, /NEWSLETTER_SLUG:\s*A-\$\{\{\s*steps\.week\.outputs\.weekStart\s*\}\}/);
  assert.match(text, /NEWSLETTER_SUBJECT_PREFIX:\s*'\[DRAFT\]/);
});

test('preview step is gated on draft status AND the decide step output', () => {
  const { text } = stepBlock('Send [DRAFT] preview to owner');
  assert.match(text, /if:.*steps\.status\.outputs\.status == 'draft'/);
  assert.match(text, /if:.*steps\.preview\.outputs\.send == '1'/);
  assert.match(text, /if:.*success\(\)/);
});

test('preview step runs AFTER the de-dup commit and PATCH, so it cannot skip the ledger', () => {
  const preview = stepBlock('Send [DRAFT] preview to owner').index;
  const commit = stepBlock('Commit newsletter de-dup state').index;
  const patch = stepBlock('PATCH Resend draft').index;
  const notify = stepBlock('Notify on failure').index;
  assert.ok(patch < commit && commit < preview && preview < notify,
    'order must be PATCH draft, commit de-dup state, send preview, notify on failure');
});

test('this workflow can never broadcast: no /send call, no send flag', () => {
  // Strip comment lines so prose like "never /send" does not trip the guard.
  const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /broadcasts\/[^\s"']*\/send/, 'no Resend /broadcasts/{id}/send call allowed');
  assert.doesNotMatch(code, /send-opening-night-broadcast/);
  assert.doesNotMatch(code, /--send(\s|=|$)/m, 'no --send flag allowed');
});
