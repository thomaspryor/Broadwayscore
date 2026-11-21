import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { hasSameMarketTitleMatch } = createRequire(import.meta.url)('./opening-night-completeness.js');

const mk = (id, venue, openingDate, category = 'regional') => ({ id, title: 'The Snow Queen', venue, openingDate, category });

test('regional: same title at a different venue is not a revival (BRO-7336)', () => {
  const shows = [mk('a', 'Chopin Theatre, Chicago, IL', '2021-11-23'), mk('b', 'The Den Theatre, Chicago, IL', '2026-11-07')];
  assert.equal(hasSameMarketTitleMatch(shows[1], shows), false);
});
test('regional: same title at the same venue still flags', () => {
  const shows = [mk('a', 'The Den Theatre, Chicago, IL', '2021-11-23'), mk('b', 'The Den Theatre, Chicago, IL', '2026-11-07')];
  assert.equal(hasSameMarketTitleMatch(shows[1], shows), true);
});
test('regional: venue match folds diacritics, case and punctuation', () => {
  const shows = [mk('a', 'Théâtre Café, Montréal', '2021-11-23'), mk('b', 'theatre cafe montreal', '2026-11-07')];
  assert.equal(hasSameMarketTitleMatch(shows[1], shows), true);
});
test('regional: two shows with no venue never match each other', () => {
  const shows = [mk('a', null, '2021-11-23'), mk('b', '', '2026-11-07')];
  assert.equal(hasSameMarketTitleMatch(shows[1], shows), false);
});
test('regional: a LATER same-venue show does not flag the earlier one', () => {
  const shows = [mk('a', 'The Den Theatre, Chicago, IL', '2021-11-23'), mk('b', 'The Den Theatre, Chicago, IL', '2026-11-07')];
  assert.equal(hasSameMarketTitleMatch(shows[0], shows), false);
});
test('non-regional market keeps cross-venue matching', () => {
  const shows = [mk('a', 'Met Opera', '2012-12-31', 'off-broadway'), mk('b', 'Other Hall', '2026-12-06', 'off-broadway')];
  assert.equal(hasSameMarketTitleMatch(shows[1], shows), true);
});
