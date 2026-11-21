// BRO-6336: the weekly backlog line. require()s the real module (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { pendingBacklogStats, formatBacklogLine } = require('../../scripts/lib/pending-review-backlog');

const NOW = Date.parse('2026-10-26T00:00:00Z');

test('counts entries and finds the oldest by researchedAt', () => {
  const pending = { shows: {
    a: { researchedAt: '2026-10-20T00:00:00Z' },
    b: { researchedAt: '2026-06-27T00:00:00Z' },
    c: { researchedAt: '2026-09-01T00:00:00Z' },
  } };
  const s = pendingBacklogStats(pending, NOW);
  assert.equal(s.count, 3);
  assert.equal(s.oldestKey, 'b');
  assert.equal(s.oldestAgeDays, 121);
  assert.match(formatBacklogLine(s), /3 entries, oldest 121 days \(b, 2026-06-27\)/);
});

test('empty and undated backlogs', () => {
  assert.equal(formatBacklogLine(pendingBacklogStats({ shows: {} }, NOW)), 'Pending-review backlog: 0 entries.');
  assert.equal(formatBacklogLine(pendingBacklogStats({}, NOW)), 'Pending-review backlog: 0 entries.');
  const s = pendingBacklogStats({ shows: { x: {}, y: { detectedAt: '2026-10-25T00:00:00Z' } } }, NOW);
  assert.equal(s.oldestKey, 'y');
  assert.match(formatBacklogLine(s), /2 entries, oldest 1 days \(y, 2026-10-25\), 1 undated/);
  assert.match(formatBacklogLine(pendingBacklogStats({ shows: { x: {} } }, NOW)), /oldest age unknown/);
});
