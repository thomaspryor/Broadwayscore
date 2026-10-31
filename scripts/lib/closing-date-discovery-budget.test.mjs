// BRO-5261 (BRO-3340 retro-review): audit-opening-dates' loop-head reserve did
// not bound a candidate, because discoverAnnouncedDate's own checks used
// exceeded() and could start a ~2.5 min fetchPage() chain with seconds left.
// With minRemainingMs it stops while that much budget remains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { discoverAnnouncedDate } = require('./closing-date-discovery.js');
const { createRunBudget } = require('./run-budget.js');

test('a budget with less than minRemainingMs left stops before the SERP call', async () => {
  const budget = createRunBudget(1); // 1 min left, well under the 2.5 min reserve
  const logs = [];
  const r = await discoverAnnouncedDate('Some Show', 'opening', { log: (m) => logs.push(m) }, budget, 150_000);
  assert.equal(r, null);
  assert.ok(logs.some((l) => /time budget \(1 min\) reached — skipping/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /SERP:/.test(l)), 'no SERP query was issued');
});

test('a budget stub with only exceeded() still works (minRemainingMs ignored)', async () => {
  const logs = [];
  const r = await discoverAnnouncedDate('Some Show', 'opening', { log: (m) => logs.push(m) }, { exceeded: () => true, minutes: 5 }, 150_000);
  assert.equal(r, null);
  assert.ok(logs.some((l) => /reached — skipping/.test(l)));
});
