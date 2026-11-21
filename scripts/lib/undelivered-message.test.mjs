import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { undeliveredTargets, undeliveredDecision } = require('./undelivered-message.js');
const { deadWaitDecision } = require('./child-session-wait-guard.js');

const send = (idx, ok, extra = {}) => ({ idx, name: 'mcp__claude-code-remote__send_message', input: { session_id: 'session_X', message: 'hi' }, ok, ...extra });
const KEEP = 'Still running: nothing.\nKEEP OPEN — waiting on the reply from the peer.';

test('a denied send followed by KEEP OPEN on the reply is blocked', () => {
  assert.equal(undeliveredDecision({ closing: KEEP, tools: [send(1, false)] }).block, true);
});
test('an errored result string (session_inactive) counts as undelivered', () => {
  assert.deepEqual(undeliveredTargets([send(1, true, { result: '{"error":"session_inactive"}' })]), ['session_X']);
});
test('a delivery receipt that mentions failed checks is not a failure', () => {
  assert.deepEqual(undeliveredTargets([send(1, true, { result: '{"status":"delivered","note":"0 failed checks"}' })]), []);
  assert.deepEqual(undeliveredTargets([send(1, true, { result: 'Message sent' })]), []);
});
test('a later successful send to the same target clears it', () => {
  assert.equal(undeliveredDecision({ closing: KEEP, tools: [send(1, false), send(2, true, { result: '{"status":"delivered"}' })] }).block, false);
});
test('SAFE TO ARCHIVE after a failed send is allowed', () => {
  assert.equal(undeliveredDecision({ closing: 'Could not reach that session.\nSAFE TO ARCHIVE — done', tools: [send(1, false)] }).block, false);
});
test('a live wake lets KEEP OPEN stand', () => {
  assert.equal(undeliveredDecision({ closing: KEEP, tools: [send(1, false)], liveWake: true }).block, false);
});
test('KEEP OPEN on something else (a landing) is not this gate', () => {
  assert.equal(undeliveredDecision({ closing: 'KEEP OPEN — the landing run finishes', tools: [send(1, false)] }).block, false);
});
test('wired into DEADWAIT: the real decision blocks with the undelivered target', () => {
  const r = deadWaitDecision({ closing: KEEP, tools: [send(1, false)], done: [], now: Date.now() });
  assert.equal(r.block, true);
  assert.match(r.target, /undelivered/);
});

// ─── End to end: the real hook on a transcript with a denied send_message ───
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
const HOOK = path.join(path.resolve(new URL('.', import.meta.url).pathname, '..', '..'), '.claude', 'hooks', 'verify-edits.sh');
const NOW = Date.now();
const ts = (m) => new Date(NOW - m * 60000).toISOString();
const user = (c) => ({ type: 'user', timestamp: ts(30), message: { role: 'user', content: c } });
const use = (id, name, input, m) => ({ type: 'assistant', timestamp: ts(m), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, text, m, isError) => ({ type: 'user', timestamp: ts(m), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
const CLOSING = 'I sent the question to the peer session.\n\nStill running: nothing.\nYou need to: Nothing needed from you.\n\nKEEP OPEN — waiting on the reply from the peer.';
function runHook(lines, lastMsg = CLOSING) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undelivered-'));
  const tp = path.join(dir, 't.jsonl');
  fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = spawnSyncStdinFile('bash', [HOOK], {
    input: JSON.stringify({ transcript_path: tp, session_id: 'undelivered-test', stop_hook_active: false, last_assistant_message: lastMsg }),
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
    env: { ...process.env, HOME: dir, CLAUDE_CODE_REMOTE: 'true', BOARD_GATE_DISABLED: '1', SHIP_CHECK_COVERAGE_DISABLE: '1', DEADWAIT_GATE_MODE: 'block' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr || '' };
}
test('e2e: the real hook blocks KEEP OPEN after a denied send_message', () => {
  const r = runHook([user('do the task'),
    use('t1', 'mcp__claude-code-remote__send_message', { session_id: 'session_X', message: 'question?' }, 5),
    res('t1', 'Permission denied: needs approval', 5, true)]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /could not reach that session/);
});
