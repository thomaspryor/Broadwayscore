/**
 * dispatcher-wake.test.mjs — BRO-8079 acceptance: a job-stranded (or failed/blocked/parked) row
 * produces a wake for the session that dispatched it, and only while the task has not moved on.
 * Fixture rows copy the real ledger shapes (BRO-8065 job-stranded 2026-11-22T21:54Z, BRO-8017
 * job-blocked then watchdog-park, BRO-7145 job-failed stage=timeout).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wake = require('./dispatcher-wake.js');
const { deliverDispatcherWakes } = require('../dispatch-watchdog.js');

const BY = { sessionId: '12bb3cbc-0000-4000-8000-000000000000', workspaceId: 'AAAA-1111' };
const NOW = Date.parse('2026-11-22T22:30:00Z');
const launch = (taskId, ts, extra = {}) => ({ ts, event: 'launch', taskId, subject: `${taskId.replace('linear:', '')} Settle 2025-26 stubs`, workspaceRef: `headless:${taskId}`, dispatchedBy: BY, ...extra });
const stranded = { ts: '2026-11-22T21:54:38.195Z', event: 'job-stranded', taskId: 'linear:BRO-8065', jobId: 'linear:BRO-8065-mws9qg5d', sha: 'd48e51d594d4b656aad548febf99acf4a3ff0e5b', dirty: true };

test('BRO-8079: a job-stranded row produces a wake for the dispatching session', () => {
  const wakes = wake.planDispatcherWakes([launch('linear:BRO-8065', '2026-11-22T19:00:00Z'), stranded], { nowMs: NOW });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].workspaceId, BY.workspaceId);
  assert.equal(wakes[0].sessionId, BY.sessionId);
  assert.equal(wakes[0].event, 'job-stranded');
  assert.match(wakes[0].message, /^\[automated dispatch-watchdog notice, not owner input\]/);
  assert.match(wakes[0].message, /BRO-8065/);
  assert.match(wakes[0].message, /d48e51d594d/);
  assert.doesNotMatch(wakes[0].message, /\n/);
});

test('BRO-8079: no wake when the task moved on, the launch has no dispatcher, or the row is too fresh/old', () => {
  const l = launch('linear:BRO-8065', '2026-11-22T19:00:00Z');
  for (const later of ['launch', 'job-spawned', 'job-retried', 'job-done', 'landed-acked', 'landed-outside-dispatch']) {
    const rows = [l, stranded, { ts: '2026-11-22T22:00:00Z', event: later, taskId: 'linear:BRO-8065' }];
    assert.equal(wake.planDispatcherWakes(rows, { nowMs: NOW }).length, 0, later);
  }
  const { dispatchedBy, ...unstamped } = l; // eslint-disable-line no-unused-vars
  assert.equal(wake.planDispatcherWakes([unstamped, stranded], { nowMs: NOW }).length, 0);
  // Newest launch only: a watchdog redispatch (no stamp) after an old stamped launch wakes nobody.
  assert.equal(wake.planDispatcherWakes([l, { ...unstamped, ts: '2026-11-22T20:00:00Z' }, stranded], { nowMs: NOW }).length, 0);
  assert.equal(wake.planDispatcherWakes([l, stranded], { nowMs: Date.parse(stranded.ts) + 60_000 }).length, 0, 'under 10 min');
  assert.equal(wake.planDispatcherWakes([l, stranded], { nowMs: Date.parse(stranded.ts) + 25 * 3600_000 }).length, 0, 'over 24h');
});

test('BRO-8079: blocked-then-parked on one launch is ONE wake (newest row), failed/stopped-short also wake', () => {
  const rows = [
    launch('linear:BRO-8017', '2026-11-22T13:00:00Z'),
    { ts: '2026-11-22T14:09:47.636Z', event: 'job-blocked', taskId: 'linear:BRO-8017', reason: 'the land run for branch job/linear-BRO-8017 failed on main-wide tests' },
    { ts: '2026-11-22T14:11:24.820Z', event: 'watchdog-park', taskId: 'linear:BRO-8017', reason: 'headless job blocked' },
    launch('linear:BRO-7145', '2026-11-22T00:00:00Z'),
    { ts: '2026-11-22T02:07:19.611Z', event: 'job-failed', taskId: 'linear:BRO-7145', stage: 'timeout', detail: 'killed at 7200000ms' },
  ];
  const wakes = wake.planDispatcherWakes(rows, { nowMs: Date.parse('2026-11-22T15:00:00Z') });
  assert.deepEqual(wakes.map((w) => [w.taskId, w.event]), [['linear:BRO-8017', 'watchdog-park'], ['linear:BRO-7145', 'job-failed']]);
  assert.match(wakes[1].message, /stage timeout/);
});

test('BRO-8079: dispatchedByFromEnv stamps only an interactive cmux Claude session', () => {
  assert.deepEqual(wake.dispatchedByFromEnv({ CLAUDE_CODE_SESSION_ID: 's', CMUX_WORKSPACE_ID: 'w' }), { sessionId: 's', workspaceId: 'w' });
  assert.equal(wake.dispatchedByFromEnv({ CLAUDE_CODE_SESSION_ID: 's', CMUX_WORKSPACE_ID: 'w', ESG_HEADLESS: '1' }), null);
  assert.equal(wake.dispatchedByFromEnv({ CMUX_WORKSPACE_ID: 'w' }), null, 'watchdog tab: no Claude session');
  assert.equal(wake.dispatchedByFromEnv({ CLAUDE_CODE_SESSION_ID: 's' }), null, 'headless job: CMUX_WORKSPACE_ID stripped');
  assert.deepEqual(wake.dispatchedByField({}), {});
});

// ── delivery through the real deliverDispatcherWakes with cmux stubbed ──
// Real `cmux top --processes --format tsv` shape (cmux-workspaces.test.mjs fixture).
const PROC = '5.8\t432324608\t1\tprocess\t22146\tworkspace:366F394E:tag:claude_code\t2.1.207';
const IDLE_TSV = `5.8\t527663104\t7\ttag\tworkspace:366F394E:tag:claude_code\tworkspace:41\t\n${PROC}`;
const BUSY_TSV = `5.8\t527663104\t7\ttag\tworkspace:366F394E:tag:claude_code\tworkspace:41\tRunning\n${PROC}`;

function harness({ tsv = IDLE_TSV, live = [{ ref: 'workspace:41', id: BY.workspaceId, title: 'BRO-7930 drain' }], sendThrows = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-wake-'));
  const sent = [];
  const deps = {
    env: {}, nowMs: NOW, statePath: path.join(dir, 'state.jsonl'), offFile: path.join(dir, 'off'),
    readLedger: () => [launch('linear:BRO-8065', '2026-11-22T19:00:00Z'), stranded],
    listWorkspaces: () => live, top: () => tsv, log: () => {},
    send: (ref, text, title) => { if (sendThrows) throw new Error('socket busy'); sent.push({ ref, text, title }); },
  };
  return { dir, sent, deps, state: () => { try { return fs.readFileSync(deps.statePath, 'utf8'); } catch { return ''; } } };
}

test('BRO-8079: deliverDispatcherWakes types the wake into the dispatching tab once, then never again', () => {
  const h = harness();
  try {
    assert.equal(deliverDispatcherWakes(h.deps).length, 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].ref, 'workspace:41');
    assert.equal(h.sent[0].title, 'BRO-7930 drain');
    assert.match(h.sent[0].text, /job-stranded/);
    assert.equal(deliverDispatcherWakes(h.deps).length, 0, 'second tick: already sent');
    assert.equal(h.sent.length, 1);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('BRO-8079: mid-turn waits, closed tab gives up, watchdog tab is never typed into, send errors retry to a cap', () => {
  const busy = harness({ tsv: BUSY_TSV });
  try { assert.equal(deliverDispatcherWakes(busy.deps).length, 0); assert.equal(busy.state(), '', 'mid-turn: no attempt burned'); } finally { fs.rmSync(busy.dir, { recursive: true, force: true }); }

  const closed = harness({ live: [{ ref: 'workspace:2', id: 'other', title: 'x' }] });
  try {
    for (let i = 0; i < 5; i++) deliverDispatcherWakes(closed.deps);
    assert.equal((closed.state().match(/"attempt"/g) || []).length, wake.MAX_ATTEMPTS, 'a missing tab burns retries, never gives up on one listing');
    assert.equal(closed.sent.length, 0);
  } finally { fs.rmSync(closed.dir, { recursive: true, force: true }); }

  const done = harness({ live: [{ ref: 'workspace:41', id: BY.workspaceId, title: '✅ BRO-7930 drain' }] });
  try { deliverDispatcherWakes(done.deps); assert.equal(done.sent.length, 0); } finally { fs.rmSync(done.dir, { recursive: true, force: true }); }

  const crown = harness({ live: [{ ref: 'workspace:1', id: BY.workspaceId, title: '👑 OWNER watchdog — 3 in flight' }] });
  try { deliverDispatcherWakes(crown.deps); assert.equal(crown.sent.length, 0); } finally { fs.rmSync(crown.dir, { recursive: true, force: true }); }

  const flaky = harness({ sendThrows: true });
  try {
    for (let i = 0; i < 5; i++) deliverDispatcherWakes(flaky.deps);
    assert.equal((flaky.state().match(/"attempt"/g) || []).length, wake.MAX_ATTEMPTS);
    assert.doesNotMatch(flaky.state(), /"sent"/);
  } finally { fs.rmSync(flaky.dir, { recursive: true, force: true }); }

  const off = harness();
  try { off.deps.env = { DISPATCHER_WAKE_DISABLED: '1' }; deliverDispatcherWakes(off.deps); assert.equal(off.sent.length, 0); } finally { fs.rmSync(off.dir, { recursive: true, force: true }); }
});

test('BRO-8079 ship-check: the notice names the dispatching session so another conversation in the tab can ignore it', () => {
  const [w] = wake.planDispatcherWakes([launch('linear:BRO-8065', '2026-11-22T19:00:00Z'), stranded], { nowMs: NOW });
  assert.match(w.message, /CLAUDE_CODE_SESSION_ID does not start with 12bb3cbc/);
});

test('BRO-8079 ship-check: orphaned, disk-pressure abandoned and tab-lane dead rows wake; a lease-held racing launch does not hide a live job failure', () => {
  const l = launch('linear:BRO-1', '2026-11-22T19:00:00Z');
  for (const bad of [{ event: 'job-orphaned' }, { event: 'job-abandoned', reason: 'disk-pressure: disk free 3.1GB' }, { event: 'dead' }, { event: 'vanished' }]) {
    assert.equal(wake.planDispatcherWakes([l, { ts: '2026-11-22T21:00:00Z', taskId: 'linear:BRO-1', ...bad }], { nowMs: NOW }).length, 1, bad.event);
  }
  assert.equal(wake.planDispatcherWakes([l, { ts: '2026-11-22T21:00:00Z', taskId: 'linear:BRO-1', event: 'job-abandoned', reason: 'task already has a live job' }], { nowMs: NOW }).length, 0);
  const { dispatchedBy, ...unstamped } = l; // eslint-disable-line no-unused-vars
  const raced = [
    l, { ts: '2026-11-22T19:00:05Z', event: 'job-spawned', taskId: 'linear:BRO-1' },
    { ...unstamped, ts: '2026-11-22T20:00:00Z' }, { ts: '2026-11-22T20:00:01Z', event: 'job-abandoned', taskId: 'linear:BRO-1', reason: 'task already has a live job' },
    { ts: '2026-11-22T21:00:00Z', event: 'job-stranded', taskId: 'linear:BRO-1' },
  ];
  const wakes = wake.planDispatcherWakes(raced, { nowMs: NOW });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].workspaceId, BY.workspaceId);
});

test('BRO-8079 ship-check: deliveries are capped, not candidates, so busy tabs cannot starve older wakes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-wake-cap-'));
  try {
    const rows = [];
    for (let i = 0; i < 8; i++) {
      rows.push({ ...launch(`linear:BRO-${i}`, '2026-11-22T19:00:00Z'), dispatchedBy: { sessionId: 's', workspaceId: `W${i}` } });
      rows.push({ ts: `2026-11-22T21:0${i}:00Z`, event: 'job-failed', taskId: `linear:BRO-${i}` });
    }
    const live = rows.filter((r) => r.event === 'launch').map((r, i) => ({ ref: `workspace:${i + 10}`, id: r.dispatchedBy.workspaceId, title: `t${i}` }));
    const busy = new Set(['workspace:17', 'workspace:16', 'workspace:15', 'workspace:14', 'workspace:13']); // the 5 newest
    const sent = [];
    deliverDispatcherWakes({
      env: {}, nowMs: NOW, statePath: path.join(dir, 's.jsonl'), offFile: path.join(dir, 'off'), readLedger: () => rows,
      listWorkspaces: () => live, top: (ref) => (busy.has(ref) ? BUSY_TSV : IDLE_TSV), log: () => {},
      send: (ref) => sent.push(ref),
    });
    assert.deepEqual(sent.sort(), ['workspace:10', 'workspace:11', 'workspace:12']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BRO-8171: memory-pressure abandoned rows wake like disk-pressure (job never ran)', () => {
  const l = launch('linear:BRO-1', '2026-11-22T19:00:00Z');
  const row = { ts: '2026-11-22T21:00:00Z', taskId: 'linear:BRO-1', event: 'job-abandoned', reason: 'memory-pressure: free 0.4GB < floor' };
  assert.equal(wake.planDispatcherWakes([l, row], { nowMs: NOW }).length, 1);
});
