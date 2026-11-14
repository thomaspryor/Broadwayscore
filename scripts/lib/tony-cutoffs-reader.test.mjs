import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readTonyCutoffs, seasonsBefore } = require('./tony-cutoffs-reader.js');

test('reads the real windows from tony-cutoffs.ts', () => {
  const c = readTonyCutoffs();
  const s2526 = c.find(x => x.label === '2025-26');
  assert.deepEqual([s2526.start, s2526.end], ['2025-04-28', '2026-04-26']);
  assert.equal(c.find(x => x.label === '2022-23').start, '2022-05-05');
});

test('consecutive seasons leave no gap day between them', () => {
  const c = readTonyCutoffs().filter(x => x.label >= '2021-22');
  for (let i = 1; i < c.length; i++) {
    const next = new Date(`${c[i - 1].end}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    assert.equal(c[i].start, next.toISOString().slice(0, 10), `${c[i - 1].label} -> ${c[i].label}`);
  }
});

test('seasonsBefore returns the prior seasons, most recent first', () => {
  assert.deepEqual(seasonsBefore('2026-27', 4).map(x => x.label), ['2025-26', '2024-25', '2023-24', '2022-23']);
  assert.throws(() => seasonsBefore('1900-01', 4));
});
