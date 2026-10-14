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

const SRC = readFileSync('.github/workflows/opening-night-broadcast.yml', 'utf8');
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

test('every send_to_all read is paired with create_draft', () => {
  const lines = SRC.split('\n').filter((l) => /\$\{\{[^}]*inputs\.send_to_all/.test(l));
  assert.ok(lines.length >= 2, `expected the dedup-skip and draft-mode reads, found ${lines.length}`);
  for (const l of lines) assert.match(l, /inputs\.create_draft/, `unpaired send_to_all read: ${l.trim()}`);
});

test('a default dispatch still creates no draft (workflow_run / update-show-status rely on it)', () => {
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
