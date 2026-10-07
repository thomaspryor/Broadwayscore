// BRO-4487: the open P0/P1 outcome number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessPriorityQueue, formatSummary } = require('./priority-queue-health.js');

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const issue = (identifier, priority, ageH, extra = {}) => ({
  identifier, title: extra.title || identifier, priority, createdAt: hoursAgo(ageH), state: { type: extra.stateType || 'backlog' },
});

test('counts P0/P1 by the field and flags SLA breaches (24h for P0, 7d for P1)', () => {
  const r = assessPriorityQueue([
    issue('BRO-1', 1, 2), issue('BRO-2', 1, 30),
    issue('BRO-3', 2, 24), issue('BRO-4', 2, 200),
    issue('BRO-5', 3, 900),
  ], NOW);
  assert.equal(r.p0Open, 2);
  assert.equal(r.p0Overdue, 1);
  assert.equal(r.oldestP0Hours, 30);
  assert.equal(r.p1Open, 2);
  assert.equal(r.p1Overdue, 1);
  assert.equal(r.totalOpen, 5, 'total counts every priority, so demoting a card never lowers it');
  assert.equal(r.healthy, false);
  assert.deepEqual(r.oldestP0.map((i) => i.identifier), ['BRO-2']);
});

test('an unset priority with a P0:/P1: title counts as P0/P1, the same way the dispatcher reads it', () => {
  const r = assessPriorityQueue([issue('BRO-6', 0, 50, { title: 'P0: site down' }), issue('BRO-7', 0, 1, { title: 'P1: x' })], NOW);
  assert.equal(r.p0Open, 1);
  assert.equal(r.p1Open, 1);
  assert.equal(r.p0Overdue, 1);
});

test('an explicit Medium/Low priority is not re-promoted by a P1: title', () => {
  const r = assessPriorityQueue([issue('BRO-8', 3, 500, { title: 'P1: demoted' })], NOW);
  assert.equal(r.p1Open, 0);
  assert.equal(r.totalOpen, 1);
});

test('closed, canceled and duplicate issues are ignored', () => {
  const r = assessPriorityQueue([
    issue('BRO-9', 1, 100, { stateType: 'completed' }),
    issue('BRO-10', 1, 100, { stateType: 'canceled' }),
    issue('BRO-11', 2, 500, { stateType: 'duplicate' }),
  ], NOW);
  assert.equal(r.totalOpen, 0);
  assert.equal(r.healthy, true);
  assert.equal(r.oldestP0Hours, null);
});

test('formatSummary reads as one plain sentence', () => {
  const r = assessPriorityQueue([issue('BRO-1', 1, 72), issue('BRO-3', 2, 200)], NOW);
  assert.equal(formatSummary(r), '1 P0 open (1 older than 24h, oldest 3d); 1 P1 open (1 older than 7d); 2 open issues of any priority.');
  assert.match(formatSummary(assessPriorityQueue([], NOW)), /^0 P0 open; 0 P1 open/);
});

// ── BRO-4510: started-zombie sweep leftovers ──
test('summarizeZombieLeftovers: latest row per card; card-pass and closed cards drop out', async () => {
  const { createRequire } = await import('node:module');
  const { summarizeZombieLeftovers, formatZombieLeftovers } = createRequire(import.meta.url)('./priority-queue-health.js');
  const rows = [
    { ts: '2026-10-01T00:00:00Z', cardId: 'BRO-1', event: 'card-leave', reason: 'no-safe-verify' },
    { ts: '2026-10-02T00:00:00Z', cardId: 'BRO-1', event: 'card-pass', action: 'done' },
    { ts: '2026-10-01T00:00:00Z', cardId: 'BRO-2', event: 'card-fail', reason: 'human-comment-recent' },
    { ts: '2026-10-01T00:00:00Z', cardId: 'BRO-3', event: 'card-leave', reason: 'no-safe-verify' },
  ];
  const s = summarizeZombieLeftovers(rows, ['BRO-1', 'BRO-2']);
  assert.deepEqual(s.cards, ['BRO-2']);
  assert.match(formatZombieLeftovers(s), /1 cards left for a person \(human-comment-recent 1\): BRO-2/);
  assert.match(formatZombieLeftovers(summarizeZombieLeftovers([], [])), /no cards left/);
});
