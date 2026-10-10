import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  appendEntry, readEntries, sumUSD, entriesForRun, entriesForLastSegment, lastRunId, statsByModel,
  spentTonight, usageStats, recoveryActions, acquireSingleton, releaseSingleton,
} = require('./autonomous-ledger.js');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ledger-'));
  return path.join(dir, name);
}

// ── Ledger append / read ────────────────────────────────────────────────────

test('appendEntry writes one JSON line and stamps ts', () => {
  const lp = tmpFile('ledger.jsonl');
  appendEntry({ event: 'run-start', runId: 'r1' }, lp);
  appendEntry({ event: 'card-pass', runId: 'r1', cardId: 'c1', usd: 0.42 }, lp);
  const { entries, corrupt } = readEntries(lp);
  assert.equal(corrupt, 0);
  assert.equal(entries.length, 2);
  assert.ok(entries[0].ts, 'ts stamped');
  assert.equal(entries[1].usd, 0.42);
});

test('appendEntry refuses an entry without an event', () => {
  assert.throws(() => appendEntry({ runId: 'r1' }, tmpFile('l.jsonl')), /event/);
});

test('readEntries survives a corrupt (partial-write) line', () => {
  const lp = tmpFile('ledger.jsonl');
  appendEntry({ event: 'run-start', runId: 'r1', usd: 1 }, lp);
  fs.appendFileSync(lp, '{"event":"card-pa'); // crash mid-write, no newline
  fs.appendFileSync(lp, '\n');
  appendEntry({ event: 'card-pass', runId: 'r1', usd: 2 }, lp);
  const { entries, corrupt } = readEntries(lp);
  assert.equal(corrupt, 1);
  assert.equal(entries.length, 2);
  assert.equal(sumUSD(entries), 3);
});

test('readEntries on a missing file is empty, not fatal', () => {
  const { entries, corrupt } = readEntries('/nonexistent/ledger.jsonl');
  assert.deepEqual(entries, []);
  assert.equal(corrupt, 0);
});

// ── Spend math from fixture lines (VERIFY line) ─────────────────────────────

// Real shape: spend (usd) lives on per-attempt `implement` lines; terminal
// card-pass/card-fail lines carry `totalUSD` which aggregations must NOT
// re-count (the email's per-item cost tag reads it).
const FIXTURE = [
  { ts: '2026-07-10T07:30:00Z', event: 'run-start', runId: 'r1' },
  { ts: '2026-07-10T07:40:00Z', event: 'implement', runId: 'r1', cardId: 'a', model: 'claude-sonnet-5', tokensIn: 10000, tokensOut: 2000, usd: 0.8 },
  { ts: '2026-07-10T07:41:00Z', event: 'card-pass', runId: 'r1', cardId: 'a', totalUSD: 0.8 },
  { ts: '2026-07-10T07:55:00Z', event: 'implement', runId: 'r1', cardId: 'b', model: 'claude-sonnet-5', tokensIn: 5000, tokensOut: 800, usd: 0.35 },
  { ts: '2026-07-10T07:56:00Z', event: 'card-fail', runId: 'r1', cardId: 'b', totalUSD: 0.35 },
  { ts: '2026-07-10T08:00:00Z', event: 'run-end', runId: 'r1' },
  { ts: '2026-07-12T07:30:00Z', event: 'run-start', runId: 'r2' },
  { ts: '2026-07-12T07:45:00Z', event: 'implement', runId: 'r2', cardId: 'c', model: 'claude-opus-4-8', tokensIn: 8000, tokensOut: 3000, usd: 1.25, attempt: 2 },
  { ts: '2026-07-12T07:46:00Z', event: 'card-pass', runId: 'r2', cardId: 'c', totalUSD: 1.25, attempt: 2 },
];

test('spentTonight sums only the given run', () => {
  assert.equal(spentTonight(FIXTURE, 'r1'), 1.15);
  assert.equal(spentTonight(FIXTURE, 'r2'), 1.25);
});

test('lastRunId finds the most recent run-start', () => {
  assert.equal(lastRunId(FIXTURE), 'r2');
  assert.equal(lastRunId([]), null);
});

test('lastRunId: a trailing triage entry opens a new night even before run-start', () => {
  // Triage ledgered but the executor never fired (launchd miss / stale-queue
  // exit) — "tonight" must be the triage-only night, not yesterday's run
  // resurfacing its skip/throttle banners.
  const withTriage = [...FIXTURE, { ts: '2026-07-13T07:32:00Z', event: 'triage', runId: 'r3', model: 'claude-sonnet-5', tokensIn: 49000, tokensOut: 13000, usd: 0.35 }];
  assert.equal(lastRunId(withTriage), 'r3');
  const s = usageStats(withTriage, new Date('2026-07-13T12:00:00Z'));
  assert.equal(s.runId, 'r3');
  assert.equal(s.tonight.usd, 0.35); // triage spend, nothing else
});

test('entriesForLastSegment: re-run under the same runId drops the earlier skip', () => {
  const rerun = [
    { ts: 't1', event: 'triage', runId: 'rX', usd: 0.3 },
    { ts: 't2', event: 'run-start', runId: 'rX' },
    { ts: 't3', event: 'run-skip', runId: 'rX', note: 'auth: login expired' },
    { ts: 't4', event: 'run-end', runId: 'rX', note: 'skipped: auth' },
    { ts: 't5', event: 'run-start', runId: 'rX' }, // manual re-run after /login
    { ts: 't6', event: 'card-pass', runId: 'rX', cardId: 'a' },
    { ts: 't7', event: 'run-end', runId: 'rX' },
  ];
  const seg = entriesForLastSegment(rerun, 'rX');
  assert.equal(seg[0].ts, 't5', 'segment starts at the LAST run-start');
  assert.ok(!seg.some(e => e.event === 'run-skip'), 'stale skip is not in the last segment');
  // Triage-only night (no run-start at all) → the whole run is the segment.
  const triageOnly = [{ ts: 't1', event: 'triage', runId: 'rY', usd: 0.3 }];
  assert.equal(entriesForLastSegment(triageOnly, 'rY').length, 1);
});

test('statsByModel splits tokens and usd per model', () => {
  const by = statsByModel(FIXTURE);
  assert.equal(by['claude-sonnet-5'].usd, 1.15);
  assert.equal(by['claude-sonnet-5'].tokensIn, 15000);
  assert.equal(by['claude-opus-4-8'].tokensOut, 3000);
});

test('usageStats: tonight = last run, week filters by ts, pace extrapolates', () => {
  const now = new Date('2026-07-12T12:00:00Z');
  const s = usageStats(FIXTURE, now);
  assert.equal(s.runId, 'r2');
  assert.equal(s.tonight.usd, 1.25);
  assert.equal(s.week.usd, 2.4); // both runs inside 7d
  assert.equal(s.paceMonthlyUSD, Math.round((2.4 / 7) * 30 * 100) / 100);
  // Entries older than 7d drop out of week but not tonight/run scoping.
  const later = new Date('2026-07-19T12:00:00Z');
  assert.equal(usageStats(FIXTURE, later).week.usd, 0);
});

// ── Crash recovery policy (carry-forward #2) ────────────────────────────────

test('recoveryActions: attempted → fail(crash-recovery); stale queued → clear', () => {
  const actions = recoveryActions(
    [
      { id: 'crashed', auto: 'attempted' },
      { id: 'stale', auto: 'queued' },
      { id: 'tonight', auto: 'queued' },
      { id: 'waiting', auto: 'needs-approval' },
    ],
    new Set(['tonight']),
  );
  assert.deepEqual(actions, [
    { id: 'crashed', action: 'fail', reason: 'crash-recovery' },
    { id: 'stale', action: 'clear', reason: 'stale-queue' },
  ]);
});

test('recoveryActions leaves needs-approval/terminal cards alone', () => {
  assert.deepEqual(recoveryActions([{ id: 'x', auto: 'merged' }, { id: 'y', auto: 'needs-approval' }], new Set()), []);
});

// ── Singleton (VERIFY line: two concurrent starts) ──────────────────────────

test('second concurrent start is refused while holder is alive', () => {
  const pf = tmpFile('run.pid');
  const first = acquireSingleton({ pidfilePath: pf, pid: 111, now: 1000, isAlive: () => true });
  assert.equal(first.acquired, true);
  const second = acquireSingleton({ pidfilePath: pf, pid: 222, now: 2000, isAlive: () => true });
  assert.equal(second.acquired, false);
  assert.equal(second.holder.pid, 111);
});

test('dead holder is stolen', () => {
  const pf = tmpFile('run.pid');
  acquireSingleton({ pidfilePath: pf, pid: 111, now: 1000, isAlive: () => true });
  const r = acquireSingleton({ pidfilePath: pf, pid: 222, now: 2000, isAlive: () => false });
  assert.equal(r.acquired, true);
  assert.equal(r.stolen, true);
});

test('holder older than 6h is KILLED then stolen even if alive (no second concurrent run)', () => {
  const pf = tmpFile('run.pid');
  const t0 = Date.parse('2026-07-12T00:00:00Z');
  const killed = [];
  acquireSingleton({ pidfilePath: pf, pid: 111, now: t0, isAlive: () => true });
  const r = acquireSingleton({
    pidfilePath: pf, pid: 222, now: t0 + 7 * 3600 * 1000,
    isAlive: () => true, killPid: p => killed.push(p),
  });
  assert.equal(r.acquired, true);
  assert.equal(r.stolen, true);
  assert.deepEqual(killed, [111], 'the wedged holder is terminated before the steal');
});

test('corrupt pidfile is stolen, not fatal', () => {
  const pf = tmpFile('run.pid');
  fs.writeFileSync(pf, 'not json{');
  const r = acquireSingleton({ pidfilePath: pf, pid: 222, now: 1000, isAlive: () => true });
  assert.equal(r.acquired, true);
});

test('releaseSingleton only removes our own pidfile', () => {
  const pf = tmpFile('run.pid');
  acquireSingleton({ pidfilePath: pf, pid: 111, now: 1000, isAlive: () => true });
  assert.equal(releaseSingleton({ pidfilePath: pf, pid: 999 }), false);
  assert.ok(fs.existsSync(pf), 'foreign release is a no-op');
  assert.equal(releaseSingleton({ pidfilePath: pf, pid: 111 }), true);
  assert.ok(!fs.existsSync(pf));
});

// ── Dead-man check (S2-T7) ──────────────────────────────────────────────────

test('deadman: stale ledger alerts, fresh ledger is silent, unarmed never alerts', () => {
  const { deadmanStatus } = require('./autonomous-ledger.js');
  const now = new Date('2026-07-14T12:00:00Z');
  const stale = [{ ts: '2026-07-13T07:30:00Z', event: 'run-end' }]; // 28.5h old
  const fresh = [{ ts: '2026-07-14T07:30:00Z', event: 'run-end' }]; // 4.5h old
  const staleR = deadmanStatus(stale, now);
  assert.equal(staleR.ok, false);
  assert.match(staleR.message, /silent for 28\.5h/);
  assert.equal(deadmanStatus(fresh, now).ok, true);
  // armed with an EMPTY ledger = the run never fired — that alerts too
  const empty = deadmanStatus([], now);
  assert.equal(empty.ok, false);
  assert.match(empty.message, /never fired/);
  // not armed → always ok (pre-install days, kill-switch periods)
  assert.equal(deadmanStatus(stale, now, { armed: false }).ok, true);
  assert.equal(deadmanStatus([], now, { armed: false }).ok, true);
});

test('deadman: fresh triage-only activity does NOT reset the clock (broken executor still alerts)', () => {
  const { deadmanStatus } = require('./autonomous-ledger.js');
  const now = new Date('2026-07-14T12:00:00Z');
  const triageOnly = [
    { ts: '2026-07-13T07:30:00Z', event: 'run-end' },                      // 28.5h old executor
    { ts: '2026-07-14T07:31:00Z', event: 'triage', runId: 'r9', usd: 0.3 }, // fresh triage
  ];
  const r = deadmanStatus(triageOnly, now);
  assert.equal(r.ok, false, 'triage activity alone must not keep the dead-man green');
});
