import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// BRO-8107: shows come from a fixture, not live data/shows.json (keeps this in the blocking batch).
process.on('exit', require('./shows-json-path.js').useShowsFixture([]));
const { siteSearchUrlMatchesTitle } = require('./site-search-discovery');
const { cleanSearchTitle } = require('./title-normalization');
const m = (u, t) => siteSearchUrlMatchesTitle(u, t, cleanSearchTitle(t));

// BRO-8126: BWW slug has no "musical"; the first pass dropped the real review.
test('Ceilidh The Musical matches its BWW /westend/ slug', () => {
  assert.equal(m('https://www.broadwayworld.com/westend/article/Review-CEILIDH-Shoreditch-Town-Hall-20261030', 'Ceilidh The Musical'), true);
});
test('Goblin and Speculations BWW slugs match', () => {
  assert.equal(m('https://www.broadwayworld.com/westend/article/Review-GOBLIN-Park-Theatre-20261119', 'Goblin'), true);
  assert.equal(m('https://www.broadwayworld.com/westend/article/Review-SPECULATIONS-Marylebone-Theatre-20261104', 'Speculations'), true);
});
test('real titles ending in a descriptor are not stripped to a generic word', () => {
  assert.equal(m('https://www.broadwayworld.com/westend/article/Review-SOMETHING-ROMANTIC-Theatre-20261104', 'Romantic Comedy'), false);
  assert.equal(m('https://example.com/theater/review-slave-ships.html', 'Slave Play'), false);
});
test('unrelated BWW review does not match', () => {
  assert.equal(m('https://www.broadwayworld.com/westend/article/Review-GOBLIN-Park-Theatre-20261119', 'Ceilidh The Musical'), false);
});
test('cleaned title with no real word does not fail-open (MJ The Musical)', () => {
  const u = 'https://www.broadwayworld.com/westend/article/Review-HAMILTON-Victoria-Palace-Theatre-20261104';
  for (const t of ['MJ The Musical', '9 to 5: the Musical', "Shakespeare's R & J"]) assert.equal(m(u, t), false, t);
});
