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
  assert.ok(old.length >= 2, `expected the dedup-skip and draft-mode reads, found ${old.length}`);
  assert.deepEqual(cur, old, 'create_draft and send_to_all must be read on the same lines');
  // Either one GitHub expression `inputs.create_draft || inputs.send_to_all`, or two
  // bash tests joined by `] || [`. An && would make the alias (or the new name) inert.
  const joined = /inputs\.create_draft \|\| inputs\.send_to_all|inputs\.create_draft \}\}" = "true" \] \|\| \[ "\$\{\{ inputs\.send_to_all/;
  for (const l of old) assert.match(l, joined, `create_draft/send_to_all not joined by OR: ${l.trim()}`);
});

test('a default dispatch creates no draft outside deadline mode (workflow_run / update-show-status rely on it)', () => {
  // The draft branch must be gated on an input or the 12:30 cron, never unconditional.
  const m = SRC.match(/elif \[ "\$\{\{ inputs\.create_draft \}\}" = "true" \][^\n]*\n[\s\S]*?CREATE_DRAFT="true"/);
  assert.ok(m, 'draft branch not found');
  // The initialiser is false, and the final else (preview mode) never flips it.
  const init = SRC.indexOf('CREATE_DRAFT="false"');
  assert.ok(init !== -1 && init < SRC.indexOf(m[0]), 'CREATE_DRAFT must start false before the branches');
  const elseIdx = SRC.indexOf('\n          else\n', SRC.indexOf(m[0]));
  const fiIdx = SRC.indexOf('\n          fi\n', elseIdx);
  assert.ok(elseIdx !== -1 && fiIdx > elseIdx, 'final else branch not found');
  const elseBranch = SRC.slice(elseIdx, fiIdx);
  assert.match(elseBranch, /PREVIEW MODE/);
  assert.doesNotMatch(elseBranch, /CREATE_DRAFT="true"/);
});

test('past-deadline shows get --force-create-draft in every draft mode, approval included', () => {
  // BRO-5261 retro-review: the approval branch (create_draft / 12:30 cron) runs before
  // the deadline branch, so the force flag set only inside the deadline branch was
  // skipped there. One rule after the mode chain now covers both.
  const rule = SRC.match(/if \[ "\$CREATE_DRAFT" = "true" \] && \[ -n "\$\{\{ steps\.check\.outputs\.deadline_shows \}\}" \]; then\n\s*DRAFT_FLAGS="--force-create-draft"/);
  assert.ok(rule, 'post-chain force rule not found');
  const chainEnd = SRC.indexOf('** PREVIEW MODE — sending preview to owner for approval **');
  assert.ok(chainEnd !== -1 && SRC.indexOf(rule[0]) > chainEnd, 'force rule must follow the whole mode chain');
  assert.equal(SRC.split('DRAFT_FLAGS="--force-create-draft"').length - 1, 1, 'exactly one place may set the force flag');
  // The flag only ever reaches the draft call, never the preview send.
  for (const l of SRC.split('\n').filter((x) => x.includes('send-opening-night-broadcast.js'))) {
    if (l.includes('DRAFT_FLAGS')) assert.doesNotMatch(l, /SEND_TO_FLAG/, `force flag on a preview call: ${l.trim()}`);
  }
});
