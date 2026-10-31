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
    bash(9, 'gh workflow run we-historical-tr-probe.yml'),
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
test('report-back to @parent is NOT a wake (nobody wakes the child)', () => {
  const msg = { idx: 11, name: 'mcp__claude-code-remote__send_message', input: { session_id: '@parent', message: 'waiting' }, ok: true };
  assert.equal(childWaitDecision({ ...bro6154, tools: [...bro6154.tools, msg] }).block, true);
});
test('unrelated background command is not a wake', () => {
  assert.equal(childWaitDecision({ ...bro6154, tools: [...bro6154.tools, bash(10, 'sleep 5', { run_in_background: true })] }).block, true);
});
test('one background command that dispatches and polls passes', () => {
  const t = { ...bro6154, tools: [bash(9, 'gh workflow run we-historical-tr-probe.yml && gh run watch -i 60', { run_in_background: true })] };
  assert.equal(childWaitDecision(t).block, false);
});
test('gh run rerun / git -C push reset the baseline', () => {
  const old = bash(3, 'gh run view 1', { run_in_background: true });
  for (const cmd of ['gh run rerun 123', 'git -C /x push origin land/y']) {
    assert.equal(childWaitDecision({ ...bro6154, tools: [old, bash(9, cmd)] }).block, true, cmd);
  }
});
test('wording: awaiting / in flight block; finished or nothing running does not', () => {
  for (const c of ['KEEP OPEN — awaiting CI completion', 'KEEP OPEN — the workflow is in flight']) {
    assert.equal(childWaitDecision({ ...bro6154, closing: c }).block, true, c);
  }
  assert.equal(childWaitDecision({ ...bro6154, closing: 'Still running: nothing, the land run finished green.\nKEEP OPEN — the owner may reply' }).block, false);
  assert.equal(childWaitDecision({ ...bro6154, closing: 'No tests are running.\nKEEP OPEN — waiting on the parent' }).block, false);
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
