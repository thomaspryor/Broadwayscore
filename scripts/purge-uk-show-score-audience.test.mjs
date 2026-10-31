import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { planUkShowScoreRemoval, applyUkShowScoreRemoval } = require('./purge-uk-show-score-audience');

const UK_PAGE = '<link rel="canonical" href="https://www.show-score.com/uk/london/off-west-end-shows/midnight"> 92% (351 Ratings)';
const shows = [
  { id: 'midnight-off-broadway-2026', category: 'off-broadway', market: 'broadway', status: 'open' },
  { id: 'disruption-off-broadway-2026', category: 'off-broadway', market: 'broadway', status: 'open' },
  { id: 'cats-west-end-2026', category: 'west-end', market: 'west-end', status: 'open' },
];
const buzz = () => ({
  'midnight-off-broadway-2026': { sources: { showScore: { score: 92, reviewCount: 353 }, mezzanine: { score: 79, reviewCount: 27 } }, combinedScore: 91, designation: 'Loving' },
  'disruption-off-broadway-2026': { sources: { showScore: { score: 90, reviewCount: 731 } }, combinedScore: 90 },
  'cats-west-end-2026': { sources: { showScore: { score: 92, reviewCount: 353 } }, combinedScore: 92 },
});
const read = (id) => (id === 'cats-west-end-2026' || id === 'midnight-off-broadway-2026' || id === 'disruption-off-broadway-2026' ? UK_PAGE : null);

test('removes only a US show whose stored rating is the UK page\'s rating', () => {
  const plan = planUkShowScoreRemoval(buzz(), shows, read);
  assert.deepEqual(plan.map((p) => p.id), ['midnight-off-broadway-2026']);
});

test('apply deletes showScore, leaves a tombstone, recomputes the combined score', () => {
  const b = buzz();
  const plan = planUkShowScoreRemoval(b, shows, read);
  applyUkShowScoreRemoval(b, plan);
  const rec = b['midnight-off-broadway-2026'];
  assert.equal(rec.sources.showScore, undefined);
  assert.match(rec.sourcesRemoved.showScore, /UK production page/);
  assert.notEqual(rec.combinedScore, 91);
  assert.ok(rec.sources.mezzanine);
});
