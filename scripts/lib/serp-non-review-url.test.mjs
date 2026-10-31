// BRO-6606: the five non-review URLs the UK SERP pass ingested must be refused; real reviews stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNonReviewUrl } = require('./serp-non-review-url.js');

test('refuses film-fan, book shop and announcement URLs', () => {
  for (const u of [
    'https://letterboxd.com/pattinsins/film/the-little-mermaid-2023/',
    'https://timesbookshop.co.uk/pig-heart-boy-9781839044472/',
    'https://cineramafilm.com/2025/02/06/malorie-blackmans-pig-heart-boy-uk-tour/',
    'https://theatreweekly.com/full-details-announced-for-jekyll-hyde-at-liverpool-everyman-this-july/',
    'https://www.theatre-news.com/news/UK/125287/Adrian-Lukis-returns-as-Jane-Austen-s-most-infamous-rogue-in-Being-Mr-Wickham',
  ]) assert.equal(isNonReviewUrl(u), true, u);
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
  ]) assert.equal(isNonReviewUrl(u), false, u);
});

test('a malformed percent escape does not throw', () => {
  assert.doesNotThrow(() => isNonReviewUrl('https://example.com/a%E0%A4b'));
});
