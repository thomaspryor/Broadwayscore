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
  'Decisions waiting on you',
  'Why this is your call: the spend is not reversible.',
  'One decision is waiting on you. Please reply to this email if the link fails.',
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
  for (const body of ['reply yes', 'Reply to Claude', 'a decision for you', 'tell Claude to go', "Reply 'yes' to Claude or Codex"]) {
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

test('html-only ask and plus-addressed owner are caught', () => {
  assert.equal(checkOwnerEmail({ to: [OWNER], htmlBody: '<p>Please re<b>ply</b> <i>yes</i></p><p>Reply <b>yes</b> to Claude</p>' }, env).blocked, true);
  assert.equal(checkOwnerEmail({ to: ['thomas.pryor+bot@gmail.com'], body: 'reply yes' }, env).blocked, true);
});

test('[PREVIEW] and test subjects are exempt; dotted/googlemail owner forms are not', () => {
  assert.equal(checkOwnerEmail({ to: [OWNER], subject: '[PREVIEW] Think you know this Tony season', body: 'reply yes' }, env).blocked, false);
  assert.equal(checkOwnerEmail({ to: ['thomaspryor@googlemail.com'], body: 'reply yes' }, env).blocked, true);
  assert.equal(checkOwnerEmail({ to: ['Thomas.Pryor@gmail.com'], body: 'tell Claude' }, env).blocked, true);
});

test('create_gmail_draft and Gmail tool names are matched by the registered matcher', async () => {
  const fs = await import('node:fs');
  const s = JSON.parse(fs.readFileSync(new URL('../../.claude/settings.json', import.meta.url), 'utf8'));
  const e = s.hooks.PreToolUse.find((x) => x.hooks.some((h) => h.command.includes('owner-email-ask-guard.sh')));
  const re = new RegExp(`^(?:${e.matcher})$`);
  for (const n of ['send_message', 'create_draft', 'create_gmail_draft', 'update_draft', 'reply', 'forward']) assert.ok(re.test(`mcp__claude_ai_Gmail__${n}`), n);
  assert.ok(!re.test('mcp__claude_ai_Gmail__search_threads'));
});
