// BRO-2440: opening-night-broadcast.yml's old `send_to_all` input never sent to
// anyone. It created a Resend draft for owner review, and the name misled two
// sessions into a handoff that guaranteed no draft. The input is now
// `create_draft`; `send_to_all` stays as a deprecated alias. This test keeps
// the descriptions honest and both names wired to the same decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const SRC = readFileSync(new URL('../../.github/workflows/opening-night-broadcast.yml', import.meta.url), 'utf8');
const wf = yaml.load(SRC);
const inputs = wf.on.workflow_dispatch.inputs;

test('create_draft is a boolean input that defaults off', () => {
  assert.ok(inputs.create_draft, 'create_draft input missing');
  assert.equal(inputs.create_draft.type, 'boolean');
  assert.equal(inputs.create_draft.default, false);
});

test('descriptions say plainly that nothing goes to subscribers', () => {
  assert.match(inputs.create_draft.description, /draft/i);
  assert.match(inputs.create_draft.description, /does not send to subscribers/i);
  assert.match(inputs.send_to_all.description, /deprecated/i);
  assert.match(inputs.send_to_all.description, /create_draft/);
  assert.match(inputs.send_to_all.description, /does not send to subscribers/i);
});

test('every send_to_all read is paired with create_draft, and vice versa, by OR', () => {
  const reads = (name) => SRC.split('\n').filter((l) => new RegExp(`\\$\\{\\{[^}]*inputs\\.${name}\\b`).test(l));
  const old = reads('send_to_all');
  const cur = reads('create_draft');
  assert.ok(old.length >= 1, `expected the explicit-draft read, found ${old.length}`);
  assert.deepEqual(cur, old, 'create_draft and send_to_all must be read on the same lines');
  // One GitHub expression `inputs.create_draft || inputs.send_to_all`. An && would
  // make the alias (or the new name) inert.
  for (const l of old) assert.match(l, /inputs\.create_draft \|\| inputs\.send_to_all/, `create_draft/send_to_all not joined by OR: ${l.trim()}`);
});

// BRO-6634 (owner 2026-10-30): no approval step. Every trigger except a send_to
// test creates the Resend draft; the owner reviews and sends it from Resend.
const broadcastStep = () => {
  const m = SRC.match(/\n      - name: Create broadcast draft[\s\S]*?\n      - name:/);
  assert.ok(m, 'broadcast step not found');
  return m[0];
};

test('every trigger except a send_to test creates the draft', () => {
  const step = broadcastStep();
  assert.match(step, /CREATE_DRAFT="true"\n/, 'CREATE_DRAFT must default to true');
  assert.equal(step.split('CREATE_DRAFT="false"').length - 1, 1, 'only the send_to branch may turn the draft off');
  assert.match(step, /if \[ -n "\$\{INPUT_SEND_TO\}" \]; then\n\s*CREATE_DRAFT="false"/);
  assert.doesNotMatch(step.replace(/no approval/gi, ''), /approval/i, 'no approval framing: the owner sends from Resend');
});

test('the draft and the preview never reach a broadcast send', () => {
  const step = broadcastStep();
  assert.doesNotMatch(step, /broadcasts\/[^\s]*\/send|--send-to-all/);
  for (const l of step.split('\n').filter((x) => x.includes('send-opening-night-broadcast.js'))) {
    // The draft call carries no --send-to; the preview call carries only a --send-to.
    if (l.includes('DRAFT_FLAGS')) assert.doesNotMatch(l, /PREVIEW_FLAG|OWNER_FLAG|--send-to/, `draft call with a send flag: ${l.trim()}`);
    else assert.match(l, /\$PREVIEW_FLAG/, `preview call without a --send-to: ${l.trim()}`);
  }
});

test('past-deadline shows get --force-create-draft, on the draft call only', () => {
  const rule = SRC.match(/if \[ "\$CREATE_DRAFT" = "true" \] && \[ -n "\$\{\{ steps\.check\.outputs\.deadline_shows \}\}" \]; then\n\s*DRAFT_FLAGS="--force-create-draft"/);
  assert.ok(rule, 'force rule not found');
  assert.ok(SRC.indexOf(rule[0]) > SRC.indexOf('** DRAFT MODE'), 'force rule must follow the mode branch');
  assert.equal(SRC.split('DRAFT_FLAGS="--force-create-draft"').length - 1, 1, 'exactly one place may set the force flag');
});

test('a number change updates the unsent draft in place and the reminder step exists', () => {
  assert.match(SRC, /id: update_drafts[\s\S]*?--update-unsent-draft/);
  assert.match(SRC, /node scripts\/remind-unsent-broadcast-draft\.js/);
  const update = SRC.indexOf('id: update_drafts');
  const remind = SRC.indexOf('remind-unsent-broadcast-draft.js');
  const commit = SRC.indexOf('- name: Commit data');
  assert.ok(update !== -1 && remind > update && (commit === -1 || commit > remind), 'reminder must run after the update step and before Commit data');
});
