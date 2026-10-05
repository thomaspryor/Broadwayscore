// BRO-4666: Boring Waltz weekly costs fill gaps and replace our own
// estimates, never a reported figure (owner decision 2026-10-05).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decideWaltzCostWrite,
  waltzCostPatch,
  isReportedWeeklyCost,
  REPORTED_COST_METHODOLOGIES,
  OUR_ESTIMATE_METHODOLOGIES,
  WALTZ_METHODOLOGY,
} = require('./waltz-cost-gap-fill.js');
const { VALID_COST_METHODOLOGIES, commercialRecordErrors } = require('./commercial-record-checks.js');

test('every methodology it names is one validate-data accepts', () => {
  for (const m of [...REPORTED_COST_METHODOLOGIES, ...OUR_ESTIMATE_METHODOLOGIES, WALTZ_METHODOLOGY]) {
    assert.ok(VALID_COST_METHODOLOGIES.includes(m), m);
  }
  // Each valid methodology falls in exactly one bucket, so a new one cannot
  // slip through as overwritable without a decision here.
  for (const m of VALID_COST_METHODOLOGIES) {
    const buckets = [REPORTED_COST_METHODOLOGIES.has(m), OUR_ESTIMATE_METHODOLOGIES.has(m), m === WALTZ_METHODOLOGY];
    assert.equal(buckets.filter(Boolean).length, 1, `${m} must be reported, ours, or his`);
  }
});

test('fills a missing weekly cost, even on a record with a reported capitalization', () => {
  assert.equal(decideWaltzCostWrite({ weeklyRunningCost: null }, 650000).write, true);
  assert.equal(decideWaltzCostWrite({ costMethodology: 'trade-reported', capitalization: 22000000 }, 650000).write, true);
});

test('never replaces a reported figure', () => {
  for (const m of ['trade-reported', 'sec-filing', 'producer-confirmed']) {
    const d = decideWaltzCostWrite({ weeklyRunningCost: 500000, costMethodology: m }, 900000);
    assert.equal(d.write, false, m);
    assert.match(d.reason, /reported/);
    assert.equal(isReportedWeeklyCost({ weeklyRunningCost: 500000, costMethodology: m }), true);
  }
});

test('replaces our own estimates, whatever the difference', () => {
  for (const m of ['industry-estimate', 'deep-research']) {
    assert.equal(decideWaltzCostWrite({ weeklyRunningCost: 650000, costMethodology: m }, 660000).write, true, m);
  }
});

test('refreshes his own earlier figure only past 10%', () => {
  const rec = { weeklyRunningCost: 800000, costMethodology: 'reddit-standard' };
  assert.equal(decideWaltzCostWrite(rec, 850000).write, false);
  assert.equal(decideWaltzCostWrite(rec, 900000).write, true);
});

test('keeps a cost with no named method, and ignores junk input', () => {
  assert.equal(decideWaltzCostWrite({ weeklyRunningCost: 700000 }, 900000).write, false);
  assert.equal(decideWaltzCostWrite(undefined, 900000).write, false);
  assert.equal(decideWaltzCostWrite({}, 0).write, false);
  assert.equal(decideWaltzCostWrite({}, NaN).write, false);
});

test('never writes an implausible weekly cost (a misread like "$1 million" read as $1)', () => {
  for (const cost of [1, 850, 99_999, 5_000_001, 1_000_000_000]) {
    const d = decideWaltzCostWrite({ weeklyRunningCost: null }, cost);
    assert.equal(d.write, false, String(cost));
    assert.match(d.reason, /implausible/);
  }
  assert.equal(decideWaltzCostWrite({ weeklyRunningCost: null }, 100_000).write, true);
  assert.equal(decideWaltzCostWrite({ weeklyRunningCost: null }, 5_000_000).write, true);
});

test('the patch flags an estimate, names the post, stamps the record, and keeps other flags', () => {
  const rec = { weeklyRunningCost: null, isEstimate: { capitalization: true } };
  const now = new Date('2026-10-05T12:00:00Z');
  const patch = waltzCostPatch(rec, {
    cost: 650000,
    postTitle: 'Grosses Analysis: Week Ending 9/27',
    postDate: '2026-09-29',
    permalink: '/r/Broadway/comments/abc/grosses_analysis/',
  }, now);
  assert.deepEqual(patch.isEstimate, { capitalization: true, weeklyRunningCost: true });
  assert.equal(patch.costMethodology, 'reddit-standard');
  assert.equal(patch.lastUpdated, '2026-10-05T12:00:00.000Z');
  assert.match(patch.weeklyRunningCostSource, /^Estimate by u\/Boring_Waltz_9545 on r\/Broadway, "Grosses Analysis: Week Ending 9\/27" \(2026-09-29\) https:\/\/www\.reddit\.com\/r\/Broadway\//);
  assert.equal(rec.isEstimate.weeklyRunningCost, undefined, 'does not mutate the record');
  // A patched record passes the same checks validate-data runs.
  const patched = { designation: 'TBD', ...rec, ...patch };
  assert.deepEqual(commercialRecordErrors('some-show', patched, {}), []);
});
