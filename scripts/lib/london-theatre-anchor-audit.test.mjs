import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { auditLondonTheatreAnchor, summarizeLondonTheatreAnchors } = require('./london-theatre-anchor-audit');
const base = {
  outletId: 'london-theatre', scoreSource: 'anchored-v6',
  originalScore: '4/5 stars', originalScoreSource: 'londontheatre-page-json',
  llmScore: { score: 79, band: { floor: 71, ceiling: 90, fraction: 0.8 } },
};
const audit = (patch = {}) => auditLondonTheatreAnchor({ ...base, ...patch }, 'show/london-theatre--critic.json');

test('only the card outlet and anchored-v6 stamp are in scope', () => {
  assert.equal(audit({ outletId: 'guardian' }), null);
  assert.equal(audit({ scoreSource: 'llm-v6' }), null);
  assert.equal(audit({ scoreSource: 'londontheatre-page-json' }), null);
});

for (const [rating, floor, ceiling, score] of [
  ['2/5 stars', 31, 50, 40], ['3/5 stars', 51, 70, 65],
  ['4/5 stars', 71, 90, 79], ['5/5 stars', 91, 100, 97],
]) {
  test(`confirms verified ${rating} against its real detector band`, () => {
    const row = audit({ originalScore: rating, llmScore: { score, band: { floor, ceiling } } });
    assert.equal(row.status, 'confirmed');
    assert.deepEqual(row.criticBand, { floor, ceiling });
  });
}

test('does not let relayed fields override the verified critic star', () => {
  const row = audit({ starRating: '1/5', originalRating: '2/5', aggregatorStars: '5/5' });
  assert.equal(row.status, 'confirmed');
  assert.equal(row.criticBand.floor, 71);
});

test('missing, cleared, relayed, and malformed ratings remain unconfirmed', () => {
  for (const patch of [
    { originalScore: null }, { originalScore: '' }, { originalScoreCleared: true },
    { originalScoreSource: undefined }, { originalScoreSource: 'show-score' },
    { originalScoreSource: 'unicode-stars' }, { originalScore: 100, originalScoreSource: undefined },
    { originalScore: 'not rated' },
  ]) {
    const row = audit({ ...patch, aggregatorStars: '4/5' });
    assert.equal(row.status, 'verify-rating', JSON.stringify(patch));
    assert.equal(row.criticBand, null);
  }
});

test('accepts a human-verified critic star', () => {
  assert.equal(audit({ originalScoreSource: 'manual-verified' }).status, 'confirmed');
});

test('confirms the real Inside No. 9 page-verified normalized numeric rating', () => {
  const row = audit({ originalScore: 60, llmScore: { score: 65, band: { floor: 51, ceiling: 70 } } });
  assert.equal(row.status, 'confirmed');
  assert.deepEqual(row.criticBand, { floor: 51, ceiling: 70 });
});

test('mismatched bands and out-of-band or missing scores queue re-anchoring', () => {
  for (const patch of [
    { originalScore: '2/5 stars' },
    { llmScore: { score: 79 } },
    { llmScore: { score: 79, band: { floor: 90, ceiling: 71 } } },
    { llmScore: { band: base.llmScore.band } },
    { llmScore: { score: 91, band: base.llmScore.band } },
    { llmScore: { score: 70, band: base.llmScore.band } },
  ]) assert.equal(audit(patch).status, 'reanchor', JSON.stringify(patch));
  for (const score of [71, 90]) {
    assert.equal(audit({ llmScore: { score, band: base.llmScore.band } }).status, 'confirmed');
  }
});

test('audit is read-only and worklists are deterministic, exhaustive, and disjoint', () => {
  const data = structuredClone(base);
  const before = structuredClone(data);
  const rows = [
    auditLondonTheatreAnchor(data, 'z/file.json'),
    auditLondonTheatreAnchor({ ...data, originalScore: '2/5' }, 'b/file.json'),
    auditLondonTheatreAnchor({ ...data, originalScore: null }, 'a/file.json'),
  ];
  assert.deepEqual(data, before);
  const report = summarizeLondonTheatreAnchors(rows);
  assert.equal(report.total, 3);
  assert.deepEqual(report.confirmed.map(r => r.file), ['z/file.json']);
  assert.deepEqual(report.reanchorQueue.map(r => r.file), ['b/file.json']);
  assert.deepEqual(report.ratingVerificationQueue.map(r => r.file), ['a/file.json']);
  assert.equal(summarizeLondonTheatreAnchors([]).total, 0);
});
