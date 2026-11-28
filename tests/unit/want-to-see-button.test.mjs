/**
 * BRO-3683: the show hero offered "Want to See" on a running show the user
 * had already rated (nightly UX walkthrough, mobile__show_hero_rated). The
 * label now comes from getWatchlistCtaLabel; this test exercises the real
 * helper and guards that the hero still renders through it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { getWatchlistCtaLabel } = await import('../../src/lib/watchlist-cta-label.ts');

test('rated running show offers "See it again", never "Want to See"', () => {
  assert.equal(getWatchlistCtaLabel({ onWatchlist: false, hasRating: true, isClosed: false }), 'See it again');
});

test('unrated show offers "Want to See"', () => {
  assert.equal(getWatchlistCtaLabel({ onWatchlist: false, hasRating: false, isClosed: false }), 'Want to See');
  assert.equal(getWatchlistCtaLabel({ onWatchlist: false, hasRating: false, isClosed: true }), 'Want to See');
});

test('closed rated show keeps "Want to See" (wished-I\'d-seen semantics)', () => {
  assert.equal(getWatchlistCtaLabel({ onWatchlist: false, hasRating: true, isClosed: true }), 'Want to See');
});

test('watchlisted show reads "On your list" whatever the rating', () => {
  for (const hasRating of [true, false]) {
    for (const isClosed of [true, false]) {
      assert.equal(getWatchlistCtaLabel({ onWatchlist: true, hasRating, isClosed }), 'On your list');
    }
  }
});

test('ShowHeroRedesign renders the watchlist label through the helper', () => {
  const src = readFileSync(join(ROOT, 'src/components/show-page/ShowHeroRedesign.tsx'), 'utf8');
  assert.match(src, /getWatchlistCtaLabel\(\{ onWatchlist, hasRating, isClosed \}\)/);
  assert.doesNotMatch(src, /\? 'See it again' :/, 'label ternary was re-inlined; use getWatchlistCtaLabel');
});
