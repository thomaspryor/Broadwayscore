// BRO-4001: BWW UK review with the show title misspelled (CATERINA vs CATARINA)
// must still be matched by discovery, a different show must not, and an
// author-page URL must resolve to the critic's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { slugMatchesShow } = require('./bww-rr-discover.js');
const { urlLooksLikeReview } = require('./review-guards.js');
const { resolveCritic, nameFromAuthorUrl } = require('./resolve-critic.js');

const TITLE = 'Catarina and the Beauty of Killing Fascists';
const SHOW = { title: TITLE, slug: 'catarina-and-the-beauty-of-killing-fascists-west-end-2026' };
const TYPO = 'https://www.broadwayworld.com/westend/article/Review-CATERINA-AND-THE-BEAUTY-OF-KILLING-FASCISTS-National-Theatre-20260922';
const OTHER = 'https://www.broadwayworld.com/westend/article/Review-HAMILTON-Victoria-Palace-20260922';

test('typo slug still matches the show (RR slug predicate)', () => {
  assert.equal(slugMatchesShow(TYPO, SHOW), true);
  assert.equal(slugMatchesShow(OTHER, SHOW), false);
});

test('typo slug still passes the discovery URL filter', () => {
  assert.equal(urlLooksLikeReview(TYPO, TITLE), true);
  assert.equal(urlLooksLikeReview(OTHER, TITLE), false);
});

test('author-page URL becomes the critic name', () => {
  assert.equal(nameFromAuthorUrl('https://www.broadwayworld.com/author/Gary-Naylor'), 'Gary Naylor');
  assert.equal(nameFromAuthorUrl('https://www.broadwayworld.com/author/Gary-Naylor/'), 'Gary Naylor');
  assert.equal(resolveCritic({ byline: 'https://www.broadwayworld.com/author/Gary-Naylor' }), 'Gary Naylor');
  assert.equal(resolveCritic({ criticArg: 'https://www.broadwayworld.com/author/Gary-Naylor' }), 'Gary Naylor');
});

test('real names and non-author URLs are untouched', () => {
  assert.equal(nameFromAuthorUrl('Gary Naylor'), 'Gary Naylor');
  assert.equal(nameFromAuthorUrl('https://example.com/review/foo'), 'https://example.com/review/foo');
  assert.equal(resolveCritic({ criticArg: 'Jesse Green' }), 'Jesse Green');
});

test('word-match channels tolerate the outlet typo only when asked (BRO-5261 retro of BRO-4001)', () => {
  const { titleMatchesShow, urlSlugMatchesShow } = require('./rss-discovery.js');
  const HEAD = 'Review: CATERINA AND THE BEAUTY OF KILLING FASCISTS, National Theatre';
  assert.equal(titleMatchesShow(HEAD, TITLE), false, 'strict callers unchanged');
  assert.equal(titleMatchesShow(HEAD, TITLE, { fuzzy: true }), true);
  assert.equal(urlSlugMatchesShow(TYPO, TITLE, { fuzzy: true }), true);
  assert.equal(urlSlugMatchesShow(OTHER, TITLE, { fuzzy: true }), false);
  // A generic word is never the fuzzy word ("/musicals/" path vs "Musical").
  assert.equal(urlSlugMatchesShow('https://example.com/musicals/a-bronx-tale/review', 'A Bronx Tale The Musical', { fuzzy: true }), false);
  // Short titles stay exact; only one typo'd word per match.
  assert.equal(titleMatchesShow('Hamiltn review', 'Hamilton', { fuzzy: true }), false);
  assert.equal(titleMatchesShow('Review: CATERINA AND THE BEAUTI OF KILLIN FASCISTS', TITLE, { fuzzy: true }), false);
});

test('apostrophes fold on both sides of the word match', () => {
  const { titleMatchesShow, urlSlugMatchesShow } = require('./rss-discovery.js');
  assert.equal(titleMatchesShow('Review: A Midsummer Nights Dream at the Globe', "A Midsummer Night's Dream"), true);
  assert.equal(titleMatchesShow('Review: A Midsummer Night’s Dream', "A Midsummer Night's Dream"), true);
  assert.equal(urlSlugMatchesShow('https://example.com/disneys-beauty-and-the-beast-review', "Disney's Beauty and the Beast"), true);
});

test("the 'n' of Rock 'n' Roll still has to match after the apostrophe fold", () => {
  const { titleMatchesShow } = require('./rss-discovery.js');
  assert.equal(titleMatchesShow("Review: Rock 'n' Roll at the Royal Court", "Rock 'n' Roll"), true);
  assert.equal(titleMatchesShow('The Heart of Rock and Roll review', "Rock 'n' Roll"), false);
});

test('possessive headlines still match after the apostrophe fold (ship-check)', () => {
  const { titleMatchesShow } = require('./rss-discovery.js');
  assert.equal(titleMatchesShow("Review: Hadestown's Eva Noblezada returns", 'Hadestown'), true);
  assert.equal(titleMatchesShow('Tru’s triumph: review', 'Tru'), true);
  assert.equal(titleMatchesShow('Review: Blowing Louis Armstrong’s Horn Isn’t Enough in ‘A Wonderful World’', 'A Wonderful World: The Louis Armstrong Musical'), true);
  assert.equal(titleMatchesShow('Trump review', 'Tru'), false);
});
