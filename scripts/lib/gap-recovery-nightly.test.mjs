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
  assert.deepEqual(c, { openTotal: 6, openRecent: 2, needsDecision: 1, excludedRecords: 0 });
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

// The digest loads gap-recovery-nightly and must stay on node built-ins, so the
// nightly keeps its own copy of the inert-strategy set: it must match the ledger's.
test('nightly INERT_STRATEGIES matches the ledger set (copy kept off the digest import graph)', () => {
  const L = require('./gap-recovery-ledger.js');
  assert.deepEqual([...N.INERT_STRATEGIES].sort(), [...L.INERT_STRATEGIES].sort());
});

test('buildNightlyRow: superseded reopens are recorded but raise no "lost the recovered text" alert (BRO-7171)', () => {
  const summary = { attempted: 1, accepted: 0, landed: 0, byStrategy: {} };
  const counts = { openTotal: 1, openRecent: 0, needsDecision: 0 };
  const all = N.buildNightlyRow({ runId: 'r', status: 'ran', summary, counts, reopened: 6, superseded: 6, prevRows: [], ceiling: 60, nowMs: NOW });
  assert.equal(all.reopened, 6);
  assert.equal(all.superseded, 6);
  assert.equal(all.alerts.some((a) => a.key === 'reconcile_reopened'), false);
  const some = N.buildNightlyRow({ runId: 'r', status: 'ran', summary, counts, reopened: 6, superseded: 4, prevRows: [], ceiling: 60, nowMs: NOW });
  const a = some.alerts.find((x) => x.key === 'reconcile_reopened');
  assert.ok(a && /^2 reviews/.test(a.text), JSON.stringify(some.alerts));
});

test('planCounts: a historic review blocked by superseded_at_url reaches a decision (BRO-7171)', () => {
  const c = N.planCounts([
    { recency: 'historic', strategy: null, skipped: [{ strategy: 'REFETCH_FREE', reason: 'superseded_at_url' }, { strategy: 'ARCHIVE', reason: 'superseded_at_url' }] },
  ]);
  assert.deepEqual(c, { openTotal: 1, openRecent: 0, needsDecision: 1, excludedRecords: 0 });
});

// BRO-7942: excluded_record rows (wrongShow/wrongProduction) are not recoverable gaps.
test('planCounts: excluded_record rows leave openTotal and are reported apart', () => {
  const c = N.planCounts([
    { recency: 'recent', strategy: 'REFETCH_FREE', skipped: [] },
    { recency: 'recent', strategy: null, skipped: [{ strategy: 'ANY', reason: 'excluded_record' }] },
    { recency: 'historic', strategy: null, skipped: [{ strategy: 'ANY', reason: 'excluded_record' }] },
  ]);
  assert.deepEqual(c, { openTotal: 1, openRecent: 1, needsDecision: 0, excludedRecords: 2 });
});

test('nightly row: recovered counts only tier-improving landings', () => {
  const row = N.buildNightlyRow({ runId: 'r', status: 'ok', summary: { landed: 5, landedImproved: 2, accepted: 5, attempted: 9 }, counts: { openTotal: 1, openRecent: 1, needsDecision: 0, excludedRecords: 3 } });
  assert.equal(row.recovered, 2);
  assert.equal(row.landedNoTierGain, 3);
  assert.equal(row.excludedRecords, 3);
});

// BRO-7944: missed-run alarm, zero-yield strategies, time-budget alert.
test('missedRunAlert: no non-dry row in 26h alerts; fresh row, dry-run-only and never-ran do not', () => {
  const ran = (h) => ({ ts: new Date(NOW - h * H).toISOString(), status: 'ran' });
  assert.equal(N.missedRunAlert([ran(6)], NOW), null);
  assert.equal(N.missedRunAlert([ran(25.9)], NOW), null);
  const a = N.missedRunAlert([ran(27)], NOW);
  assert.equal(a.key, 'missed_run');
  assert.match(a.text, /26 hours/);
  // a dry run does not count as the nightly row
  assert.equal(N.missedRunAlert([ran(30), { ts: new Date(NOW - H).toISOString(), status: 'dry_run' }], NOW).key, 'missed_run');
  assert.equal(N.missedRunAlert([], NOW), null);
  // disabled/busy rows ARE nightly rows (the job ran)
  assert.equal(N.missedRunAlert([{ ts: new Date(NOW - H).toISOString(), status: 'busy' }], NOW), null);
});

test('renderDigestLine: a missed night carries the missed_run alert in "Needs attention"', () => {
  const line = N.renderDigestLine([{ ts: new Date(NOW - 30 * H).toISOString(), status: 'ran', openRecent: 1 }], NOW);
  assert.match(line, /did not run last night/);
  assert.match(line, /Needs attention: no nightly recovery run was recorded/);
});

test('zeroYieldStrategies: attempted on 3 ran nights with 0 accepted each; neutral when not attempted; broken by an accept', () => {
  const night = (by) => ({ status: 'ran', ts: 'x', byStrategy: by });
  const z = { attempted: 5, accepted: 0 };
  const prev = [night({ ARCHIVE: z }), night({ ARCHIVE: z, URL_FIND: z }), night({ ARCHIVE: z })];
  assert.deepEqual(N.zeroYieldStrategies(prev, { ARCHIVE: z, URL_FIND: z }), ['ARCHIVE']);
  assert.deepEqual(N.zeroYieldStrategies(prev.slice(1), { ARCHIVE: z }), ['ARCHIVE']);
  assert.deepEqual(N.zeroYieldStrategies(prev.slice(2), { ARCHIVE: z }), []);
  assert.deepEqual(N.zeroYieldStrategies([...prev.slice(0, 2), night({ ARCHIVE: { attempted: 4, accepted: 1 } })], { ARCHIVE: z }), []);
  assert.deepEqual(N.zeroYieldStrategies(prev, { ARCHIVE: { attempted: 3, accepted: 1 } }), []);
  assert.deepEqual(N.zeroYieldStrategies(prev, { ARCHIVE: { attempted: 0, accepted: 0 } }), []);
});

test('buildNightlyRow: time-budget stop and a 3-night 0% strategy become alerts', () => {
  const z = { attempted: 5, accepted: 0, outcomes: {} };
  const prevRows = [1, 2].map((i) => ({ status: 'ran', ts: new Date(NOW - i * 24 * H).toISOString(), byStrategy: { URL_REDISCOVER: z } }));
  const row = N.buildNightlyRow({ runId: 'r', status: 'ran', summary: { attempted: 5, accepted: 0, byStrategy: { URL_REDISCOVER: z }, timeBudgetHit: true }, prevRows, ceiling: 60, nowMs: NOW });
  const keys = row.alerts.map((a) => a.key);
  assert.ok(keys.includes('time_budget_hit'));
  assert.ok(keys.includes('strategy_zero_yield'));
  assert.deepEqual(row.zeroYieldStrategies, ['URL_REDISCOVER']);
  assert.equal(row.timeBudgetHit, true);
  assert.match(N.renderDigestLine([row], NOW), /time budget/);
});
