import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { mergeDays } = createRequire(import.meta.url)('./merge-daily-totals.js');

test('union of days, ours wins a shared day', () => {
  const r = mergeDays({ days: { d0: { n: 9 }, d2: { n: 5 } } }, { days: { d2: { n: 7 }, d3: { n: 2 } } });
  assert.deepEqual(r.days, { d0: { n: 9 }, d2: { n: 5 }, d3: { n: 2 } });
});

test('prunes to the writer keep-days window, newest kept', () => {
  const ours = { days: {} };
  const theirs = { days: {} };
  for (let i = 1; i <= 20; i++) (i % 2 ? ours : theirs).days[`2026-11-${String(i).padStart(2, '0')}`] = { n: i };
  const keys = Object.keys(mergeDays(ours, theirs).days);
  assert.equal(keys.length, 15);
  assert.equal(keys[keys.length - 1], '2026-11-20');
});
