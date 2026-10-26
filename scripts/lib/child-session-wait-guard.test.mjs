import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { childWaitDecision } = createRequire(import.meta.url)('./child-session-wait-guard.js');

const CHILD_PROMPT = 'BRO-6154: fix probe\nclaim via linear-session.js\nBUDGET: 6h\n';
const BRO_6154_CLOSING = [
  'The probe workflow is running.',
  'Still running: the test run is in progress.',
  "KEEP OPEN — the test run is in progress; once it finishes I extend the fix...",
].join('\n');
const bash = (idx, command, extra = {}) => ({ idx, name: 'Bash', input: { command, ...extra }, ok: true });

// Real shape of the BRO-6154 turn: an earlier background poll (finished, no
// notice), then the session fires the workflow itself and ends its turn.
const bro6154 = {
  firstPrompt: CHILD_PROMPT,
  env: {},
  closing: BRO_6154_CLOSING,
  tools: [
    bash(3, 'node scripts/lib/wait-for-land.js land/x 60', { run_in_background: true }),
    bash(9, 'gh workflow run we-historical-tr-probe.yml -f show=x'),
  ],
};

test('replay of the BRO-6154 final turn is blocked', () => {
  assert.equal(childWaitDecision(bro6154).block, true);
});
test('background poll armed after the dispatch passes', () => {
  const t = { ...bro6154, tools: [...bro6154.tools, bash(10, 'gh run view 1 --json status', { run_in_background: true })] };
  assert.equal(childWaitDecision(t).block, false);
});
test('a finished poll (completion notice) does not count', () => {
  const poll = { ...bash(10, 'poll', { run_in_background: true }), taskId: 'abc' };
  const t = { ...bro6154, tools: [...bro6154.tools, poll], done: ['abc'] };
  assert.equal(childWaitDecision(t).block, true);
});
test('report-back to @parent after the dispatch passes', () => {
  const msg = { idx: 11, name: 'mcp__Claude_Code_Remote__send_message', input: { to: '@parent', message: 'waiting' }, ok: true };
  assert.equal(childWaitDecision({ ...bro6154, tools: [...bro6154.tools, msg] }).block, false);
});
test('human session is never blocked', () => {
  assert.equal(childWaitDecision({ ...bro6154, firstPrompt: 'fix the probe' }).block, false);
});
test('parent id in env marks a child', () => {
  assert.equal(childWaitDecision({ ...bro6154, firstPrompt: 'x', env: { CLAUDE_PARENT_SESSION_ID: 's' } }).block, true);
});
test('KEEP OPEN not about CI, or other verdicts, pass', () => {
  assert.equal(childWaitDecision({ ...bro6154, closing: 'KEEP OPEN — waiting on the owner reply' }).block, false);
  assert.equal(childWaitDecision({ ...bro6154, closing: 'SAFE TO ARCHIVE — done' }).block, false);
});
test('real send_message shape (session_id: "@parent") passes', () => {
  const msg = { idx: 11, name: 'mcp__claude-code-remote__send_message', input: { session_id: '@parent', message: 'waiting' }, ok: true };
  assert.equal(childWaitDecision({ ...bro6154, tools: [...bro6154.tools, msg] }).block, false);
});
