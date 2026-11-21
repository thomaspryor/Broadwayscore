// BRO-6606: the five non-review URLs the UK SERP pass ingested must be refused; real reviews stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNonReviewUrl } = require('./serp-non-review-url.js');
const { classifyReviewUrl, ingestRefusalReason, submissionNonReviewReason } = require('./non-review-url-patterns.js');

test('refuses film-fan, book shop and announcement URLs', () => {
  for (const u of [
    'https://letterboxd.com/pattinsins/film/the-little-mermaid-2023/',
    'https://letterboxd.com/film/uncle-vanya-2020/watch/',
    'https://timesbookshop.co.uk/pig-heart-boy-9781839044472/',
    'https://cineramafilm.com/2025/02/06/malorie-blackmans-pig-heart-boy-uk-tour/',
    'https://theatreweekly.com/full-details-announced-for-jekyll-hyde-at-liverpool-everyman-this-july/',
    'https://www.theatre-news.com/news/UK/125287/Adrian-Lukis-returns-as-Jane-Austen-s-most-infamous-rogue-in-Being-Mr-Wickham',
  ]) {
    assert.equal(isNonReviewUrl(u), true, u);
    assert.equal(classifyReviewUrl(u).ok, false, `canonical classifier: ${u}`);
    assert.ok(ingestRefusalReason(u), `ingest: ${u}`);
    assert.ok(submissionNonReviewReason(u), `submission: ${u}`);
  }
});

test('keeps real reviews, including ones whose slug mentions casting or returns', () => {
  for (const u of [
    'https://www.theguardian.com/stage/article/2024/jun/27/sense-and-sensibility-review-pitlochry-festival-theatre',
    'https://www.heraldscotland.com/life_style/25120336.doubt-parable-dundee-rep-review-quietly-thrilling-evocation/',
    'https://www.thereviewshub.com/bluebelle-crucible-theatre-sheffield/',
    'https://fairypoweredproductions.com/a-christmas-carol-a-ghost-story-review/',
    'https://www.thestage.co.uk/reviews/pantomime-review-returns-as-tour',
    'https://www.newsday.com/entertainment/theater/casting-ideal-material-unreal-in-addams-family-x1',
    'https://www.out.com/theater/paramour-dazzling-corny-also-drag-race-casting-gossip',
    'https://example.com/broadcasting-the-tourism-play',
  ]) {
    assert.equal(isNonReviewUrl(u), false, u);
    assert.equal(classifyReviewUrl(u).ok, true, `canonical classifier: ${u}`);
    assert.equal(ingestRefusalReason(u), null, `ingest: ${u}`);
    assert.equal(submissionNonReviewReason(u), null, `submission: ${u}`);
  }
});

test('a malformed percent escape does not throw', () => {
  assert.doesNotThrow(() => isNonReviewUrl('https://example.com/a%E0%A4b'));
});

// BRO-7569: real URLs the gap engine met on 2025-26 review rows (non-review pages attached by an aggregator).
const { isNonReviewSectionUrl } = require('./serp-non-review-url.js');
test('isNonReviewSectionUrl: interview / opinion / shop / recipe / promoted pages are not reviews (BRO-7569)', () => {
  for (const u of [
    'https://www.thetimes.com/culture/theatre-dance/article/charlotte-ritchie-interview-cloud-9-ghosts-0xbvk5cd9',
    'https://www.nytimes.com/2025/11/07/opinion/culture/44-obama-musical-hamilton.html',
    'https://variety.com/shop/broadway-show-tickets-where-to-buy-1234970196/',
    'https://www.thetimes.com/recipes/easy-everyday/dinner/article/jeremy-lees-rabbit-with-bacon-and-mustard-recipe',
    'https://www.thestage.co.uk/promoted-content/the-last-self-tape-explores-how-art-performance',
    'https://www.thestage.co.uk/news/jeremy-herrin-every-brilliant-thing-has-been-unprecedented-success',
    'https://www.thetimes.com/life-style/luxury/article/invisible-tech-sound-systems-times-luxury-6pxtqwp08',
  ]) assert.equal(isNonReviewSectionUrl(u), true, u);
});
test('isNonReviewSectionUrl: real review pages, incl. lifestyle-section reviews, are kept (BRO-7569)', () => {
  for (const u of [
    'https://www.thetimes.com/culture/theatre-dance/article/hamlet-hail-to-the-thief-review-moment',
    'https://www.thestage.co.uk/reviews/giant-review-harold-pinter-theatre-london-john-lithgow',
    'https://www.nytimes.com/2026/08/25/theater/paranormal-activity-review-broadway.html',
    'https://www.washingtonpost.com/lifestyle/style/worlds-converge-with-grace-in-an-american-in-paris',
    'https://www.hollywoodreporter.com/lifestyle/arts/american-buffalo-david-mamet-1235130707/',
    'https://www.nytimes.com/2025/11/07/opinion/culture/44-the-musical-review.html',
  ]) assert.equal(isNonReviewSectionUrl(u), false, u);
});

test('isNonReviewSectionUrl: titles that contain the word are not refused (BRO-7569 review)', () => {
  for (const u of ['https://www.nytimes.com/2026/03/01/theater/the-interview-broadway.html', 'https://www.telegraph.co.uk/theatre/what-to-see/the-interview-hampstead-theatre/']) assert.equal(isNonReviewSectionUrl(u), false, u);
});

import { createRequire as _cr7569b } from 'node:module';
import _t7569b from 'node:test';
import _a7569b from 'node:assert/strict';
{
  const m = _cr7569b(import.meta.url)('./serp-non-review-url.js');
  const fn = m.isNonReviewUrl || m.isNonReviewSerpUrl || Object.values(m).find((v) => typeof v === 'function');
  _t7569b('BRO-7569 review: a show titled "The Interview" is not refused by slug', () => {
    _a7569b.equal(fn('https://www.nytimes.com/2025/03/01/theater/the-interview-play.html'), false);
  });
}
