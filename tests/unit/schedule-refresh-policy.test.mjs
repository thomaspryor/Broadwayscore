import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideScheduleFailure } = require('../../scripts/lib/schedule-refresh-policy.js');
const now = new Date('2026-11-10T12:00:00Z');
const mk = (weeks, n = 12) => ({ lastUpdated: '2026-11-10T00:00:00Z', shows: Object.fromEntries(Array.from({ length: n }, (_, i) => ['s' + i, { weeks: Object.fromEntries(weeks.map(w => [w, []])) }])) });

test('fresh multi-week file reaching 3+ weeks ahead: blip is not fatal', () => {
  assert.equal(decideScheduleFailure(mk(['20261109', '20261130']), now).fatal, false);
});
test('file whose weeks are all near/in the past is fatal even with a fresh lastUpdated', () => {
  assert.equal(decideScheduleFailure(mk(['20261026', '20261109', '20261116']), now).fatal, true);
});
test('single-week file is fatal', () => {
  assert.equal(decideScheduleFailure(mk(['20261130']), now).fatal, true);
});
test('missing/garbled file is fatal', () => {
  assert.equal(decideScheduleFailure(null, now).fatal, true);
  assert.equal(decideScheduleFailure({ shows: {} }, now).fatal, true);
});
test('scraper wires the policy (no bare exitCode=1 on 0-future-weeks)', () => {
  const src = fs.readFileSync(new URL('../../scripts/scrape-lottery-rush.js', import.meta.url), 'utf8');
  const i = src.indexOf('if (futureWeeksFetched === 0)');
  const block = src.slice(i, src.indexOf('if (dryRun)', i));
  assert.match(block, /decideScheduleFailure\(/);
});
test('one long-run show with far-future weeks cannot mask a dead refresh', () => {
  const e = mk(['20261109', '20261116']);
  e.shows.s0.weeks['20280619'] = []; e.shows.s0.weeks['20280612'] = [];
  assert.equal(decideScheduleFailure(e, now).fatal, true);
});
