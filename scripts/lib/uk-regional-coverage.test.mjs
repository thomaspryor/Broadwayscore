import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { coverage } = require('../uk-regional-coverage.js');

const reg = { nyt: { tier: 1 }, blog: { tier: 3 } };
const rev = (showId, outletId, n) => ({ showId, outletId, outlet: outletId, assignedScore: 70, criticName: `c${n}`, url: `https://x/${showId}/${n}` });

// The rows /browse/beyond-london lists: category regional at a uk-regional-venues.json house, not local-only.
test('counts UK regional rows per city, skips non-UK houses, other categories and local-only rows', () => {
  const shows = [
    { id: 'a', city: 'manchester-uk', category: 'regional', venue: 'Royal Exchange Theatre, Manchester' },
    { id: 'b', city: 'manchester-uk', category: 'tour', venue: 'Royal Exchange Theatre, Manchester' },
    { id: 'c', city: 'chicago', category: 'regional', venue: 'Goodman Theatre, Chicago' },
    { id: 'd', city: 'manchester-uk', category: 'regional', venue: 'Royal Exchange Theatre, Manchester', localOnly: true },
  ];
  const { cities, total } = coverage(shows, [rev('a', 'blog', 1)], reg);
  assert.deepEqual(Object.keys(cities), ['manchester-uk']);
  assert.equal(total.shows, 1);
  assert.equal(total.reviews, 1);
  assert.equal(total.scoreable, 0);
});

test('a row clears the gate only with enough distinct scored reviews', () => {
  const venue = 'Leeds Playhouse';
  const shows = [{ id: 'a', city: 'leeds-uk', category: 'regional', venue }, { id: 'b', city: 'leeds-uk', category: 'regional', venue }];
  const reviews = [1, 2, 3, 4, 5, 6].map((n) => rev('a', `o${n}`, n)).concat([rev('b', 'o1', 1)]);
  const { cities } = coverage(shows, reviews, {});
  assert.equal(cities['leeds-uk'].scoreable, 1);
});
