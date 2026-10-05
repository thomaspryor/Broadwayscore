// BRO-4666: the weekly commercial update must never let a Reddit estimate
// replace a reported weekly cost. It did, and kept the "trade-reported" label
// on the Reddit number, which is how /biz came to show estimates as reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// applyChanges writes commercial.json unless --dry-run; each test file runs in
// its own process, so this only affects this file.
process.argv.push('--dry-run');
const require = createRequire(import.meta.url);
const { filterByConfidence, applyChanges } = require('../../scripts/update-commercial-data');

const redditCost = (slug, newValue) => ({
  slug, field: 'weeklyRunningCost', oldValue: null, newValue, confidence: 'high',
  source: 'Reddit Grosses Analysis (u/Boring_Waltz_9545)',
});

function commercialWith(record) {
  return { _meta: {}, shows: { 'some-show': { designation: 'TBD', ...record } } };
}

test('a Reddit cost is skipped when the record holds a reported weekly cost', () => {
  for (const m of ['trade-reported', 'sec-filing', 'producer-confirmed']) {
    const data = commercialWith({ weeklyRunningCost: 480577, costMethodology: m });
    const { applied, skipped } = filterByConfidence([redditCost('some-show', 650000)], data);
    assert.equal(applied.length, 0, m);
    assert.match(skipped[0].skipReason, /reported weekly cost/, m);
  }
});

test('a Reddit cost still fills a gap or replaces an estimate', () => {
  for (const record of [{}, { weeklyRunningCost: 600000, costMethodology: 'industry-estimate' }, { weeklyRunningCost: 600000, costMethodology: 'reddit-standard' }]) {
    const { applied } = filterByConfidence([redditCost('some-show', 650000)], commercialWith(record));
    assert.equal(applied.length, 1, JSON.stringify(record));
  }
});

test('a trade-press cost may still update a reported figure', () => {
  const data = commercialWith({ weeklyRunningCost: 500000, costMethodology: 'trade-reported' });
  const change = { ...redditCost('some-show', 550000), source: 'Variety, Oct 2026' };
  assert.equal(filterByConfidence([change], data).applied.length, 1);
});

test('an applied Reddit cost is labeled reddit-standard and flagged as an estimate', () => {
  const data = commercialWith({ weeklyRunningCost: 600000, costMethodology: 'deep-research' });
  const n = applyChanges([redditCost('some-show', 650000)], [], data, undefined);
  assert.equal(n, 1);
  const rec = data.shows['some-show'];
  assert.equal(rec.weeklyRunningCost, 650000);
  assert.equal(rec.costMethodology, 'reddit-standard');
  assert.equal(rec.isEstimate.weeklyRunningCost, true);
});
