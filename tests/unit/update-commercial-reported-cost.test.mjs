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
const { filterByConfidence, applyChanges, extractSourceType } = require('../../scripts/update-commercial-data');

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

// The prompt asks for sources as "Section X: ..."; his post is Section C and
// its comments Section D, neither of which says "reddit" (review finding).
test('a "Section C/D" cost from his post is skipped over a reported cost too', () => {
  const data = commercialWith({ weeklyRunningCost: 1000000, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Broadway Journal (Dec 16, 2025)' });
  for (const source of ['Section C: Grosses Analysis weeklyCost=$650000', 'Section D: comment estimates $700k/week', 'Section B: box office math']) {
    const { applied, skipped } = filterByConfidence([{ ...redditCost('some-show', 650000), source }], data);
    assert.equal(applied.length, 0, source);
    assert.match(skipped[0].skipReason, /trade or SEC source/, source);
  }
});

test('a new weekly cost drops the old citation and takes its own basis', () => {
  const cited = { weeklyRunningCost: 1000000, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Broadway Journal (Dec 16, 2025)', isEstimate: { capitalization: true } };
  const cases = [
    ['Section F: Deadline reports $1.1M weekly', 'trade-reported', false],
    ['Section H: SEC Form D', 'sec-filing', false],
  ];
  for (const [source, methodology, estimate] of cases) {
    const data = commercialWith({ ...cited, isEstimate: { ...cited.isEstimate } });
    applyChanges([{ ...redditCost('some-show', 1100000), source }], [], data, undefined);
    const rec = data.shows['some-show'];
    assert.equal(rec.costMethodology, methodology, source);
    assert.equal(rec.isEstimate.weeklyRunningCost, estimate, source);
    assert.equal(rec.isEstimate.capitalization, true, 'keeps other flags');
    assert.equal(rec.weeklyRunningCostSource, null, 'the old citation described the old figure');
  }
  // An unsourced model figure filling a gap is our own estimate.
  const gap = commercialWith({});
  applyChanges([{ ...redditCost('some-show', 700000), source: 'Section B: box office math' }], [], gap, undefined);
  assert.equal(gap.shows['some-show'].costMethodology, 'industry-estimate');
  assert.equal(gap.shows['some-show'].isEstimate.weeklyRunningCost, true);
});

test('a capitalization change never labels an existing weekly cost, and "Section" is not SEC', () => {
  const withCost = commercialWith({ weeklyRunningCost: 700000 });
  applyChanges([{ slug: 'some-show', field: 'capitalization', oldValue: null, newValue: 20000000, confidence: 'high', source: 'Section F: Deadline' }], [], withCost, undefined);
  assert.equal(withCost.shows['some-show'].costMethodology, undefined);

  const noCost = commercialWith({});
  applyChanges([{ slug: 'some-show', field: 'capitalization', oldValue: null, newValue: 20000000, confidence: 'high', source: 'Section F: Deadline' }], [], noCost, undefined);
  assert.equal(noCost.shows['some-show'].costMethodology, 'trade-reported');
});

test('extractSourceType rates "Section X:" sources by what they are', () => {
  assert.equal(extractSourceType('Section C: Grosses Analysis weeklyCost=$650000'), 'Reddit Grosses Analysis');
  assert.equal(extractSourceType('Section D: u/someone'), 'Reddit comment');
  assert.equal(extractSourceType('Section E: r/Broadway thread'), 'Reddit comment');
  assert.equal(extractSourceType('Section F: Deadline article'), 'Deadline');
  assert.equal(extractSourceType('Section H: SEC Form D'), 'SEC Form D');
  assert.equal(extractSourceType('Section B: box office math'), 'estimate');
});
