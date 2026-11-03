/**
 * Signed-out ratings (BRO-6917). Locks: malformed storage reads as empty,
 * invalid ratings are dropped, one entry per show (latest wins), migration
 * skips shows the account already rated, and blocked storage falls back to
 * memory instead of losing the rating.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LOCAL_RATINGS,
  parseLocalRatings,
  upsertRating,
  removeRatingEntry,
  ratingsToMigrate,
  getLocalRatings,
  saveLocalRating,
  removeLocalRating,
} from '../../src/lib/local-ratings';

test('parse: malformed storage reads as empty; bad entries and dupes dropped', () => {
  assert.deepEqual(parseLocalRatings(null), []);
  assert.deepEqual(parseLocalRatings('not json'), []);
  assert.deepEqual(parseLocalRatings('{"a":1}'), []);
  const out = parseLocalRatings(JSON.stringify([
    { showId: 'a', rating: 4.5, savedAt: 2 },
    { showId: 'a', rating: 1, savedAt: 1 },
    { showId: 'b', rating: 0 },
    { showId: 'c', rating: 3.3 },
    { showId: 'd', rating: 6 },
    { showId: '', rating: 3 },
    null,
    { showId: 'e', rating: 3, timeSlot: 'bogus', reviewText: 'ok', seat: '' },
  ]));
  assert.deepEqual(out, [
    { showId: 'a', rating: 4.5, savedAt: 2 },
    { showId: 'e', rating: 3, reviewText: 'ok', savedAt: 0 },
  ]);
});

test('upsert: newest first, same show replaces, invalid ignored, bounded', () => {
  let list = upsertRating([], { showId: 'a', rating: 3 }, 1);
  list = upsertRating(list, { showId: 'b', rating: 4 }, 2);
  list = upsertRating(list, { showId: 'a', rating: 5, reviewText: 'redo' }, 3);
  assert.deepEqual(list.map(e => [e.showId, e.rating]), [['a', 5], ['b', 4]]);
  assert.equal(upsertRating(list, { showId: 'z', rating: 9 }, 4), list);
  let big = list;
  for (let i = 0; i < MAX_LOCAL_RATINGS + 20; i++) big = upsertRating(big, { showId: `s${i}`, rating: 3 }, i);
  assert.equal(big.length, MAX_LOCAL_RATINGS);
  assert.deepEqual(removeRatingEntry(list, 'a').map(e => e.showId), ['b']);
});

test('migrate: skips shows the account already rated, oldest first', () => {
  const local = upsertRating(upsertRating(upsertRating([], { showId: 'a', rating: 3 }, 1), { showId: 'b', rating: 4 }, 2), { showId: 'c', rating: 5 }, 3);
  assert.deepEqual(ratingsToMigrate(local, ['b']).map(e => e.showId), ['a', 'c']);
  assert.deepEqual(ratingsToMigrate(local, []).map(e => e.showId), ['a', 'b', 'c']);
});

test('storage: blocked localStorage keeps the rating in memory for the page', () => {
  const g = globalThis as Record<string, unknown>;
  const had = 'localStorage' in g;
  const prev = g.localStorage;
  g.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  try {
    assert.deepEqual(getLocalRatings(), []);
    saveLocalRating({ showId: 'm', rating: 4 });
    assert.deepEqual(getLocalRatings().map(e => e.showId), ['m']);
    removeLocalRating('m');
    assert.deepEqual(getLocalRatings(), []);
  } finally {
    if (had) g.localStorage = prev; else delete g.localStorage;
  }
});
