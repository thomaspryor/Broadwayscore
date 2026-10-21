/**
 * Tests for scripts/lib/commercial-leads.js (BRO-5849): guess-grade leads the
 * recoupment model reads only when a record has no fact.
 * Run: node --test scripts/lib/commercial-leads.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { leadProblems, leadRange, pickLead, leadFills, runWithLeads, withLeadCenters } = require('./commercial-leads.js');
const { commercialRecordErrors } = require('./commercial-record-checks.js');
const { classifyTier } = require('./model-return-v2.js');
const { calculateRecoupment } = require('./recoupment-model.js');

const src = { quote: 'about $8 million to open the show', url: 'https://example.com/a' };
const lead = (o = {}) => ({ kind: 'capitalization', value: 8_000_000, sourceClass: 'reddit', confidence: 'low', source: src, date: '2026-10-01', ...o });

test('a well-formed lead has no problems; each defect is named', () => {
  assert.deepEqual(leadProblems(lead()), []);
  assert.deepEqual(leadProblems(lead({ value: undefined, low: 5e6, high: 6e6 })), []);
  assert.match(leadProblems(lead({ kind: 'cap' })).join(), /kind/);
  assert.match(leadProblems(lead({ sourceClass: 'rumor' })).join(), /sourceClass/);
  assert.match(leadProblems(lead({ confidence: 'high' })).join(), /confidence/);
  assert.match(leadProblems(lead({ value: undefined })).join(), /needs value/);
  assert.match(leadProblems(lead({ low: 1e6, high: 2e6 })).join(), /not both/);
  assert.match(leadProblems(lead({ value: undefined, low: 7e6, high: 6e6 })).join(), /exceed/);
  assert.match(leadProblems(lead({ value: 8 })).join(), /whole dollars/);
  assert.match(leadProblems(lead({ source: { quote: 'x', url: 'http://a' } })).join(), /quote.*url|url/s);
  assert.match(leadProblems(lead({ date: '10/01/2026' })).join(), /date/);
});

test('ranges: a ceiling is haircut, a floor lifts, a joint budget is split, plain values spread by confidence', () => {
  assert.deepEqual(leadRange(lead({ sourceClass: 'sec-ceiling-inferred-issuer', value: 5e6 })), { low: 3e6, center: 4e6, high: 5e6 });
  assert.equal(leadRange(lead({ sourceClass: 'floor', value: 5e6 })).center, 6e6);
  assert.equal(leadRange(lead({ sourceClass: 'joint', value: 3.5e6 })).center, 2.1e6);
  const low = leadRange(lead());
  const med = leadRange(lead({ confidence: 'medium' }));
  assert.equal(low.center, 8e6);
  assert.ok(low.high - low.low > med.high - med.low, 'low confidence widens more');
  assert.deepEqual(leadRange(lead({ value: undefined, low: 4e6, high: 6e6 })), { low: 4e6, center: 5e6, high: 6e6 });
});

test('pickLead prefers class, then confidence, then newest, and skips malformed leads', () => {
  const leads = [lead({ sourceClass: 'reddit', confidence: 'medium', value: 1 + 8e6 }), lead({ sourceClass: 'press-projection', value: 9e6 }), lead({ kind: 'bogus' })];
  assert.equal(pickLead(leads, 'capitalization').value, 9e6);
  assert.equal(pickLead(leads, 'weeklyRunningCost'), null);
  const same = [lead({ date: '2026-01-01', value: 7e6 }), lead({ date: '2026-09-01', value: 6e6 })];
  assert.equal(pickLead(same, 'capitalization').value, 6e6);
});

test('a fact always beats a lead; only missing inputs are filled', () => {
  const comm = { capitalization: 10e6, leads: [lead(), lead({ kind: 'weeklyRunningCost', value: 600_000 })] };
  const fills = leadFills(comm);
  assert.deepEqual(fills.map((f) => f.field), ['weeklyRunningCost']);
  assert.equal(withLeadCenters(comm).capitalization, 10e6);
  assert.equal(withLeadCenters(comm).weeklyRunningCost, 600_000);
  assert.equal(comm.weeklyRunningCost, undefined, 'the stored record is not mutated');
});

test('runWithLeads: no fill is a pass-through; a fill widens low/high and marks estimate-based', () => {
  const plain = { capitalization: 1 };
  let calls = 0;
  const run = (c) => { calls++; return { recoupmentPctLow: 100 - c.capitalization / 1e5, recoupmentPctCentral: 100 - c.capitalization / 1e5, recoupmentPctHigh: 110 - c.capitalization / 1e5, dataQuality: 'medium', warnings: [] }; };
  assert.equal(runWithLeads(plain, run).dataQuality, 'medium');
  assert.equal(calls, 1);
  const out = runWithLeads({ leads: [lead({ value: 8e6, confidence: 'low' })] }, run);
  assert.equal(out.dataQuality, 'estimate-based');
  assert.equal(out.recoupmentPctCentral, 100 - 80);
  assert.ok(out.recoupmentPctLow < 20, 'low corner is the high cap');
  assert.ok(out.recoupmentPctHigh > 30, 'high corner is the low cap');
  assert.equal(out.leadInputs[0].center, 8e6);
  assert.match(out.warnings.join(), /estimate from a reddit lead/);
});

test('classifyTier lets a capitalization lead stand in, but a record with no grosses stays ai-estimated', () => {
  const show = { openingDate: '2024-01-01', closingDate: '2025-01-01' };
  assert.equal(classifyTier(show, {}, { gross: 1 }), 'ai-estimated');
  assert.equal(classifyTier(show, { leads: [lead()] }, { gross: 1 }), 'weekly-model');
  assert.equal(classifyTier(show, { leads: [lead()] }, null), 'ai-estimated');
});

test('the real model runs on a lead-only record and reports an estimate-based range', () => {
  const show = { id: 'x-2024', slug: 'x', title: 'X', type: 'musical', openingDate: '2024-01-01', closingDate: '2024-07-01', previewsStartDate: '2023-12-10' };
  const weekly = {};
  for (let i = 0; i < 26; i++) weekly[new Date(Date.parse('2024-01-07') + i * 7 * 864e5).toISOString().slice(0, 10)] = { gross: 1_400_000, capacity: 0.95, attendance: 1300, perfs: 8 };
  const total = { gross: 26 * 1_400_000, weeks: 26 };
  const comm = { leads: [lead({ value: 12e6 }), lead({ kind: 'weeklyRunningCost', value: 750_000, confidence: 'medium' })] };
  const r = calculateRecoupment(show, comm, total, weekly);
  assert.ok(!r.error, r.error);
  assert.equal(r.dataQuality, 'estimate-based');
  assert.ok(r.recoupmentPctLow <= r.recoupmentPctCentral && r.recoupmentPctCentral <= r.recoupmentPctHigh);
  assert.equal(r.leadInputs.length, 2);
});

test('validator: leads shape is enforced and internal wording is refused', () => {
  const rec = { designation: 'TBD', leads: [lead()] };
  assert.deepEqual(commercialRecordErrors('k', rec, {}), []);
  assert.match(commercialRecordErrors('k', { designation: 'TBD', leads: 'x' }, {}).join(), /must be an array/);
  assert.match(commercialRecordErrors('k', { designation: 'TBD', leads: [lead({ kind: 'nope' })] }, {}).join(), /leads\[0\] kind/);
  assert.match(commercialRecordErrors('k', { designation: 'TBD', leads: [lead({ source: { quote: 'GPT deep research says $8M', url: 'https://a.b/c' } })] }, {}).join(), /internal wording/);
});

test('a lead fill drops reported-cost provenance and never survives as a fact', () => {
  const seen = [];
  runWithLeads({ costMethodology: 'trade-reported', capitalizationSource: 'maximum', leads: [lead({ value: 12e6 }), lead({ kind: 'weeklyRunningCost', value: 750_000 })] }, (c) => {
    seen.push(c);
    return { recoupmentPctLow: 10, recoupmentPctCentral: 20, recoupmentPctHigh: 30, warnings: [] };
  });
  assert.ok(seen.length > 1);
  for (const c of seen) { assert.equal(c.costMethodology, undefined); assert.equal(c.capitalizationSource, undefined); }
});

test('validator: a reddit.com link must be classed reddit', () => {
  const reddit = { quote: 'about $8 million to open the show', url: 'https://www.reddit.com/r/Broadway/comments/abc' };
  assert.match(commercialRecordErrors('k', { designation: 'TBD', leads: [lead({ source: reddit, sourceClass: 'press-projection' })] }, {}).join(), /sourceClass must be reddit/);
  assert.deepEqual(commercialRecordErrors('k', { designation: 'TBD', leads: [lead({ source: reddit, sourceClass: 'reddit' })] }, {}), []);
});

test('the likely-outcome label ignores an estimate-based run', () => {
  const { likelyOutcomeDesignation } = require('./commercial-designations.js');
  const e = { designation: 'Did Not Recoup', modelRecoupmentPct: [10, 20, 30] };
  assert.ok(likelyOutcomeDesignation(e));
  assert.equal(likelyOutcomeDesignation({ ...e, modelDataQuality: 'estimate-based' }), null);
});
