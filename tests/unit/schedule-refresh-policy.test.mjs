import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideScheduleFailure } = require('../../scripts/lib/schedule-refresh-policy.js');
const now = new Date('2026-11-10T12:00:00Z');
const mk = (iso, weeks) => ({ lastUpdated: iso, shows: { a: { weeks: Object.fromEntries(weeks.map(w => [w, []])) } } });

test('fresh multi-week file: blip is not fatal', () => {
  assert.equal(decideScheduleFailure(mk('2026-11-09T10:00:00Z', ['1', '2']), now).fatal, false);
});
test('stale file is fatal', () => {
  assert.equal(decideScheduleFailure(mk('2026-10-30T10:00:00Z', ['1', '2']), now).fatal, true);
});
test('single-week file is fatal', () => {
  assert.equal(decideScheduleFailure(mk('2026-11-09T10:00:00Z', ['1']), now).fatal, true);
});
test('missing/garbled file is fatal', () => {
  assert.equal(decideScheduleFailure(null, now).fatal, true);
  assert.equal(decideScheduleFailure({ lastUpdated: 'x' }, now).fatal, true);
});
test('scraper wires the policy (no bare exitCode=1 on 0-future-weeks)', () => {
  const src = fs.readFileSync(new URL('../../scripts/scrape-lottery-rush.js', import.meta.url), 'utf8');
  const i = src.indexOf('if (futureWeeksFetched === 0)');
  const block = src.slice(i, src.indexOf('if (dryRun)', i));
  assert.match(block, /decideScheduleFailure\(/);
});
