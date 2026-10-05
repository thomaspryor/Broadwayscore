// BRO-2760: generic one-word titles ("The Story") must not pull wrong-show discovery noise.
// Replays the real the-story-west-end-2026 corpus (tests/fixtures/the-story-discovery-corpus.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { urlLooksLikeReview, isSluglessReviewUrl } = require('../../scripts/lib/review-guards.js');
const { titleMatchesShow, urlSlugMatchesShow } = require('../../scripts/lib/rss-discovery.js');
const { genericSingleWordTitle, passesGenericTitleIdentity } = require('../../scripts/lib/generic-title-guard.js');

const corpus = JSON.parse(fs.readFileSync(new URL('../fixtures/the-story-discovery-corpus.json', import.meta.url), 'utf8'));
const TITLE = corpus.title;

test('the 39 known-unrelated _pending URLs are not produced', () => {
  assert.ok(corpus.junkPendingUrls.length >= 22);
  const leaked = corpus.junkPendingUrls.filter(u => urlLooksLikeReview(u, TITLE));
  assert.deepEqual(leaked, []);
});

test('genuine reviews are still produced (Times UK, BroadwayWorld Clementine Scott, and the rest of the on-show corpus)', () => {
  const must = [
    'https://www.thetimes.com/culture/theatre-dance/article/the-story-review-hectoring-thriller-fails-convince-06fjp2xcd',
    'https://www.broadwayworld.com/westend/article/Review-THE-STORY-National-Theatre-20260903',
  ];
  for (const u of must) assert.ok(corpus.genuineUrls.includes(u), `fixture lacks ${u}`);
  const dropped = corpus.genuineUrls.filter(u => !isSluglessReviewUrl(u) && !urlLooksLikeReview(u, TITLE));
  assert.deepEqual(dropped, []);
});

test('RSS headline/slug matching: junk rejected, real headline accepted', () => {
  for (const t of ['Toy Story 5 review', '222 A Ghost Story tour review', 'Monsters: the Lyle and Erik Menendez Story', 'Skywalkers: A Love Story']) {
    assert.equal(titleMatchesShow(t, TITLE), false, t);
  }
  assert.equal(titleMatchesShow('The Story review: hectoring thriller fails to convince', TITLE), true);
  assert.equal(titleMatchesShow('Story: what a newsroom does to the truth', TITLE), true);
  assert.equal(urlSlugMatchesShow('https://x.com/news/toy-story-5-review', TITLE), false);
});

test('guard is narrow: distinctive one-word and multi-word titles are untouched', () => {
  assert.equal(genericSingleWordTitle('The Story'), 'story');
  for (const t of ['The Heiress', 'Wicked', 'Hamilton', 'The Lion King', 'Story of My Life', 'The Visit', 'The Truth', 'The Life']) {
    assert.equal(genericSingleWordTitle(t), null, t);
    assert.equal(passesGenericTitleIdentity('https://x.com/any-url-at-all', t), true, t);
  }
  assert.equal(urlLooksLikeReview('https://x.com/heiress-review-broadway', 'The Heiress'), true);
});

test('article-less real slugs still pass (second-opinion regressions)', () => {
  assert.equal(urlLooksLikeReview('https://www.hollywoodreporter.com/x/chita-rivera-visit-theater-review-791063/', 'The Visit'), true);
  assert.equal(urlLooksLikeReview('https://stuonbroadway.blogspot.com/2015/05/review-of-visit.html', 'The Visit'), true);
  assert.equal(urlLooksLikeReview('https://www.whatsonstage.com/news/review-story-hampstead-theatre/', 'The Story'), true);
  assert.equal(urlLooksLikeReview('https://example.com/theatre/national-theatre-story-review', 'The Story'), true);
});
