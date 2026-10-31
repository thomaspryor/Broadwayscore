import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { matchSlugToShow } = require('./show-matching.js');

const heart = { id: 'the-heart-off-broadway-2026', title: 'The Heart', slug: 'the-heart-off-broadway-2026', category: 'off-broadway', openingDate: '2026-10-20' };

test('BRO-6682: slug naming the longer sibling does not match the short title (per-show fan-out)', () => {
  assert.equal(matchSlugToShow('read-the-reviews-for-the-heart-of-rock-and-roll', [heart]), null);
});

test('slug naming the short title itself still matches', () => {
  const m = matchSlugToShow('read-the-reviews-for-the-heart', [heart]);
  assert.ok(m && m.show.id === heart.id);
});
