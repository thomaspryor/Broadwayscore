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
  isPlausibleWeeklyCost,
  citedSections,
  costSourceBasis,
  methodologyForCostSource,
  isReportedSource,
  isPrintableReportedCitation,
  isCitedReportedWeeklyCost,
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

test('isPlausibleWeeklyCost bounds the same range decideWaltzCostWrite enforces', () => {
  assert.equal(isPlausibleWeeklyCost(650000), true);
  for (const cost of [99_999, 5_000_001, 475_550_000, NaN, undefined]) assert.equal(isPlausibleWeeklyCost(cost), false, String(cost));
});

test('costSourceBasis reads the update prompt\'s "Section X:" sources', () => {
  // The weekly update's model writes sources as "Section X: ...": C/D are his
  // grosses post and its comments, E other Reddit threads, F trade press, H SEC.
  const cases = [
    ['Section C: Grosses Analysis weeklyCost=$650000', 'reddit'],
    ['Section D: u/someone says $700k a week', 'reddit'],
    ['Section E: r/Broadway thread', 'reddit'],
    ['Reddit Grosses Analysis (u/Boring_Waltz_9545)', 'reddit'],
    ['Section F: Deadline reports $480k weekly costs', 'trade'],
    ['Variety, Oct 2026', 'trade'],
    ['Section H: SEC Form D filing', 'sec'],
    ['SEC filing (2024)', 'sec'],
    ['Section F: Deadline, echoed on Reddit', 'reddit'],
    ['Section B: box office math', null],
    ['Section A: current data', null],
    ['', null],
    [undefined, null],
  ];
  for (const [source, basis] of cases) assert.equal(costSourceBasis(source), basis, String(source));
  // "Section" contains "sec": none of these is an SEC filing.
  for (const s of ['Section A', 'Section B', 'Section C', 'Section F: Variety', 'second-hand estimate']) {
    assert.notEqual(costSourceBasis(s), 'sec', s);
  }
});

test('costSourceBasis reads plural and mixed section citations', () => {
  const cases = [
    // Any Reddit section makes the figure his (an estimate).
    ['Sections C and F: Deadline echoes the grosses post', 'reddit'],
    ['Sections F, D: trade and comments', 'reddit'],
    ['Sections C-E: Reddit consensus', 'reddit'],
    ['Sections B-F', 'reddit'],
    // Only trade press and SEC sections: reported.
    ['Sections F and H: Deadline and Form D agree', 'sec'],
    ['Sections F & F: two Deadline pieces', 'trade'],
    ['Section F; Section F: Variety', 'trade'],
    // Our own data or math beside trade press is inference.
    ['Sections A and F: current data plus Variety', null],
    ['Section B: box office math, consistent with Variety', null],
    ['Section B: Deadline-style estimate', null],
    ['Sections F, G', null],
  ];
  for (const [source, basis] of cases) assert.equal(costSourceBasis(source), basis, source);
  assert.deepEqual([...citedSections('Sections C, D and F: x')].sort(), ['C', 'D', 'F']);
  assert.deepEqual([...citedSections('Sections C-E')].sort(), ['C', 'D', 'E']);
  assert.deepEqual([...citedSections('Sections C-D-E')].sort(), ['C', 'D', 'E']);
  // "and" is a separator, never section A; "Section Data" cites nothing.
  assert.deepEqual([...citedSections('Sections F and H')].sort(), ['F', 'H']);
  assert.equal(citedSections('Section Data from Variety').size, 0);
  assert.equal(citedSections('second section').size, 0);
  // Lowercase prose after a section is not more sections (review finding).
  for (const s of ['Section F - a Deadline article', 'Section F, e.g. Deadline', 'Section F, b/c Deadline', 'Section F and a Variety report']) {
    assert.deepEqual([...citedSections(s)], ['F'], s);
    assert.equal(costSourceBasis(s), 'trade', s);
  }
  assert.equal(costSourceBasis('Section H, a Form D filed'), 'sec');
  assert.equal(costSourceBasis('Section F, h/t Variety'), 'trade');
});

test('only a trade or SEC source counts as reported', () => {
  assert.equal(methodologyForCostSource('Section C: Grosses Analysis'), WALTZ_METHODOLOGY);
  assert.equal(methodologyForCostSource('Section B: box office math'), 'industry-estimate');
  assert.equal(methodologyForCostSource('Section H: SEC Form D'), 'sec-filing');
  assert.equal(methodologyForCostSource('Section F: Deadline'), 'trade-reported');
  assert.equal(isReportedSource('Section C: Grosses Analysis'), false);
  assert.equal(isReportedSource('Section B: box office math'), false);
  assert.equal(isReportedSource('Sections B and F: Variety'), false);
  assert.equal(isReportedSource('Section F: Deadline'), true);
  assert.equal(isReportedSource('Section H: SEC Form D'), true);
});

test('a printable citation names the outlet, with no section letter or research wording', () => {
  for (const ok of ['Deadline (Oct 3, 2026)', 'SEC Form D filing (2025)', 'The New York Times, Sept 2026']) {
    assert.equal(isPrintableReportedCitation(ok), true, ok);
  }
  for (const bad of ['Section F: Deadline', 'Sections F and H', 'Variety (GPT Deep Research)', 'Reddit, citing Variety', 'industry estimate', 'Producer said so', '', '  ', null, 650000]) {
    assert.equal(isPrintableReportedCitation(bad), false, String(bad));
  }
});

test('isCitedReportedWeeklyCost needs a reported method, no estimate flag, and a printable source', () => {
  const cited = { weeklyRunningCost: 480577, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Forbes (Nov 17, 2025)' };
  assert.equal(isCitedReportedWeeklyCost(cited), true);
  assert.equal(isCitedReportedWeeklyCost({ ...cited, weeklyRunningCostSource: null }), false);
  assert.equal(isCitedReportedWeeklyCost({ ...cited, weeklyRunningCostSource: '  ' }), false);
  assert.equal(isCitedReportedWeeklyCost({ ...cited, weeklyRunningCostSource: 'SEC filings (GPT Deep Research)' }), false);
  assert.equal(isCitedReportedWeeklyCost({ ...cited, weeklyRunningCostSource: 'Estimate by u/Boring_Waltz_9545 on r/Broadway' }), false);
  assert.equal(isCitedReportedWeeklyCost({ ...cited, isEstimate: { weeklyRunningCost: true } }), false);
  assert.equal(isCitedReportedWeeklyCost({ ...cited, costMethodology: 'industry-estimate' }), false);
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
