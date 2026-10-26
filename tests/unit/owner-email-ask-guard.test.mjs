import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { checkOwnerEmail } = require('../../scripts/lib/owner-email-ask-guard.js');
const OWNER = 'thomas.pryor@gmail.com';
const env = {};

const BLOCKED_SUBJECT = 'AdSense trial: GA4 shows ~80% bot traffic (one decision for you)';
const BLOCKED_BODY = "GA4 shows about 80% bot traffic.\n\nReply 'yes' to Claude or Codex and I will pause the trial.";

// Representative morning-digest preview: status only, no ask.
const DIGEST_BODY = [
  'Broadway Scorecard morning digest',
  'Opening tonight: 2 shows. Reviews collected overnight: 41 (3 new T1).',
  'CI: all green. Deploy: live. ScrapingBee credits: 412k remaining.',
  'Open cards waiting for an answer are listed on the board.',
].join('\n');

test('the email from this card is blocked', () => {
  const r = checkOwnerEmail({ to: [OWNER], subject: BLOCKED_SUBJECT, body: BLOCKED_BODY }, env);
  assert.equal(r.blocked, true);
  assert.match(r.reason, /DECISION NEEDED/);
  assert.match(r.reason, /one named session only/);
});

test('a real digest preview passes', () => {
  assert.equal(checkOwnerEmail({ to: [OWNER], subject: 'Morning digest (preview)', body: DIGEST_BODY }, env).blocked, false);
});

test('a body with no question passes', () => {
  assert.equal(checkOwnerEmail({ to: [OWNER], subject: 'Report', body: 'Shipped BRO-1. All checks passed.' }, env).blocked, false);
});

test('each ask phrase blocks', () => {
  for (const body of ['reply yes', 'Reply to Claude', 'a decision for you', 'one decision', 'tell Claude to go', 'waiting on you', "it's your call"]) {
    assert.equal(checkOwnerEmail({ to: [OWNER], subject: 's', body }, env).blocked, true, body);
  }
});

test('mail to someone else is never blocked', () => {
  assert.equal(checkOwnerEmail({ to: ['critic@example.com'], subject: 'x', body: 'Reply yes' }, env).blocked, false);
});

test('owner in cc/bcc or Name <addr> form is still the owner', () => {
  assert.equal(checkOwnerEmail({ to: ['a@b.com'], cc: [`Tom <${OWNER.toUpperCase()}>`], body: 'reply yes' }, env).blocked, true);
  assert.equal(checkOwnerEmail({ to: 'a@b.com', bcc: OWNER, body: 'reply yes' }, env).blocked, true);
});

test('OWNER_EMAIL env overrides the default', () => {
  assert.equal(checkOwnerEmail({ to: ['x@y.com'], body: 'reply yes' }, { OWNER_EMAIL: ' X@Y.com ' }).blocked, true);
});

test('bypass line allows, a mid-sentence mention does not', () => {
  assert.equal(checkOwnerEmail({ to: [OWNER], body: 'reply yes\nNO-OWNER-EMAIL-CHECK: test send' }, env).blocked, false);
  assert.equal(checkOwnerEmail({ to: [OWNER], body: 'reply yes, NO-OWNER-EMAIL-CHECK: x' }, env).blocked, true);
});

test('garbage input fails open', () => {
  for (const v of [null, undefined, 'str', 5, {}]) assert.equal(checkOwnerEmail(v, env).blocked, false);
});

test('hook script denies the blocked email and passes the digest', () => {
  const hook = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.claude/hooks/owner-email-ask-guard.sh');
  const run = (tool_input) => spawnSync('bash', [hook], { input: JSON.stringify({ tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input }), encoding: 'utf8' });
  const bad = run({ to: [OWNER], subject: BLOCKED_SUBJECT, body: BLOCKED_BODY });
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const ok = run({ to: [OWNER], subject: 'digest', body: DIGEST_BODY });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), '');
});
