import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  taskContentHash,
  isHumanTask,
  computeParkedMap,
  candidateOrder,
  computeConcurrency,
  computeSpendCircuitBreaker,
  computeDrainMetric,
  formatBannerText,
} = require('./backlog-drain.js');
const dispatchLedger = require('./dispatch-ledger.js');

function task(id, subject, { category = 'no-category', status = 'pending', notionId = null } = {}) {
  const nid = notionId || `aaaaaaaa-0000-0000-0000-${String(id).padStart(12, '0')}`;
  return {
    id: String(id),
    subject,
    status,
    description: `[notion:${nid}] P2 Next · Not started · ${category}\nhttps://example.test/${id}`,
  };
}

function notionIdOfFn(t) {
  const m = /\[notion:([a-f0-9-]+)\]/i.exec(t.description || '');
  return m ? m[1] : null;
}

// ── isHumanTask / candidateOrder: human-category cards never selected ──────

test('human-category cards are flagged and never selected', () => {
  const marketing = task(1, 'Post revivals on Reddit', { category: 'marketing' });
  const technical = task(2, 'Fix a null pointer', { category: 'engineering' });
  assert.equal(isHumanTask(marketing), true);
  assert.equal(isHumanTask(technical), false);

  const order = candidateOrder([marketing, technical], { notionIdOfFn });
  assert.deepEqual(order.map(t => t.id), ['2']);
});

test('human-action imperative subject is excluded even with a benign category', () => {
  const t = task(3, 'Email volunteers', { category: 'no-category' });
  assert.equal(isHumanTask(t), true);
  const order = candidateOrder([t], { notionIdOfFn });
  assert.deepEqual(order, []);
});

// ── candidateOrder: oldest-eligible-first, skips parked/refused/in-flight ──

test('candidateOrder picks oldest id first among eligible pending tasks', () => {
  const tasks = [task(50, 'Newer card'), task(10, 'Oldest card'), task(30, 'Middle card')];
  const order = candidateOrder(tasks, { notionIdOfFn });
  assert.deepEqual(order.map(t => t.id), ['10', '30', '50']);
});

test('candidateOrder skips parked cards (attempt-memory failed-twice-unchanged)', () => {
  const a = task(1, 'Flaky card');
  const b = task(2, 'Healthy card');
  const hash = taskContentHash(a);
  const ledgerEntries = [
    { ts: '2026-07-01T00:00:00Z', event: 'card-fail', cardId: '1', contentHash: hash, note: 'checks failed' },
    { ts: '2026-07-02T00:00:00Z', event: 'card-fail', cardId: '1', contentHash: hash, note: 'checks failed again' },
  ];
  const parkedIds = computeParkedMap([a, b], ledgerEntries);
  assert.equal(parkedIds.has('1'), true);
  assert.equal(parkedIds.has('2'), false);

  const order = candidateOrder([a, b], { parkedIds, notionIdOfFn });
  assert.deepEqual(order.map(t => t.id), ['2']);
});

test('candidateOrder skips cards flagged unarmed by the verifiability report (awaiting-enrichment)', () => {
  const a = task(1, 'No acceptance criteria');
  const b = task(2, 'Has a real verify command');
  const refusedNotionIds = new Set([notionIdOfFn(a)]);
  const order = candidateOrder([a, b], { refusedNotionIds, notionIdOfFn });
  assert.deepEqual(order.map(t => t.id), ['2']);
});

test('candidateOrder skips in-flight (already drain-dispatched and alive) cards', () => {
  const a = task(1, 'Already running');
  const b = task(2, 'Free to pick');
  const order = candidateOrder([a, b], { inFlightIds: new Set(['1']), notionIdOfFn });
  assert.deepEqual(order.map(t => t.id), ['2']);
});

test('candidateOrder never includes in_progress or completed tasks', () => {
  const tasks = [
    task(1, 'Done already', { status: 'completed' }),
    task(2, 'Someone is on it', { status: 'in_progress' }),
    task(3, 'Actually pending'),
  ];
  const order = candidateOrder(tasks, { notionIdOfFn });
  assert.deepEqual(order.map(t => t.id), ['3']);
});

// ── computeConcurrency: cap K enforced against a fixture ledger ────────────

test('computeConcurrency counts only drain-originated, non-terminal jobs and enforces the cap', () => {
  const entries = [
    { ts: '2026-07-30T10:00:00Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '1', jobId: '1-abc' },
    { ts: '2026-07-30T10:05:00Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '2', jobId: '2-def' },
    // Task 3's job already finished (terminal) — must not count as alive.
    { ts: '2026-07-30T09:00:00Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '3', jobId: '3-ghi' },
    { ts: '2026-07-30T09:30:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '3', jobId: '3-ghi', costUSD: 1.2 },
    // Task 4 has a live job too, but was never dispatched BY drain (not in
    // drainDispatchedTaskIds) — must not count.
    { ts: '2026-07-30T10:10:00Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '4', jobId: '4-jkl' },
  ];
  const drainDispatchedTaskIds = new Set(['1', '2', '3']);

  const atCapTwo = computeConcurrency(drainDispatchedTaskIds, entries, 2);
  assert.equal(atCapTwo.alive, 2);
  assert.equal(atCapTwo.atCap, true);
  assert.deepEqual(atCapTwo.aliveTaskIds.sort(), ['1', '2']);

  const underCapThree = computeConcurrency(drainDispatchedTaskIds, entries, 3);
  assert.equal(underCapThree.atCap, false);
});

// ── computeSpendCircuitBreaker: reuses #635's halt semantics ───────────────

test('computeSpendCircuitBreaker halts after spend with zero completions, windowed to recent entries', () => {
  const now = new Date('2026-07-30T12:00:00Z').getTime();
  const entries = [
    { ts: '2026-07-30T10:00:00Z', event: 'card-fail', cardId: '1', usd: 8 },
    { ts: '2026-07-30T11:00:00Z', event: 'card-fail', cardId: '2', usd: 6 },
    // Outside the 24h window — must not count toward the halt.
    { ts: '2026-07-27T00:00:00Z', event: 'card-fail', cardId: '9', usd: 100 },
  ];
  const status = computeSpendCircuitBreaker(entries, { thresholdUSD: 10, windowH: 24, now });
  assert.equal(status.halt, true);
  assert.equal(status.spentUSD, 14);

  const withPass = entries.concat([{ ts: '2026-07-30T11:30:00Z', event: 'card-pass', cardId: '3', usd: 1 }]);
  const statusPassed = computeSpendCircuitBreaker(withPass, { thresholdUSD: 10, windowH: 24, now });
  assert.equal(statusPassed.halt, false);
});

// ── computeDrainMetric: net drain, parked, awaiting-enrichment math ────────

test('computeDrainMetric computes pending/human/parked/awaitingEnrichment buckets and net-drain-this-week', () => {
  const human = task(1, 'Email volunteers');
  const parkedTask = task(2, 'Flaky card');
  const enrichTask = task(3, 'No acceptance criteria');
  const clean1 = task(4, 'Clean card A');
  const clean2 = task(5, 'Clean card B');
  const tasks = [human, parkedTask, enrichTask, clean1, clean2];

  const parkedIds = new Map([['2', 'parked: failed 2x unchanged']]);
  const refusedNotionIds = new Set([notionIdOfFn(enrichTask)]);
  const now = new Date('2026-07-30T12:00:00Z');
  const priorHistory = [{ date: '2026-07-23', pending: 8 }, { date: '2026-07-24', pending: 9 }];

  const metric = computeDrainMetric(tasks, { refusedNotionIds, notionIdOfFn, parkedIds, priorHistory, now });

  assert.equal(metric.pending, 5);
  assert.equal(metric.humanWaiting, 1);
  assert.equal(metric.parked, 1);
  assert.equal(metric.awaitingEnrichment, 1);
  // pending today (5) - pending a week ago (8, the 2026-07-23 entry, the
  // closest one at-or-before the 2026-07-23 target) = -3 (drained by 3).
  assert.equal(metric.netDrainWeek, -3);
  assert.ok(metric.history.some(h => h.date === '2026-07-30' && h.pending === 5));
});

test('computeDrainMetric returns null netDrainWeek with no week-old history', () => {
  const tasks = [task(1, 'Solo card')];
  const metric = computeDrainMetric(tasks, { notionIdOfFn, now: new Date('2026-07-30T12:00:00Z') });
  assert.equal(metric.netDrainWeek, null);
});

test('formatBannerText renders the owner-facing sentence shape', () => {
  const text = formatBannerText({ pending: 103, netDrainWeek: -4, parked: 6, awaitingEnrichment: 12, humanWaiting: 0 });
  assert.equal(text, '103 pending (net -4 this week, 6 parked as failed-twice, 12 awaiting enrichment)');
});

test('formatBannerText omits empty buckets and a positive net drain shows a + sign', () => {
  const text = formatBannerText({ pending: 20, netDrainWeek: 3, parked: 0, awaitingEnrichment: 0, humanWaiting: 5 });
  assert.equal(text, '20 pending (net +3 this week, 5 waiting on owner)');
});
