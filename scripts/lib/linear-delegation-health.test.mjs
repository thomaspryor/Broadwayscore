import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessDelegations } = require('./linear-delegation-health.js');

const NOW = Date.parse('2026-08-17T02:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

const boilerplate = (min) => [
  { createdAt: ago(min), body: "I've received your request and I'm starting to work on it. Let me analyze the issue and prepare my approach." },
  { createdAt: ago(min), body: '**Routing**\n- **Broadwayscore** → `main` (default)' },
  { createdAt: ago(min), body: 'Using model: claude-opus-4-8' },
];

const issue = (identifier, sessions, delegateName = 'cyrus') => ({ identifier, delegateName, sessions });

test('the 2026-08-16 failure is caught: delegated, active, boilerplate only', () => {
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(30), status: 'active', activities: boilerplate(30) }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'stalled');
  assert.match(r.alarm, /not running/);
  assert.match(r.alarm, /BRO-374/);
});

test('a blocked-notice session is not counted as working', () => {
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(20), status: 'active',
      activities: [{ createdAt: ago(20), body: 'Blocked by **BRO-379** — will start automatically when they are resolved.' }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'blocked');
  assert.match(r.alarm, /will not start/);
});

test('recent real work is recognised and raises no alarm', () => {
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(10), status: 'active',
      activities: [...boilerplate(10), { createdAt: ago(2), body: "I'll start by exploring the existing code structure." }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'working');
  assert.equal(r.alarm, null);
});

// --- review finding 1: empty-body activities are not work ---
test('an agent that errored and died is NOT working (empty-body activity)', () => {
  // AgentActivityErrorContent has no `body` in the query, so it arrived as ''.
  // The first version scored that as substantive and reported healthy.
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(60), status: 'active',
      activities: [...boilerplate(60), { createdAt: ago(59), typename: 'AgentActivityErrorContent', body: '' }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'stalled');
  assert.match(r.alarm, /BRO-374/);
});

test('whitespace-only bodies are not work either', () => {
  const r = assessDelegations(
    [issue('BRO-9', [{ createdAt: ago(60), status: 'active',
      activities: [...boilerplate(60), { createdAt: ago(59), body: '   \n  ' }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'stalled');
});

// --- review finding 2: "working" must expire ---
test('one real thought hours ago is stalled, not working forever', () => {
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(360), status: 'active',
      activities: [...boilerplate(360), { createdAt: ago(355), body: 'Exploring the code structure.' }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'stalled');
  assert.match(r.verdicts[0].detail, /started work then stopped/);
});

test('a session Linear itself marked stale is not working, however much it did', () => {
  const r = assessDelegations(
    [issue('BRO-381', [{ createdAt: ago(3), status: 'stale',
      activities: [...boilerplate(3), { createdAt: ago(1), body: 'Enumerating dispatcher safety behaviours.' }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'stalled');
  assert.match(r.verdicts[0].detail, /Linear marked the session dead/);
});

// --- review finding 9: duplicate concurrent sessions ---
test('a dead twin created 400ms later does not mask a working session', () => {
  // Observed live: BRO-379 sessions at 14:16:38.811 and .178.
  const base = Date.parse(ago(4));
  const r = assessDelegations([issue('BRO-379', [
    { createdAt: new Date(base).toISOString(), status: 'active',
      activities: [...boilerplate(4), { createdAt: ago(1), body: 'Writing the client module.' }] },
    { createdAt: new Date(base + 400).toISOString(), status: 'active', activities: boilerplate(4) },
  ])], NOW);
  assert.equal(r.verdicts[0].verdict, 'working');
  assert.equal(r.alarm, null);
});

// --- review finding 10: malformed createdAt must not buy immunity ---
test('a session with an unparseable createdAt is stalled, not permanently starting', () => {
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: null, status: 'active', activities: boilerplate(1) }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'stalled');
  assert.doesNotMatch(r.verdicts[0].detail, /NaN/);
});

// --- review finding 8: blocked must not vanish behind stalled ---
test('stalled and blocked are BOTH reported in the same alarm', () => {
  const r = assessDelegations([
    issue('BRO-1', [{ createdAt: ago(30), status: 'active', activities: boilerplate(30) }]),
    issue('BRO-2', [{ createdAt: ago(30), status: 'active',
      activities: [{ createdAt: ago(30), body: 'Blocked by **BRO-1**' }] }]),
  ], NOW);
  assert.match(r.alarm, /BRO-1/);
  assert.match(r.alarm, /BRO-2/);
});

test('the alarm tells the owner what to do about it', () => {
  const r = assessDelegations(
    [issue('BRO-1', [{ createdAt: ago(30), status: 'active', activities: boilerplate(30) }])], NOW);
  assert.match(r.alarm, /Reply in the issue thread/);
});

// --- false positive found in production within minutes of shipping ---
test('an agent that FINISHED is not stalled', () => {
  // BRO-374 completed its task and opened PR #596; the alarm still said
  // "started work then stopped". A false alarm on successful work teaches the
  // owner to ignore the real ones.
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(90), status: 'complete',
      activities: [...boilerplate(90), { createdAt: ago(85), body: 'Writing the client module.' }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'finished');
  assert.equal(r.alarm, null);
});

test('completing WITHOUT producing work is stalled, not finished', () => {
  // The 2026-08-16 failure wearing a green hat: accept the issue, emit the
  // three boilerplate lines, terminate. A `complete` status must not silence it.
  const r = assessDelegations(
    [issue('BRO-338', [{ createdAt: ago(120), status: 'complete', activities: boilerplate(120) }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'stalled');
  assert.match(r.verdicts[0].detail, /completed without producing any work/);
  assert.match(r.alarm, /BRO-338/);
});

test('a blocked agent that ended its turn is still blocked, not finished', () => {
  // The agent posts "Blocked by …", ends its turn, Linear marks it complete.
  // Ordering `finished` first made a permanently parked delegation read as done.
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(40), status: 'complete',
      activities: [{ createdAt: ago(40), body: 'Blocked by **BRO-379** — will start automatically when they are resolved.' }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'blocked');
  assert.match(r.alarm, /will not start/);
});

test('a completed twin cannot mask a still-active sibling', () => {
  const base = Date.parse(ago(50));
  const r = assessDelegations([issue('BRO-379', [
    { createdAt: new Date(base).toISOString(), status: 'complete',
      activities: [...boilerplate(50), { createdAt: ago(50), body: 'Did a thing.' }] },
    { createdAt: new Date(base + 400).toISOString(), status: 'active', activities: boilerplate(50) },
  ])], NOW);
  assert.notEqual(r.verdicts[0].verdict, 'finished');
  assert.match(r.alarm, /BRO-379/);
});

test('an undateable completed session does not grant permanent immunity', () => {
  // A stale session with a malformed createdAt stays in every future attempt;
  // it must not be allowed to contribute the favourable signal.
  const r = assessDelegations([issue('BRO-374', [
    { createdAt: null, status: 'complete', activities: [{ createdAt: ago(9000), body: 'Old work.' }] },
    { createdAt: ago(60), status: 'active', activities: boilerplate(60) },
  ])], NOW);
  assert.notEqual(r.verdicts[0].verdict, 'finished');
  assert.match(r.alarm, /BRO-374/);
});

test('a freshly started session is given grace, not alarmed on', () => {
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(1), status: 'active', activities: boilerplate(1) }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'starting');
  assert.equal(r.alarm, null);
});

test('delegated with no session at all is never-started', () => {
  const r = assessDelegations([issue('BRO-374', [])], NOW);
  assert.equal(r.verdicts[0].verdict, 'never-started');
  assert.match(r.alarm, /not running/);
});

test('undelegated issues are ignored entirely', () => {
  const r = assessDelegations([{ identifier: 'BRO-999', delegateName: null, sessions: [] }], NOW);
  assert.equal(r.verdicts.length, 0);
  assert.equal(r.alarm, null);
});
