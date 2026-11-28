// BRO-7137: the backlog line must not say "Holding" while the old pile sits still.
// require()s the real functions (CLAUDE.md rule 15): the inflow verdict, board-numbers'
// flow walk summary and board-categories' report, so a policy change fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const inflow = require('../../scripts/lib/backlog-inflow-ratio.js');
const bn = require('../../scripts/lib/board-numbers.js');
const bc = require('../../scripts/lib/board-categories.js');

const NOW = new Date('2026-11-08T12:00:00Z');
const daysAgo = (d, h = 0) => new Date(NOW.getTime() - d * 86400_000 + h * 3600_000).toISOString();
const SESSION_FOOTER = '\n\nFiled by: session (kind: test)';

// The live shape from the card: 357 filed / 377 closed looks balanced.
const RAW = { created: 357, completed: 377, canceled: 20, open: 341, windowDays: 7, since: daysAgo(7), truncated: false, truncatedCounts: [] };

function report({ ready = 12, cards = [] } = {}) {
  return { open: cards.length, cards, categories: [{ key: 'ready', exclusive: ready }, { key: 'other', exclusive: cards.length - ready }] };
}

test('summarizeStuckPile counts open cards older than STUCK_AGE_DAYS and rebuilds last week', () => {
  const cards = [daysAgo(40), daysAgo(25), daysAgo(18), daysAgo(15), daysAgo(3)].map((createdAt) => ({ createdAt }));
  const r = inflow.summarizeStuckPile(cards, { now: NOW, leftOldPile: 3 });
  assert.equal(inflow.STUCK_AGE_DAYS, 14);
  assert.equal(r.count, 4); // 40, 25, 18, 15
  assert.equal(r.weekAgo, 2 + 3); // older than 21d today (40, 25) + 3 closed this week
  assert.equal(r.change, -1);
  const noFlow = inflow.summarizeStuckPile(cards, { now: NOW });
  assert.deepEqual(noFlow, { count: 4, weekAgo: null, change: null });
});

test('board-numbers flow counts cards that left the stuck pile this week', () => {
  const nodes = [
    { title: 'old done', createdAt: daysAgo(30), completedAt: daysAgo(2) },
    { title: 'old canceled', createdAt: daysAgo(22), canceledAt: daysAgo(1) },
    { title: 'young done', createdAt: daysAgo(20), completedAt: daysAgo(1) }, // was 13 days old a week ago
    { title: 'old, closed long ago', createdAt: daysAgo(60), completedAt: daysAgo(10) },
  ];
  const r = bn.summarizeBoardFlow(nodes, { now: NOW, windowDays: 7 });
  assert.equal(r.leftOldPile, 2);
});

test('board-categories report cards carry createdAt for the pile count', () => {
  const r = bc.categorizeBoard([{ identifier: 'BRO-1', title: 't', description: '', priority: 3, createdAt: daysAgo(30), updatedAt: daysAgo(1), state: { name: 'Todo', type: 'unstarted' }, labels: { nodes: [] }, comments: { nodes: [] } }], { now: NOW });
  assert.equal(r.cards[0].createdAt, daysAgo(30));
});

test('withBacklogHealth swaps in the ceremony-filtered flow and reports same-day cards', () => {
  const flow = { created: 122, completed: 221, canceled: 30, leftOldPile: 10, windowDays: 7, truncated: false,
    excluded: { created: { canary: 0, routineLog: 0, sessionTracking: 96, duplicate: 1 }, completed: { canary: 0, routineLog: 0, sessionTracking: 96, duplicate: 0 } } };
  const old = Array.from({ length: 224 }, () => ({ createdAt: daysAgo(30) }));
  const c = inflow.withBacklogHealth(RAW, { flow, report: report({ ready: 12, cards: old }), now: NOW });
  assert.equal(c.created, 122);
  assert.equal(c.completed, 221);
  assert.equal(c.sameDay, 96);
  assert.equal(c.otherBookkeeping, 1);
  assert.match(inflow.assessInflowRatio(c).message, /96 session cards closed within 6 hours and 1 canary, routine-log or duplicate cards/);
  assert.equal(c.ready, 12);
  assert.deepEqual(c.stuckPile, { count: 224, weekAgo: 234, change: -10 });
  assert.equal(c.open, 224);
});

test('a balanced ratio with a pile that did not shrink is watch, never "Holding"', () => {
  const old = Array.from({ length: 224 }, () => ({ createdAt: daysAgo(30) }));
  const flow = { created: 200, completed: 210, canceled: 5, leftOldPile: 0, windowDays: 7, truncated: false,
    excluded: { created: { canary: 0, routineLog: 0, sessionTracking: 96, duplicate: 0 }, completed: { canary: 0, routineLog: 0, sessionTracking: 96, duplicate: 0 } } };
  const v = inflow.assessInflowRatio(inflow.withBacklogHealth(RAW, { flow, report: report({ ready: 12, cards: old }), now: NOW }));
  assert.equal(v.status, 'watch');
  assert.doesNotMatch(v.message, /Holding/);
  assert.match(v.message, /Flow is fine, but the old pile is not shrinking\./);
  assert.match(v.message, /Stuck pile: 224 open cards older than 14 days, same as a week ago\./);
  assert.match(v.message, /Left out of both counts: 96 session cards closed within 6 hours\./);
});

test('fewer than READY_MIN ready cards is watch even when the pile shrinks', () => {
  const cards = Array.from({ length: 20 }, () => ({ createdAt: daysAgo(30) }));
  const flow = { created: 50, completed: 60, canceled: 0, leftOldPile: 5, windowDays: 7, truncated: false, excluded: { created: {}, completed: {} } };
  const v = inflow.assessInflowRatio(inflow.withBacklogHealth(RAW, { flow, report: report({ ready: inflow.READY_MIN - 1, cards }), now: NOW }));
  assert.equal(v.status, 'watch');
  assert.match(v.message, /down 5 from a week ago/);
  assert.match(v.message, /9 cards ready for a worker/);
  assert.match(v.message, /Flow is fine, but fewer than 10 cards are ready for a worker\./);
  assert.doesNotMatch(v.message, /pile is not shrinking/);
});

test('a shrinking pile with enough ready cards stays ok and keeps "Holding"', () => {
  const cards = Array.from({ length: 20 }, () => ({ createdAt: daysAgo(30) }));
  const flow = { created: 50, completed: 60, canceled: 0, leftOldPile: 5, windowDays: 7, truncated: false, excluded: { created: {}, completed: {} } };
  const v = inflow.assessInflowRatio(inflow.withBacklogHealth(RAW, { flow, report: report({ ready: 15, cards }), now: NOW }));
  assert.equal(v.status, 'ok');
  assert.match(v.message, /Holding\./);
});

test('a worse flow verdict is never softened by a healthy pile', () => {
  const cards = Array.from({ length: 20 }, () => ({ createdAt: daysAgo(30) }));
  const flow = { created: 300, completed: 60, canceled: 0, leftOldPile: 5, windowDays: 7, truncated: false, excluded: { created: {}, completed: {} } };
  const v = inflow.assessInflowRatio(inflow.withBacklogHealth(RAW, { flow, report: report({ ready: 15, cards }), now: NOW }));
  assert.equal(v.status, 'error');
});

test('missing, failed or truncated inputs fall back to the raw flow-only line', () => {
  const plain = inflow.assessInflowRatio(RAW);
  for (const opts of [{}, { flow: { error: 'boom' }, report: null }, { flow: { truncated: true, created: 1, completed: 1, windowDays: 7, excluded: {} } }, { flow: { created: 1, completed: 1, windowDays: 1, excluded: {} } }]) {
    assert.deepEqual(inflow.assessInflowRatio(inflow.withBacklogHealth(RAW, { ...opts, now: NOW })), plain);
  }
  // Report present but flow down: pile still shown, week-over-week marked unavailable, no false alarm from it.
  const v = inflow.assessInflowRatio(inflow.withBacklogHealth(RAW, { report: report({ ready: 15, cards: [{ createdAt: daysAgo(30) }] }), now: NOW }));
  assert.equal(v.status, 'ok');
  assert.match(v.message, /last week's number unavailable/);
});

test('ceremonyKind is the same-day rule: a session card closed within 6h counts as sessionTracking', () => {
  const nodes = [
    { title: 'quick', description: `x${SESSION_FOOTER}`, createdAt: daysAgo(2), completedAt: daysAgo(2, 2) },
    { title: 'slow', description: `x${SESSION_FOOTER}`, createdAt: daysAgo(3), completedAt: daysAgo(2) },
  ];
  const r = bn.summarizeBoardFlow(nodes, { now: NOW, windowDays: 7 });
  assert.equal(r.excluded.created.sessionTracking, 1);
  assert.equal(r.created, 1);
});

test('an empty or tiny board is not flagged, and a non-"Holding" ok line still names its reason', () => {
  const flow = { created: 10, completed: 20, canceled: 0, leftOldPile: 0, windowDays: 7, truncated: false, excluded: { created: {}, completed: {} } };
  const tiny = inflow.assessInflowRatio(inflow.withBacklogHealth(RAW, { flow, report: report({ ready: 1, cards: [{ createdAt: daysAgo(2) }] }), now: NOW }));
  assert.equal(tiny.status, 'ok');
  assert.match(tiny.message, /Holding\./);
  const quiet = { created: 0, completed: 0, canceled: 0, leftOldPile: 0, windowDays: 7, truncated: false, excluded: { created: {}, completed: {} } };
  const old = Array.from({ length: 30 }, () => ({ createdAt: daysAgo(40) }));
  const v = inflow.assessInflowRatio(inflow.withBacklogHealth(RAW, { flow: quiet, report: report({ ready: 15, cards: old }), now: NOW }));
  assert.equal(v.status, 'watch');
  assert.match(v.message, /nothing filed and nothing closed.*Watch: the old pile is not shrinking\./);
});

test('flow counts replace raw canceled and truncation; both flow sources down still shows the pile', () => {
  const flow = { created: 10, completed: 12, canceled: 3, leftOldPile: 0, windowDays: 7, truncated: false, excluded: { created: {}, completed: {} } };
  const c = inflow.withBacklogHealth({ ...RAW, truncated: true, truncatedCounts: ['created'] }, { flow, now: NOW });
  assert.equal(c.canceled, 3);
  assert.equal(c.truncated, false);
  const old = Array.from({ length: 30 }, () => ({ createdAt: daysAgo(40) }));
  const v = inflow.assessInflowRatio(inflow.withBacklogHealth({ windowDays: 7, canceled: 0 }, { flow: { error: 'down' }, report: report({ ready: 2, cards: old }), now: NOW }));
  assert.equal(v.status, 'watch');
  assert.match(v.message, /could not be read this morning\. Watch: fewer than 10 cards are ready/);
  assert.match(v.message, /Stuck pile: 30 open cards older than 14 days \(last week's number unavailable\)/);
});
