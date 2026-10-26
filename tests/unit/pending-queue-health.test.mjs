// BRO-6336: the daily health check fails over 25 pending entries or an oldest entry past 14 days. require()s the real code (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { pendingQueueHealth, MAX_PENDING_ENTRIES, MAX_OLDEST_AGE_DAYS } = require('../../scripts/lib/pending-health');

const NOW = Date.parse('2026-10-26T12:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const queue = (n, ageDays) => ({ shows: Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { researchedAt: day(ageDays) }])) });

test('limits are 25 entries and 14 days', () => {
  assert.equal(MAX_PENDING_ENTRIES, 25);
  assert.equal(MAX_OLDEST_AGE_DAYS, 14);
});

test('exactly at the limits passes, one over fails', () => {
  assert.equal(pendingQueueHealth(queue(25, 14), NOW).ok, true);
  const tooMany = pendingQueueHealth(queue(26, 1), NOW);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.problems[0], /26 entries/);
  const tooOld = pendingQueueHealth(queue(3, 15), NOW);
  assert.equal(tooOld.ok, false);
  assert.match(tooOld.problems[0], /15 days/);
});

test('an empty queue passes', () => {
  assert.equal(pendingQueueHealth({ shows: {} }, NOW).ok, true);
});

test('the health check reports the same verdict through the real check', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { checkCommercialPendingQueue } = require('../../scripts/health-check');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pq-')), 'p.json');
  fs.writeFileSync(f, JSON.stringify(queue(30, 20)));
  const [res] = checkCommercialPendingQueue({ pendingFile: f, now: NOW });
  assert.equal(res.status, 'error');
  assert.match(res.message, /Over the limit/);
});

test('rows held for a person do not count against the queue limits', () => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const shows = { a: { researchedAt: old, autoApplyBlocked: 'needs a person' } };
  for (let i = 0; i < 30; i++) shows[`h${i}`] = { researchedAt: old, autoApplyBlocked: 'held' };
  assert.equal(pendingQueueHealth({ shows }).ok, true);
  shows.fresh = { researchedAt: old };
  assert.equal(pendingQueueHealth({ shows }).ok, false);
});
