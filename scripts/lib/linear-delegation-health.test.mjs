import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessDelegations } = require('./linear-delegation-health.js');

const NOW = Date.parse('2026-08-17T02:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

const BOILERPLATE = [
  { body: "I've received your request and I'm starting to work on it. Let me analyze the issue and prepare my approach." },
  { body: '**Routing**\n- **Broadwayscore** → `main` (default)' },
  { body: 'Using model: claude-opus-4-8' },
];

const issue = (identifier, sessions, delegateName = 'cyrus') => ({ identifier, delegateName, sessions });

test('the 2026-08-16 failure is caught: delegated, active, boilerplate only', () => {
  // Ten issues looked exactly like this on the board and produced nothing.
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(30), status: 'active', activities: BOILERPLATE }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'stalled');
  assert.match(r.alarm, /accepted work and produced nothing/);
  assert.match(r.alarm, /BRO-374/);
});

test('a blocked-notice session is not counted as working', () => {
  // BRO-374 sat like this for 20 minutes while being reported as running.
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(20), status: 'active',
      activities: [{ body: 'Blocked by **BRO-379**, **BRO-376** — will start automatically when they are resolved.' }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'blocked');
  assert.match(r.alarm, /will not start by themselves/);
});

test('real work is recognised and raises no alarm', () => {
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(10), status: 'active',
      activities: [...BOILERPLATE, { body: "I'll start by exploring the existing code structure." }] }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'working');
  assert.equal(r.alarm, null);
});

test('a freshly started session is given grace, not alarmed on', () => {
  const r = assessDelegations(
    [issue('BRO-374', [{ createdAt: ago(1), status: 'active', activities: BOILERPLATE }])], NOW);
  assert.equal(r.verdicts[0].verdict, 'starting');
  assert.equal(r.alarm, null);
});

test('delegated with no session at all is never-started', () => {
  const r = assessDelegations([issue('BRO-374', [])], NOW);
  assert.equal(r.verdicts[0].verdict, 'never-started');
  assert.match(r.alarm, /produced nothing/);
});

test('undelegated issues are ignored entirely', () => {
  // Most of the board is not delegated; it must not generate noise.
  const r = assessDelegations([{ identifier: 'BRO-999', delegateName: null, sessions: [] }], NOW);
  assert.equal(r.verdicts.length, 0);
  assert.equal(r.alarm, null);
});

test('the newest session decides, not a stale earlier one', () => {
  // BRO-374 really had a stale 00:51 session alongside a live 01:18 one.
  const r = assessDelegations([issue('BRO-374', [
    { createdAt: ago(90), status: 'stale', activities: BOILERPLATE },
    { createdAt: ago(5), status: 'active', activities: [...BOILERPLATE, { body: 'Writing the client module.' }] },
  ])], NOW);
  assert.equal(r.verdicts[0].verdict, 'working');
  assert.equal(r.alarm, null);
});

test('stalled outranks blocked in the alarm text', () => {
  const r = assessDelegations([
    issue('BRO-1', [{ createdAt: ago(30), status: 'active', activities: BOILERPLATE }]),
    issue('BRO-2', [{ createdAt: ago(30), status: 'active', activities: [{ body: 'Blocked by **BRO-1**' }] }]),
  ], NOW);
  assert.match(r.alarm, /BRO-1/);
  assert.match(r.alarm, /produced nothing/);
});
