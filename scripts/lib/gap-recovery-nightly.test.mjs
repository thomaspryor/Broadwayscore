// BRO-7171 Stage 3: nightly summary row, ACTION alerts, and the one owner
// digest line. Run: node --test scripts/lib/gap-recovery-nightly.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const N = require('./gap-recovery-nightly.js');

const NOW = Date.parse('2026-11-10T07:00:00Z');
const H = 3600e3;

test('planCounts: recent never needs a decision; historic with every try used up does; cooldown does not', () => {
  const c = N.planCounts([
    { recency: 'recent', strategy: null, skipped: [{ strategy: 'REFETCH_FREE', reason: 'abandoned' }] },
    { recency: 'recent', strategy: 'ARCHIVE', skipped: [] },
    { recency: 'historic', strategy: null, skipped: [{ strategy: 'REFETCH_FREE', reason: 'max_retries_reached' }, { strategy: 'ARCHIVE', reason: 'abandoned' }] },
    { recency: 'historic', strategy: null, skipped: [{ strategy: 'REFETCH_FREE', reason: 'abandoned' }, { strategy: 'ARCHIVE', reason: 'cooldown' }] },
    { recency: 'historic', strategy: null, skipped: [{ strategy: 'URL_REDISCOVER', reason: 'disabled' }] },
    { recency: 'historic', strategy: 'ARCHIVE', skipped: [] },
  ]);
  assert.deepEqual(c, { openTotal: 6, openRecent: 2, needsDecision: 1 });
});

test('pendingStuckCount: only a LATEST pending_push row older than 24h counts', () => {
  const rows = [
    { reviewKey: 'a/x.json', outcome: 'pending_push', ts: new Date(NOW - 30 * H).toISOString() },
    { reviewKey: 'b/x.json', outcome: 'pending_push', ts: new Date(NOW - 30 * H).toISOString() },
    { reviewKey: 'b/x.json', outcome: 'recovered', ts: new Date(NOW - 29 * H).toISOString() },
    { reviewKey: 'c/x.json', outcome: 'pending_push', ts: new Date(NOW - 2 * H).toISOString() },
  ];
  assert.equal(N.pendingStuckCount(rows, NOW), 1);
});

test('pendingStuckCount: a later read-only URL_FIND_PROBE row does not hide a stuck pending_push (BRO-7171)', () => {
  const rows = [
    { reviewKey: 'a/x.json', outcome: 'pending_push', strategy: 'URL_FIND', ts: new Date(NOW - 30 * H).toISOString() },
    { reviewKey: 'a/x.json', outcome: 'non_evidence', strategy: 'URL_FIND_PROBE', ts: new Date(NOW - 1 * H).toISOString() },
  ];
  assert.equal(N.pendingStuckCount(rows, NOW), 1);
});

test('auth streak: a night with no browser attempt carries the streak; success resets it', () => {
  assert.equal(N.nextAuthStreak({ authFailedStreak: 1 }, { authFailed: true, authOk: false }), 2);
  assert.equal(N.nextAuthStreak({ authFailedStreak: 1 }, { authFailed: false, authOk: false }), 1);
  assert.equal(N.nextAuthStreak({ authFailedStreak: 3 }, { authFailed: false, authOk: true }), 0);
  assert.equal(N.nextAuthStreak(null, { authFailed: true, authOk: false }), 1);
});

test('alerts: only ACTION conditions; one lost-login night is not an alert, two are', () => {
  assert.deepEqual(N.decideAlerts({ authFailedStreak: 1, authOutlets: ['thestage'] }), []);
  const keys = N.decideAlerts({ authFailedStreak: 2, authOutlets: ['thestage'], pendingStuck: 3, reopened: 1, ceilingHit: true, ceiling: 60 }).map((a) => a.key);
  assert.deepEqual(keys, ['browser_session_lost', 'pending_push_stuck', 'reconcile_reopened', 'ceiling_hit']);
  assert.deepEqual(N.decideAlerts({ pushFailed: true }).map((a) => a.key), ['pending_push_stuck']);
});

test('buildNightlyRow: streak builds across nights and raises browser_session_lost on night 2', () => {
  const summary = { attempted: 10, accepted: 4, landed: 4, authFailedOutlets: ['thestage'], authOkOutlets: [] };
  const counts = { openTotal: 100, openRecent: 40, needsDecision: 2 };
  const n1 = N.buildNightlyRow({ runId: 'r1', status: 'ran', summary, counts, prevRows: [], ceiling: 60, nowMs: NOW - 24 * H });
  assert.equal(n1.authFailedStreak, 1);
  assert.deepEqual(n1.alerts, []);
  const n2 = N.buildNightlyRow({ runId: 'r2', status: 'ran', summary, counts, prevRows: [n1], ceiling: 60, nowMs: NOW });
  assert.equal(n2.authFailedStreak, 2);
  assert.deepEqual(n2.alerts.map((a) => a.key), ['browser_session_lost']);
  const dry = N.buildNightlyRow({ runId: 'd', status: 'dry_run', summary: { pushFailed: true }, counts, prevRows: [n2], ceiling: 60, nowMs: NOW });
  assert.deepEqual(dry.alerts, []);
});

test('auth streak is per site and counts failed nights; push failure is not also run_failed', () => {
  const counts = { openTotal: 1, openRecent: 1, needsDecision: 0 };
  const a = { attempted: 1, authFailedOutlets: ['thestage'], authOkOutlets: [] };
  const b = { attempted: 1, authFailedOutlets: ['nyt'], authOkOutlets: [] };
  const n1 = N.buildNightlyRow({ runId: '1', status: 'ran', summary: a, counts, ceiling: 60, nowMs: NOW - 48 * H });
  const n2 = N.buildNightlyRow({ runId: '2', status: 'ran', summary: b, counts, prevRows: [n1], ceiling: 60, nowMs: NOW - 24 * H });
  assert.equal(n2.authFailedStreak, 1, 'A then B is not a 2-night streak');
  assert.deepEqual(n2.alerts, []);
  // night 2 failed overall but still counts toward the streak
  const f2 = N.buildNightlyRow({ runId: '2', status: 'failed', summary: a, counts, prevRows: [n1], ceiling: 60, nowMs: NOW - 24 * H, driverExit: 1 });
  const busy = N.buildNightlyRow({ runId: 'b', status: 'busy', summary: null, counts: null, prevRows: [n1, f2], ceiling: 60, nowMs: NOW - 12 * H });
  assert.deepEqual(busy.authFailedStreaks, { thestage: 2 }, 'busy night carries streaks');
  const n3 = N.buildNightlyRow({ runId: '3', status: 'ran', summary: a, counts, prevRows: [n1, f2, busy], ceiling: 60, nowMs: NOW });
  assert.equal(n3.authFailedStreak, 3);
  assert.deepEqual(n3.authFailedOutlets, ['thestage']);
  const pf = N.buildNightlyRow({ runId: 'p', status: 'failed', summary: { pushFailed: true, error: 'git push: remote rejected' }, counts, ceiling: 60, nowMs: NOW, driverExit: 1 });
  assert.deepEqual(pf.alerts.map((x) => x.key), ['pending_push_stuck']);
});

test('renderDigestLine: one aggregated plain-English line with change vs the night before', () => {
  const r1 = { ts: new Date(NOW - 30 * H).toISOString(), status: 'ran', openRecent: 1800, recovered: 5, needsDecision: 0, alerts: [] };
  const r2 = { ts: new Date(NOW - 6 * H).toISOString(), status: 'ran', openRecent: 1782, recovered: 18, needsDecision: 3, alerts: [] };
  const line = N.renderDigestLine([r1, r2], NOW);
  assert.equal(line, 'Review texts: 1,782 reviews of recent shows still lack their full text (18 fewer than the night before); 18 recovered last night; 3 older ones have run out of automatic options and will need your decision.');
  assert.doesNotMatch(line, /BRO-|\.json|thestage|REFETCH/);
});

test('renderDigestLine: alerts appended; stale, disabled, never-ran and dry-run-only cases', () => {
  const alertRow = { ts: new Date(NOW - 6 * H).toISOString(), status: 'ran', openRecent: 10, recovered: 0, needsDecision: 0, alerts: [{ key: 'ceiling_hit', text: 'the nightly limit of 60 recovered reviews was reached, so more are waiting for the next night' }] };
  assert.match(N.renderDigestLine([alertRow], NOW), /Needs attention: the nightly limit of 60/);
  assert.match(N.renderDigestLine([{ ...alertRow, ts: new Date(NOW - 48 * H).toISOString() }], NOW), /did not run last night \(last ran 2026-11-08\)/);
  assert.equal(N.renderDigestLine([{ ts: new Date(NOW - H).toISOString(), status: 'disabled' }], NOW), 'Review texts: the nightly recovery is switched off.');
  assert.equal(N.renderDigestLine([], NOW), null);
  assert.equal(N.renderDigestLine([{ ts: new Date(NOW - H).toISOString(), status: 'dry_run', openRecent: 1 }], NOW), null);
});

test('readNightlyRows: orders by ts (union merge appends out of order) and skips torn lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-nightly-'));
  const f = path.join(dir, 'n.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ ts: '2026-11-10T00:00:00Z', status: 'ran', n: 2 })}\n{torn\n${JSON.stringify({ ts: '2026-11-09T00:00:00Z', status: 'ran', n: 1 })}\n`);
  assert.deepEqual(N.readNightlyRows(f).map((r) => r.n), [1, 2]);
  N.appendNightlyRow({ ts: '2026-11-11T00:00:00Z', status: 'ran', n: 3 }, f);
  assert.deepEqual(N.readNightlyRows(f).map((r) => r.n), [1, 2, 3]);
});

test('nightlyCeiling: env override, conservative default 60', () => {
  assert.equal(N.nightlyCeiling({}), 60);
  assert.equal(N.nightlyCeiling({ GAP_RECOVERY_NIGHTLY_CEILING: '25' }), 25);
  assert.equal(N.nightlyCeiling({ GAP_RECOVERY_NIGHTLY_CEILING: 'lots' }), 60);
});

test('digest: an unanswered owner batch is named by count and file, never by ids (Stage 4)', () => {
  const counts = { openTotal: 100, openRecent: 40, needsDecision: 800 };
  const ownerBatch = { date: '2026-11-09', count: 805, file: '/Users/x/Documents/claude-outputs/gap-recovery-owner-batch-2026-11-09.md' };
  const row = N.buildNightlyRow({ runId: 'r', status: 'ran', summary: { landed: 3 }, counts, prevRows: [], ceiling: 60, nowMs: NOW, ownerBatch });
  assert.deepEqual(row.ownerBatchPending, { count: 805, date: '2026-11-09', file: 'gap-recovery-owner-batch-2026-11-09.md' });
  const line = N.renderDigestLine([row], NOW);
  assert.match(line, /805 older ones are waiting for your yes or no \(gap-recovery-owner-batch-2026-11-09\.md in your claude-outputs folder\)/);
  assert.doesNotMatch(line, /\/Users\//);
  const none = N.buildNightlyRow({ runId: 'r', status: 'ran', summary: { landed: 3 }, counts, prevRows: [], ceiling: 60, nowMs: NOW });
  assert.equal(none.ownerBatchPending, null);
  assert.match(N.renderDigestLine([none], NOW), /800 older ones have run out of automatic options/);
});
