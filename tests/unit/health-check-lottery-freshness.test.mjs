// BRO-5261 (BRO-901 retro): lottery-rush.json freshness reads lastCheckedAt
// (stamped on every full check) before lastUpdated (moves only when a policy
// changed), with thresholds that fit the Mon+Thu cron's 96h gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { freshnessValue, FRESHNESS_CHECKS } = require('../../scripts/health-check.js');

test('freshnessValue: first present field wins, nested paths still work', () => {
  assert.equal(freshnessValue({ lastCheckedAt: 'b', lastUpdated: 'a' }, ['lastCheckedAt', 'lastUpdated']), 'b');
  assert.equal(freshnessValue({ lastUpdated: 'a' }, ['lastCheckedAt', 'lastUpdated']), 'a');
  assert.equal(freshnessValue({ _meta: { lastUpdated: 'x' } }, '_meta.lastUpdated'), 'x');
  assert.equal(freshnessValue({}, ['lastCheckedAt', 'lastUpdated']), undefined);
});

test('lottery-rush row: lastCheckedAt first, never alarms inside one Mon+Thu gap', () => {
  const row = FRESHNESS_CHECKS.find((r) => r.file === 'lottery-rush.json');
  assert.deepEqual([].concat(row.field), ['lastCheckedAt', 'lastUpdated']);
  assert.ok(row.warnH > 96, `warnH ${row.warnH}h must exceed the 96h Thu->Mon gap`);
  assert.ok(row.errorH > row.warnH);
});
