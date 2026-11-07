// BRO-6336: the daily health check fails over 25 pending entries or an oldest entry past 14 days. require()s the real code (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { pendingQueueHealth, heldRowsHealth, MAX_PENDING_ENTRIES, MAX_OLDEST_AGE_DAYS, MAX_HELD_AGE_DAYS } = require('../../scripts/lib/pending-health');

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
  const [res] = checkCommercialPendingQueue({ pendingFile: f, now: NOW }).filter((r) => r.name === 'Commercial pending-review queue');
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

// BRO-6471: held rows get their own health row, aged from when they were held, which files a worker card.
test('a held row is overdue after 7 days held, counted from autoApplyBlockedAt', () => {
  assert.equal(MAX_HELD_AGE_DAYS, 7);
  const row = (heldDays) => ({ researchedAt: day(400), autoApplyBlocked: 'recoupment claim: a person must confirm it', autoApplyBlockedAt: day(heldDays) });
  assert.equal(heldRowsHealth({ shows: { a: row(7) } }, NOW).ok, true, 'researched long ago but held only 7 days');
  const late = heldRowsHealth({ shows: { a: row(8), b: { researchedAt: day(1) } } }, NOW);
  assert.equal(late.ok, false);
  assert.deepEqual(late.overdue, [{ key: 'a', needs: 'recoupment claim: a person must confirm it', heldDays: 8 }]);
  assert.equal(heldRowsHealth({ shows: { u: { autoApplyBlocked: 'held' } } }, NOW).ok, false, 'an undated held row is overdue');
  assert.equal(pendingQueueHealth({ shows: { a: row(90) } }, NOW).ok, true, 'held rows never trip the queue row');
});

test('the held-rows health row names each overdue row and routes it to a worker card', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { checkCommercialPendingQueue, getPlaybookEntry } = require('../../scripts/health-check');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pq-')), 'p.json');
  fs.writeFileSync(f, JSON.stringify({ shows: { 'return-snapshot:x': { autoApplyBlocked: 'held for review: needs a person to edit commercial.json', autoApplyBlockedAt: day(10) } } }));
  const res = checkCommercialPendingQueue({ pendingFile: f, now: NOW }).find((r) => r.name === 'Commercial: rows held for a person');
  assert.equal(res.status, 'warn');
  assert.match(res.message, /return-snapshot:x \(10 days\): held for review/);
  const entry = getPlaybookEntry(res.name);
  assert.equal(entry.workerFixable, true);
  assert.equal(entry.workflow, undefined);
  assert.match(entry.ownerText, /Nothing is needed from you\.$/);
  assert.doesNotMatch(entry.workerInstruction, /(^|\n)\s*DECISION NEEDED/);
});
