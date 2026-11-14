import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeScrapeDrift, hasActiveReddit } = require('./audience-buzz-drift.js');

const rd = (reviewCount, extra = {}) => ({ reviewCount, ...extra });
const show = (combinedScore, designation, sources = {}) => ({ combinedScore, designation, sources });

test('hasActiveReddit: needs unsuppressed reddit with volume', () => {
  assert.equal(hasActiveReddit(show(80, 'Liking', { reddit: rd(50) })), true);
  assert.equal(hasActiveReddit(show(80, 'Liking', { reddit: rd(50, { suppressed: true }) })), false);
  assert.equal(hasActiveReddit(show(80, 'Liking', { reddit: rd(0) })), false);
  assert.equal(hasActiveReddit(show(80, 'Liking', {})), false);
});

test('a normal cleanup run (a few generic-title shows lose Reddit) is NOT a catastrophe', () => {
  const before = { shows: {} };
  const after = { shows: {} };
  // 100 healthy shows unchanged
  for (let i = 0; i < 100; i++) {
    before.shows[`ok-${i}`] = show(85, 'Liking', { showScore: rd(200), reddit: rd(150) });
    after.shows[`ok-${i}`] = show(85, 'Liking', { showScore: rd(200), reddit: rd(150) });
  }
  // 5 contaminated shows lose their (sole) Reddit -> null
  for (let i = 0; i < 5; i++) {
    before.shows[`bad-${i}`] = show(82, 'Liking', { reddit: rd(300) });
    after.shows[`bad-${i}`] = show(null, null, { reddit: rd(300, { suppressed: true }) });
  }
  const { catastrophe, metrics } = computeScrapeDrift(before, after);
  assert.equal(catastrophe, false);
  assert.equal(metrics.redditLost, 5);
  assert.ok(metrics.redditLossRate < 0.25, `lossRate ${metrics.redditLossRate}`);
});

test('a mass over-drop (anchor bug drops Reddit on most shows) IS a catastrophe', () => {
  const before = { shows: {} };
  const after = { shows: {} };
  for (let i = 0; i < 100; i++) {
    before.shows[`s-${i}`] = show(85, 'Liking', { showScore: rd(200), reddit: rd(150) });
    // bug: reddit dropped to 0 relevant everywhere, score recomputed lower
    after.shows[`s-${i}`] = show(70, 'Shrugging', { showScore: rd(200), reddit: rd(0) });
  }
  const { catastrophe, breaches, metrics } = computeScrapeDrift(before, after);
  assert.equal(catastrophe, true);
  assert.equal(metrics.redditLost, 100);
  assert.ok(breaches.some((b) => b.includes('redditLossRate')), breaches.join('; '));
});

test('a mass score shift trips meanCombinedDrift even without Reddit loss', () => {
  const before = { shows: {} };
  const after = { shows: {} };
  for (let i = 0; i < 50; i++) {
    before.shows[`s-${i}`] = show(90, 'Loving', { reddit: rd(150), showScore: rd(50) });
    after.shows[`s-${i}`] = show(60, 'Shrugging', { reddit: rd(150), showScore: rd(50) }); // 30pt swing
  }
  const { catastrophe, breaches, metrics } = computeScrapeDrift(before, after);
  assert.equal(catastrophe, true);
  assert.equal(metrics.meanCombinedDrift, 30);
  assert.ok(breaches.some((b) => b.includes('meanCombinedDrift')), breaches.join('; '));
});

test('mass show-entry removal (merge/scrape bug drops whole shows) IS a catastrophe', () => {
  const before = { shows: {} };
  const after = { shows: {} };
  for (let i = 0; i < 100; i++) {
    before.shows[`s-${i}`] = show(85, 'Liking', { reddit: rd(150) });
  }
  // Only 80 survive — 20% of entries vanished (a bug never legitimately deletes shows).
  for (let i = 0; i < 80; i++) after.shows[`s-${i}`] = show(85, 'Liking', { reddit: rd(150) });
  const { catastrophe, breaches, metrics } = computeScrapeDrift(before, after);
  assert.equal(catastrophe, true);
  assert.equal(metrics.removed, 20);
  assert.ok(breaches.some((b) => b.includes('removedRate')), breaches.join('; '));
});

test('newly-added shows and identical snapshots produce zero drift', () => {
  const before = { shows: { a: show(80, 'Liking', { reddit: rd(50) }) } };
  const after = { shows: { a: show(80, 'Liking', { reddit: rd(50) }), b: show(90, 'Loving', { reddit: rd(60) }) } };
  const { catastrophe, metrics } = computeScrapeDrift(before, after);
  assert.equal(catastrophe, false);
  assert.equal(metrics.redditLost, 0);
  assert.equal(metrics.meanCombinedDrift, 0);
});
