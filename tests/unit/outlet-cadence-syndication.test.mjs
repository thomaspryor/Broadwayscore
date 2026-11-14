import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCadenceReport } = require('../../scripts/lib/outlet-cadence');

const outlets = {
  nytimes: { tier: 1 },
  chicagotribune: { tier: 2 },
  nydailynews: { tier: 2 },
  theatermania: { tier: 2 },
  whatsonstage: { tier: 2 },
  'hollywood-reporter': { tier: 1 },
  reuters: { tier: 3 },
};
const review = (outletId, criticName, publishDate, extra = {}) => ({
  outletId, criticName, publishDate, showId: `show-${publishDate}`,
  assignedScore: 80, market: 'broadway', ...extra,
});
const pulse = review('nytimes', 'Fixture Critic', '2026-09-01');
const history = [
  review('nydailynews', 'Original Critic', '2026-01-01'),
  review('nydailynews', 'Original Critic', '2026-01-08'),
];
const row = (report, id, market = 'broadway') =>
  report.find(r => r.outletId === id && r.market === market);

test('Chris Jones primary advances NY Daily News heartbeat without altering the primary or pulse', () => {
  const reviews = [...history, pulse, review('chicagotribune', ' Chris Jones ', '2026-08-25')];
  const snapshot = structuredClone(reviews);
  const before = buildCadenceReport(reviews.slice(0, -1), outlets);
  const after = buildCadenceReport(reviews, outlets);
  assert.equal(row(before, 'nydailynews').status, 'red');
  assert.equal(row(after, 'nydailynews').status, 'green');
  assert.equal(row(after, 'nydailynews').lastReviewDate, '2026-08-25');
  assert.equal(row(after, 'nydailynews').reviewCount, 3);
  assert.equal(row(after, 'chicagotribune').reviewCount, 1);
  assert.deepEqual(row(after, 'nytimes'), row(before, 'nytimes'));
  assert.deepEqual(reviews, snapshot);
});

test('only a scored matching critic at the configured primary supplies cadence credit', () => {
  const report = buildCadenceReport([
    ...history, pulse,
    review('chicagotribune', 'Another Critic', '2026-08-25'),
    review('chicagotribune', '', '2026-08-25'),
    review('chicagotribune', 'Chris Jones', '2026-08-25', { assignedScore: null }),
    review('chicagotribune', 'Chris Jones', null),
    review('theatermania', 'Chris Jones', '2026-08-25'),
  ], outlets);
  assert.equal(row(report, 'nydailynews').status, 'red');
  assert.equal(row(report, 'nydailynews').reviewCount, 2);
});

test('syndicated dates stay in their show market and require secondary history in that market', () => {
  const report = buildCadenceReport([
    ...history, pulse,
    review('chicagotribune', 'Chris Jones', '2026-08-25', { showId: 'london' }),
    review('chicagotribune', 'Chris Jones', '2026-08-26', { showId: 'excluded' }),
  ], outlets, { marketOf: id => id === 'london' ? 'west-end' : id === 'excluded' ? null : 'broadway' });
  assert.equal(row(report, 'nydailynews').status, 'red');
  assert.equal(row(report, 'nydailynews', 'west-end'), undefined);
});

test('an existing scored secondary copy is counted once regardless of input order or publication day', () => {
  const primary = review('chicagotribune', 'Chris Jones', '2026-08-25');
  const secondary = review('nydailynews', 'CHRIS JONES', '2026-08-26', { showId: primary.showId });
  for (const pair of [[primary, secondary], [secondary, primary]]) {
    const report = buildCadenceReport([...history, pulse, ...pair], outlets);
    assert.equal(row(report, 'nydailynews').reviewCount, 3);
    assert.equal(row(report, 'nydailynews').lastReviewDate, '2026-08-26');
  }
  const unscored = buildCadenceReport([...history, pulse, primary, { ...secondary, assignedScore: null }], outlets);
  assert.equal(row(unscored, 'nydailynews').reviewCount, 3);
  assert.equal(row(unscored, 'nydailynews').lastReviewDate, '2026-08-25');
});

test('both TheaterMania critics credit WhatsOnStage and preserve its original reviews', () => {
  const report = buildCadenceReport([
    pulse,
    review('theatermania', 'Zachary Stewart', '2026-08-24'),
    review('theatermania', 'David Gordon', '2026-08-25'),
    review('whatsonstage', 'Original Critic', '2026-08-19'),
    review('whatsonstage', 'Original Critic', '2026-08-26'),
  ], outlets);
  assert.equal(row(report, 'whatsonstage').reviewCount, 4);
  assert.equal(row(report, 'whatsonstage').lastReviewDate, '2026-08-26');
  assert.equal(row(report, 'whatsonstage').status, 'green');
});

test('secondary credit respects its own registry tier, even when the primary is outside maxTier', () => {
  const reviews = [
    review('reuters', 'Original Critic', '2026-01-01'),
    review('reuters', 'Original Critic', '2026-01-08'),
    review('hollywood-reporter', 'David Rooney', '2026-08-25'),
  ];
  assert.equal(row(buildCadenceReport(reviews, outlets), 'reuters'), undefined);
  assert.equal(row(buildCadenceReport(reviews, outlets, { maxTier: 3 }), 'reuters').reviewCount, 3);
  const filtered = buildCadenceReport(reviews, { ...outlets, 'hollywood-reporter': { tier: 3 }, reuters: { tier: 2 } });
  assert.equal(row(filtered, 'reuters').reviewCount, 3);
  assert.equal(row(filtered, 'hollywood-reporter'), undefined);
  assert.equal(row(buildCadenceReport(reviews, { 'hollywood-reporter': { tier: 1 } }), 'reuters'), undefined);
});

test('secondary activity does not flow backward to primary outlets', () => {
  const report = buildCadenceReport([review('nydailynews', 'Chris Jones', '2026-08-25')], outlets);
  assert.equal(row(report, 'chicagotribune'), undefined);
  assert.equal(row(report, 'nydailynews').reviewCount, 1);
});

test('stale syndicated critics cannot establish a secondary cadence without its own market history', () => {
  const syndicated = [
    review('theatermania', 'Zachary Stewart', '2026-04-01'),
    review('theatermania', 'David Gordon', '2026-04-08'),
    review('theatermania', 'Zachary Stewart', '2026-04-15'),
    review('theatermania', 'David Gordon', '2026-04-22'),
    review('theatermania', 'Another Critic', '2026-08-25'),
  ];
  const original = review('whatsonstage', 'Original Critic', '2021-12-10');
  for (const own of [
    [],
    [original],
    [original, review('whatsonstage', 'Original Critic', 'invalid-date')],
    [original, review('whatsonstage', 'Original Critic', '2026-08-25', { assignedScore: null })],
    [original, review('whatsonstage', 'Original Critic', '2026-08-25', { market: 'west-end' })],
  ]) {
    const before = buildCadenceReport([...own, pulse], outlets);
    const after = buildCadenceReport([...own, pulse, ...syndicated], outlets);
    assert.equal(row(after, 'theatermania').status, 'green');
    assert.deepEqual(row(after, 'whatsonstage'), row(before, 'whatsonstage'));
  }
});
