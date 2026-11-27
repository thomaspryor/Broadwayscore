// BRO-6956: critics whose sources failed have unknown gaps, never zero. The weekly
// snapshot counts them and the drift check refuses to compare a blind week.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { summarizeAudit } = require('./critic-coverage-history-snapshot.js');
const { isBlind } = require('./critic-coverage-checks/coverage-drift.check.js');

test('summarizeAudit counts failed-source critics as blind, not as zero-gap', () => {
  const s = summarizeAudit([
    { name: 'A', missingCount: 3 },
    { name: 'B', error: 'all-sources-failed' },
    { name: 'C', error: 'fetch-failed' },
    { name: 'D', error: 'no-articles-found' },
  ]);
  assert.equal(s.totalCritics, 4);
  assert.equal(s.totalGaps, 3);
  assert.equal(s.blindCritics, 2);
  assert.deepEqual(s.blindCriticNames, ['B', 'C']);
  assert.deepEqual(s.perCritic, { A: 3 });
});

test('isBlind: over 20% failed is blind; old snapshots without the field are not', () => {
  assert.equal(isBlind({ totalCritics: 165, blindCritics: 165 }), true);
  assert.equal(isBlind({ totalCritics: 100, blindCritics: 21 }), true);
  assert.equal(isBlind({ totalCritics: 100, blindCritics: 20 }), false);
  assert.equal(isBlind({ totalCritics: 100 }), false);
  assert.equal(isBlind({ totalCritics: 0, blindCritics: 0 }), false);
});
