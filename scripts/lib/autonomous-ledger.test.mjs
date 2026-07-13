import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  appendEntry, readEntries, sumUSD, entriesForRun, lastRunId, statsByModel,
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

const FIXTURE = [
  { ts: '2026-07-10T07:30:00Z', event: 'run-start', runId: 'r1' },
  { ts: '2026-07-10T07:40:00Z', event: 'card-pass', runId: 'r1', cardId: 'a', model: 'claude-sonnet-5', tokensIn: 10000, tokensOut: 2000, usd: 0.8 },
  { ts: '2026-07-10T07:55:00Z', event: 'card-fail', runId: 'r1', cardId: 'b', model: 'claude-sonnet-5', tokensIn: 5000, tokensOut: 800, usd: 0.35 },
  { ts: '2026-07-10T08:00:00Z', event: 'run-end', runId: 'r1' },
  { ts: '2026-07-12T07:30:00Z', event: 'run-start', runId: 'r2' },
  { ts: '2026-07-12T07:45:00Z', event: 'card-pass', runId: 'r2', cardId: 'c', model: 'claude-opus-4-8', tokensIn: 8000, tokensOut: 3000, usd: 1.25, attempt: 2 },
];

test('spentTonight sums only the given run', () => {
  assert.equal(spentTonight(FIXTURE, 'r1'), 1.15);
  assert.equal(spentTonight(FIXTURE, 'r2'), 1.25);
});

test('lastRunId finds the most recent run-start', () => {
  assert.equal(lastRunId(FIXTURE), 'r2');
  assert.equal(lastRunId([]), null);
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

test('holder older than 6h is stolen even if alive', () => {
  const pf = tmpFile('run.pid');
  const t0 = Date.parse('2026-07-12T00:00:00Z');
  acquireSingleton({ pidfilePath: pf, pid: 111, now: t0, isAlive: () => true });
  const r = acquireSingleton({ pidfilePath: pf, pid: 222, now: t0 + 7 * 3600 * 1000, isAlive: () => true });
  assert.equal(r.acquired, true);
  assert.equal(r.stolen, true);
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
