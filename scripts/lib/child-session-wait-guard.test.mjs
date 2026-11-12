import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { childWaitDecision, parentWatchDecision, firstWatchAdvisories, decideAll } = require('./child-session-wait-guard.js');
const { ccr: INIT_FAILED } = require('./fixtures/bro-7377-init-failed/get-session.json');

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

// Replay the real failed-init child's ID and creation time. Only the parent's
// watch duration and observation time vary; the fixture itself stays intact.
const createdAt = Date.parse(INIT_FAILED.created_at);
const freshParent = {
  closing: 'KEEP OPEN: waiting on the child session',
  liveChildren: [`session ${INIT_FAILED.id} "trial child"`],
  childCreatedAt: { [INIT_FAILED.id]: createdAt },
  now: createdAt + 3 * 60000,
};
const firstWatch = (flags = '--minutes 25', id = INIT_FAILED.id) => ({
  ...bash(2, `node scripts/lib/child-idle-watch.js watch --session ${id} ${flags}`, { run_in_background: true }),
  taskId: 'first-watch', startedAt: createdAt,
});

test('BRO-7378: 25-minute first watch advises three minutes; three-minute watch passes silently', () => {
  const slow = parentWatchDecision({ ...freshParent, tools: [firstWatch()] });
  assert.equal(slow.block, false, 'advisory only');
  assert.equal(slow.advisories?.length, 1);
  assert.match(slow.advisories[0], /--minutes 3\b/);
  assert.ok(slow.advisories[0].includes(INIT_FAILED.id));
  assert.equal(parentWatchDecision({ ...freshParent, tools: [firstWatch('--minutes 3')] }).advisories, undefined);
});

test('BRO-7378: pure first-watch check handles defaults, quotes, equals and the six-minute boundary', () => {
  for (const [flags, count] of [['', 1], ['--minutes=25', 1], ['--minutes "25"', 1],
    ["--minutes='3'", 0], ['--minutes 6', 0], ['--minutes 6.1', 1], ['--minutes invalid', 0]]) {
    const advisories = firstWatchAdvisories({ ids: [INIT_FAILED.id], childCreatedAt: freshParent.childCreatedAt,
      now: freshParent.now, watches: [firstWatch(flags, `"${INIT_FAILED.id}"`)] });
    assert.equal(advisories.length, count, flags);
  }
});

test('BRO-7378: only children known to be less than ten minutes old get an advisory', () => {
  for (const [age, count] of [[0, 1], [9.99, 1], [10, 0], [25, 0], [-1, 0]]) {
    const r = parentWatchDecision({ ...freshParent, now: createdAt + age * 60000, tools: [firstWatch()] });
    assert.equal(r.advisories?.length || 0, count, `age ${age}`);
  }
  for (const time of [undefined, null, 'unknown', NaN]) {
    const r = parentWatchDecision({ ...freshParent, childCreatedAt: { [INIT_FAILED.id]: time }, tools: [firstWatch()] });
    assert.equal(r.advisories, undefined, `creation time ${time}`);
  }
  assert.equal(parentWatchDecision({ ...freshParent, now: null, tools: [firstWatch()] }).advisories, undefined);
});

test('BRO-7378: only a live short watch for the same child suppresses the advisory', () => {
  const short = { ...firstWatch('--minutes 3'), taskId: 'short-watch' };
  const input = { ...freshParent, tools: [firstWatch(), short] };
  assert.equal(parentWatchDecision(input).advisories, undefined);
  assert.equal(parentWatchDecision({ ...input, done: ['short-watch'] }).advisories.length, 1);
  for (const extra of [
    { ...short, ok: false },
    { ...short, startedAt: createdAt - 3600000 },
    firstWatch('--minutes 3', INIT_FAILED.id + 'OTHER'),
    firstWatch('--minutes 3', 'session_01OTHERCHILDxxxx'),
    firstWatch('--minutes 25; echo --minutes 3'),
  ]) assert.equal(parentWatchDecision({ ...freshParent, tools: [firstWatch(), extra] }).advisories.length, 1);
  assert.equal(parentWatchDecision({ ...freshParent, tools: [firstWatch()], done: ['first-watch'] }).block, true);
});

test('BRO-7378: advisories reach the Stop decision and respect the existing CHILDWATCH scope and switch', () => {
  const input = { ...freshParent, tools: [firstWatch()] };
  const result = decideAll(input);
  assert.equal(result.block, false);
  assert.equal(result.code, null);
  assert.equal(result.advisories.length, 1);
  for (const extra of [{ skip: ['CHILDWATCH'] }, { keepOpen: false }, { liveChildren: [] },
    { closing: 'SAFE TO ARCHIVE: finished' }, { closing: 'KEEP OPEN: waiting on CI' }]) {
    assert.equal(decideAll({ ...input, ...extra }).advisories, undefined, JSON.stringify(extra));
  }
});
