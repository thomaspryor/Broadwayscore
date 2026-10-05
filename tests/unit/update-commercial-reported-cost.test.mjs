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

const citation = (slug, field, newValue) => ({ slug, field, oldValue: null, newValue, confidence: 'high', source: 'Section F' });

test('a trade-press cost updates a reported figure only with a printable citation', () => {
  const data = commercialWith({ weeklyRunningCost: 500000, costMethodology: 'trade-reported' });
  const change = { ...redditCost('some-show', 550000), source: 'Section F: Variety, Oct 2026' };
  const bare = filterByConfidence([change], data);
  assert.equal(bare.applied.length, 0);
  assert.match(bare.flagged[0].flagReason, /printable trade or SEC citation/);

  const cited = filterByConfidence([change, citation('some-show', 'weeklyRunningCostSource', 'Variety (Oct 2, 2026)')], data);
  assert.equal(cited.applied.length, 1);
  assert.equal(cited.applied[0].citation, 'Variety (Oct 2, 2026)');
  assert.match(cited.skipped[0].skipReason, /set from the source of the figure/);

  // A citation that still reads "Section F" is not printable.
  const internal = filterByConfidence([change, citation('some-show', 'weeklyRunningCostSource', 'Section F: Variety')], data);
  assert.equal(internal.applied.length, 0);
});

test('a citation rides along only if it would pass the filter on its own', () => {
  const data = commercialWith({ weeklyRunningCost: 500000, costMethodology: 'trade-reported' });
  const change = { ...redditCost('some-show', 550000), source: 'Section F: Variety' };
  for (const conf of [{ confidence: 'low' }, { validatedConfidence: 'flagged' }, { validatedConfidence: 'low' }]) {
    const cite = { ...citation('some-show', 'weeklyRunningCostSource', 'Variety (Oct 2, 2026)'), ...conf };
    const { applied, flagged } = filterByConfidence([change, cite], data);
    assert.equal(applied.length, 0, JSON.stringify(conf));
    assert.ok(flagged.some((f) => /printable trade or SEC citation/.test(f.flagReason)), JSON.stringify(conf));
  }
});

test('a restated figure is skipped quietly, not flagged every week', () => {
  const data = commercialWith({ weeklyRunningCost: 500000, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Variety (2025)' });
  const { applied, flagged, skipped } = filterByConfidence([{ ...redditCost('some-show', '500000'), source: 'Section F: Variety' }], data);
  assert.equal(applied.length + flagged.length, 0);
  assert.match(skipped[0].skipReason, /Restates/);
});

test('any capitalization /biz prints without "~" is protected from a Reddit figure', () => {
  for (const capitalizationSource of ['Producer disclosure (fully raised by opening)', 'Press announcement', null]) {
    const data = commercialWith({ capitalization: 12000000, capitalizationSource });
    const { applied, skipped } = filterByConfidence([{ slug: 'some-show', field: 'capitalization', oldValue: 12000000, newValue: 15000000, confidence: 'high', source: 'Section D: comment' }], data);
    assert.equal(applied.length, 0, String(capitalizationSource));
    assert.match(skipped[0].skipReason, /reported capitalization/);
  }
  // An estimated one may be replaced.
  const est = commercialWith({ capitalization: 12000000, isEstimate: { capitalization: true } });
  assert.equal(filterByConfidence([{ slug: 'some-show', field: 'capitalization', oldValue: 12000000, newValue: 15000000, confidence: 'high', source: 'Section D: comment' }], est).applied.length, 1);
});

test('the model cannot set a citation or label on its own', () => {
  const data = commercialWith({ weeklyRunningCost: 600000, costMethodology: 'reddit-standard', isEstimate: { weeklyRunningCost: true } });
  const proposals = [
    citation('some-show', 'weeklyRunningCostSource', 'Deadline (Oct 3, 2026)'),
    citation('some-show', 'capitalizationSource', 'Variety (2025)'),
    { ...citation('some-show', 'costMethodology', 'trade-reported') },
    { ...citation('some-show', 'isEstimate', { weeklyRunningCost: false }) },
  ];
  const { applied, flagged } = filterByConfidence(proposals, data);
  assert.equal(applied.length, 0);
  assert.equal(flagged.length, 4);
  for (const f of flagged) assert.match(f.flagReason, /follows the cited source of its figure/);
});

test('public text with research wording or a section letter goes to a person', () => {
  const data = commercialWith({});
  for (const [field, newValue] of [['notes', 'Section C: Reddit says it is doing well.'], ['recoupedSource', 'Sections F and H: Deadline'], ['notes', 'Per GPT deep research.']]) {
    const { applied, flagged } = filterByConfidence([{ ...citation('some-show', field, newValue) }], data);
    assert.equal(applied.length, 0, newValue);
    assert.match(flagged[0].flagReason, /research notes/, newValue);
  }
  const ok = filterByConfidence([{ ...citation('some-show', 'notes', 'Closed early after soft sales.') }], data);
  assert.equal(ok.applied.length, 1);
});

test('a figure must be a plausible dollar amount', () => {
  const data = commercialWith({});
  assert.equal(filterByConfidence([redditCost('some-show', 1)], data).skipped.length, 1);
  assert.equal(filterByConfidence([redditCost('some-show', '$650K')], data).flagged.length, 1);
  assert.equal(filterByConfidence([redditCost('some-show', null)], data).flagged.length, 1);
  const { applied } = filterByConfidence([redditCost('some-show', '650000')], data);
  assert.equal(applied[0].newValue, 650000);
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

test('a new weekly cost takes its own label and citation, never the old one', () => {
  const cited = { weeklyRunningCost: 1000000, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Broadway Journal (Dec 16, 2025)', isEstimate: { capitalization: true } };
  const cases = [
    // [source, citation carried from filterByConfidence, methodology, estimate, stored citation]
    ['Section F: Deadline reports $1.1M weekly', 'Deadline (Oct 3, 2026)', 'trade-reported', false, 'Deadline (Oct 3, 2026)'],
    ['Section H: SEC Form D', 'SEC Form D filing (2026)', 'sec-filing', false, 'SEC Form D filing (2026)'],
    // The label names what the printed citation is.
    ['Sections F and H: Deadline, Form D', 'Deadline (Oct 3, 2026)', 'trade-reported', false, 'Deadline (Oct 3, 2026)'],
    // A trade claim with no citation prints as an estimate, labeled ours.
    ['Section F: Deadline reports $1.1M weekly', null, 'industry-estimate', true, null],
    ['Section C: Grosses Analysis', null, 'reddit-standard', true, null],
    // A citation never makes a Reddit figure reported.
    ['Sections C and F: grosses post and Variety', 'Variety (2026)', 'reddit-standard', true, null],
  ];
  for (const [source, cite, methodology, estimate, stored] of cases) {
    const data = commercialWith({ ...cited, isEstimate: { ...cited.isEstimate } });
    applyChanges([{ ...redditCost('some-show', 1100000), source, citation: cite }], [], data, undefined);
    const rec = data.shows['some-show'];
    assert.equal(rec.costMethodology, methodology, source);
    assert.equal(rec.isEstimate.weeklyRunningCost, estimate, source);
    assert.equal(rec.isEstimate.capitalization, true, 'keeps other flags');
    assert.equal(rec.weeklyRunningCostSource, stored, source);
  }
  // An unsourced model figure filling a gap is our own estimate.
  const gap = commercialWith({});
  applyChanges([{ ...redditCost('some-show', 700000), source: 'Section B: box office math' }], [], gap, undefined);
  assert.equal(gap.shows['some-show'].costMethodology, 'industry-estimate');
  assert.equal(gap.shows['some-show'].isEstimate.weeklyRunningCost, true);
});

test('a restated figure keeps its label and citation', () => {
  const rec = { weeklyRunningCost: 650000, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Forbes (Nov 17, 2025)' };
  const data = commercialWith({ ...rec });
  const n = applyChanges([{ ...redditCost('some-show', 650000), source: 'Section F: Forbes' }], [], data, undefined);
  assert.equal(n, 0);
  assert.equal(data.shows['some-show'].weeklyRunningCostSource, 'Forbes (Nov 17, 2025)');
  assert.equal(data.shows['some-show'].costMethodology, 'trade-reported');
});

test('a capitalization change carries its own citation and estimate flag', () => {
  const base = { capitalization: 18000000, capitalizationSource: 'Variety (2024)' };
  const cases = [
    ['Section H: SEC Form D', 'SEC Form D filing (2026)', false, 'SEC Form D filing (2026)'],
    ['Section F: Deadline', null, true, null],
    ['Section E: r/Broadway thread', null, true, null],
  ];
  for (const [source, cite, estimate, stored] of cases) {
    const data = commercialWith({ ...base });
    applyChanges([{ slug: 'some-show', field: 'capitalization', oldValue: 18000000, newValue: 22000000, confidence: 'high', source, citation: cite }], [], data, undefined);
    assert.equal(data.shows['some-show'].isEstimate.capitalization, estimate, source);
    assert.equal(data.shows['some-show'].capitalizationSource, stored, source);
  }
  // A reported capitalization is replaced only from trade or SEC evidence.
  const { skipped } = filterByConfidence([{ slug: 'some-show', field: 'capitalization', oldValue: 18000000, newValue: 25000000, confidence: 'high', source: 'Section C: Grosses Analysis' }], commercialWith({ ...base }));
  assert.match(skipped[0].skipReason, /reported capitalization/);
});

test('a new entry is labeled from its source, whatever labels the model wrote', () => {
  const index = { bySlug: new Map([['new-show', { slug: 'new-show', status: 'open' }]]), byId: new Map() };
  const data = { _meta: {}, shows: {} };
  applyChanges([], [{
    slug: 'new-show', confidence: 'high', source: 'Section C: Grosses Analysis',
    data: {
      designation: 'TBD', weeklyRunningCost: 700000, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Deadline (2026)',
      isEstimate: { weeklyRunningCost: false }, capitalization: '15000000', capitalizationSource: 'Section F: Variety', notes: 'Section C: Reddit expects a long run.',
    },
  }], data, index);
  const rec = data.shows['new-show'];
  assert.equal(rec.costMethodology, 'reddit-standard');
  assert.equal(rec.isEstimate.weeklyRunningCost, true);
  assert.equal(rec.weeklyRunningCostSource, null);
  assert.equal(rec.capitalization, 15000000);
  assert.equal(rec.isEstimate.capitalization, true);
  assert.equal(rec.capitalizationSource, null);
  assert.equal(rec.notes, null, 'research wording cleaned like the other model-fed writers');
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
  assert.equal(extractSourceType('Sections C and F: weekly cost'), 'Reddit Grosses Analysis');
  assert.equal(extractSourceType('Section D: u/someone'), 'Reddit comment');
  assert.equal(extractSourceType('Section E: r/Broadway thread'), 'Reddit comment');
  assert.equal(extractSourceType('Section F: Deadline article'), 'Deadline');
  assert.equal(extractSourceType('Section H: SEC Form D'), 'SEC Form D');
  assert.equal(extractSourceType('Section B: box office math'), 'estimate');
});
