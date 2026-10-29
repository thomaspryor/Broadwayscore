// BRO-6546: sessions told the owner to "reply APPROVED: <hash>" because CLAUDE.md §5 still described
// the retired hash handshake. The pre-push visual gate accepts a plain "yes / ship it" (see
// .claude/hooks/pre-push-visual-gate.sh block message), so no always-loaded rule may tell a session
// to ask for a hash. Reads the real rule files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const FILES = ['CLAUDE.md', '.claude/CLOUD.md', 'cloud-memory/feedback_local_preview_before_push.md'];
const BAD = [
  /without user `?APPROVED:/i,
  /wait for explicit `?APPROVED:/i,
  /reply `?APPROVED:/i,
  /(?:ask|tell|have) (?:the )?(?:user|owner)[^.\n]{0,40}(?:type|paste|send|reply)[^.\n]{0,30}APPROVED:/i,
];

test('no always-loaded rule tells sessions to ask the owner for an APPROVED: hash', () => {
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const re of BAD) assert.doesNotMatch(text, re, `${f} still instructs a hash handshake (${re})`);
  }
});

test('CLAUDE.md section 5 states the plain-affirmative rule and the cloud request flow', () => {
  const text = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(text, /plain "yes \/ ship it/);
  assert.match(text, /Never ask for a hash/);
  assert.match(text, /screenshots or an Artifact/);
  assert.match(text, /"Approved" IS the approval/);
  assert.match(text, /visual-approval\.js request/);
});
