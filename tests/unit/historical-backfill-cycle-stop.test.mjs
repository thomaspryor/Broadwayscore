// BRO-7551: the yield probe that decides whether repeat backfill cycles are worth their cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { measureYield } = require('../../scripts/historical-backfill-next.js');

const DAY = 86400000;

test('yield: revisited shows with new reviews beat the control, verdict keep', () => {
  const end = Date.UTC(2026, 10, 15);
  const cursor = { next: 48, updatedAt: new Date(end).toISOString() };
  const ids = Array.from({ length: 96 }, (_, i) => `s${i}`);
  const fresh = [end - DAY, end - 3 * DAY];
  const first = {};
  ids.forEach((id, i) => { first[id] = i < 48 && i % 2 === 0 ? [0, ...fresh] : [0]; });
  const r = measureYield(ids, cursor, first, 24);
  assert.equal(r.visited.shows, 48);
  assert.equal(r.control.shows, 48);
  assert.ok(r.visited.newSinceVisit > 0);
  assert.equal(r.control.newSinceCycleStart, 0);
  assert.equal(r.verdict, 'keep');
});

test('yield: no new reviews anywhere is low-yield (stop-at-cycle-end case)', () => {
  const cursor = { next: 24, updatedAt: new Date(Date.UTC(2026, 10, 15)).toISOString() };
  const ids = Array.from({ length: 48 }, (_, i) => `s${i}`);
  const first = Object.fromEntries(ids.map((id) => [id, [0]]));
  assert.equal(measureYield(ids, cursor, first, 24).verdict, 'low-yield');
});

test('yield: cycle start is (runs - 1) days before the last run, and a review before a show\'s visit day does not count', () => {
  const end = Date.UTC(2026, 10, 15);
  const cursor = { next: 48, updatedAt: new Date(end).toISOString() };
  const ids = Array.from({ length: 96 }, (_, i) => `s${i}`);
  const r0 = measureYield(ids, cursor, {}, 24);
  assert.equal(r0.cycleStart, new Date(end - DAY).toISOString().slice(0, 10));
  // s30 is visited on day 2 of the cycle (cycleStart + 1 day); a review one hour before that visit must not count.
  const visit = end - DAY + DAY;
  const first = { s30: [visit - 3600000, visit + 3600000], s60: [end - 3600000] };
  const r = measureYield(ids, cursor, first, 24);
  assert.equal(r.visited.newSinceVisit, 1);
  assert.equal(r.control.newSinceCycleStart, 1);
});

test('yield: result does not depend on the clock time of the last run', () => {
  const ids = Array.from({ length: 96 }, (_, i) => `s${i}`);
  const first = { s30: [Date.UTC(2026, 10, 14, 8)], s60: [Date.UTC(2026, 10, 14, 8)] };
  const at = (h) => measureYield(ids, { next: 48, updatedAt: new Date(Date.UTC(2026, 10, 15, h)).toISOString() }, first, 24);
  assert.deepEqual(at(0).visited, at(23).visited);
});

test('yield: cursor at 0 (just wrapped) reports no-data, not a future cycle start', () => {
  const r = measureYield(['a'], { next: 0, updatedAt: new Date().toISOString() }, { a: [0] }, 24);
  assert.equal(r.verdict, 'no-data');
});

test('yield: a control rate equal to the visited rate is low-yield (threshold is strict 2x)', () => {
  const end = Date.UTC(2026, 10, 15);
  const ids = Array.from({ length: 48 }, (_, i) => `s${i}`);
  const first = Object.fromEntries(ids.map((id) => [id, [end]]));
  assert.equal(measureYield(ids, { next: 24, updatedAt: new Date(end).toISOString() }, first, 24).verdict, 'low-yield');
});
