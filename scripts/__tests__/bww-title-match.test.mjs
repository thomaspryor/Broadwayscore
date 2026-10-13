// BRO-4001: BWW UK review with the show title misspelled (CATERINA vs CATARINA)
// must still be matched by discovery, a different show must not, and an
// author-page URL must resolve to the critic's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { slugMatchesShow } = require('../lib/bww-rr-discover.js');
const { urlLooksLikeReview } = require('../lib/review-guards.js');
const { resolveCritic, nameFromAuthorUrl } = require('../lib/resolve-critic.js');

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
