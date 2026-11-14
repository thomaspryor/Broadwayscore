import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// BRO-4715: opening-night discovery missed Vulture T1 reviews for Off-Broadway
// shows (10/5/2026) because (a) the vulture endpoint only kept slugs containing
// "review", (b) "Kramer/Fauci" never matched slug "kramer-fauci", and (c) the
// section page was fetched via ScrapingBee only. Slugs below are the real ones
// from https://www.vulture.com/theater/ on 2026-10-05.
const require = createRequire(import.meta.url);
const scraperPath = require.resolve('../../scripts/lib/scraper.js');
const INDEX_HTML = `
<a href="//www.vulture.com/article/slam-frank-play-musical-review-orpheum.html">Slam Frank</a>
<a href="https://www.vulture.com/article/kramer-fauci-daniel-fish-play-st-anns-nyc.html">Kramer/Fauci</a>
<a href="https://www.vulture.com/article/oneill-the-hairy-ape-irish-rep-oreilly.html?utm=x#c">Hairy Ape</a>
<a href="https://www.vulture.com/article/denee-benton-interview-school-girls-the-gilded-age.html">interview</a>
<a href="https://www.vulture.com/article/duncan-sheik-dies-spring-awakening-composer.html">obit</a>
<a href="https://www.vulture.com/article/about-us.html">about</a>
<a href="https://www.vulture.com/article/the-dead-1904-play-review.html">title contains "dead"</a>`;

// Stub the scraper chain so no network is touched; fetchPage returns {content}.
const realScraper = require(scraperPath);
require.cache[scraperPath].exports = { ...realScraper, fetchPage: async () => ({ content: INDEX_HTML }) };
const { searchOutletSite, extractVultureTheaterArticleUrls } = require('../../scripts/lib/site-search-discovery.js');
const { urlLooksLikeReview } = require('../../scripts/lib/review-guards.js');

test('extractor keeps non-"review" slugs, normalizes URLs, drops non-reviews', () => {
  const urls = extractVultureTheaterArticleUrls(INDEX_HTML);
  assert.ok(urls.includes('https://www.vulture.com/article/slam-frank-play-musical-review-orpheum.html'));
  assert.ok(urls.includes('https://www.vulture.com/article/kramer-fauci-daniel-fish-play-st-anns-nyc.html'));
  assert.ok(urls.includes('https://www.vulture.com/article/oneill-the-hairy-ape-irish-rep-oreilly.html'));
  assert.ok(urls.includes('https://www.vulture.com/article/the-dead-1904-play-review.html'), 'show titles containing dead must not be excluded');
  assert.equal(urls.length, 4, `unexpected: ${urls.join(' ')}`);
  assert.deepEqual(extractVultureTheaterArticleUrls(''), []);
  assert.deepEqual(extractVultureTheaterArticleUrls(null), []);
});

for (const [title, slug] of [
  ['Kramer/Fauci', 'kramer-fauci-daniel-fish-play-st-anns-nyc'],
  ['The Hairy Ape', 'oneill-the-hairy-ape-irish-rep-oreilly'],
  ['Slam Frank', 'slam-frank-play-musical-review-orpheum'],
]) {
  test(`searchOutletSite('vulture') discovers ${title} from the theater index`, async () => {
    const res = await searchOutletSite('vulture', title, { market: 'broadway', show: { id: 'x', type: 'play' } });
    assert.equal(res.length, 1, JSON.stringify(res));
    assert.equal(res[0].url, `https://www.vulture.com/article/${slug}.html`);
    assert.equal(res[0].outletId, 'vulture');
  });
}

test('slash-joined titles: split and joined slugs both match; no fail-open for AC/DC', () => {
  assert.ok(urlLooksLikeReview('https://www.vulture.com/article/kramer-fauci-x.html', 'Kramer/Fauci'));
  assert.ok(urlLooksLikeReview('https://www.vulture.com/article/kramerfauci-theater-review.html', 'Kramer/Fauci'));
  assert.ok(!urlLooksLikeReview('https://www.vulture.com/article/fauci-only.html', 'Kramer/Fauci'));
  assert.ok(!urlLooksLikeReview('https://www.vulture.com/article/unrelated-thing.html', 'Kramer/Fauci'));
  assert.ok(!urlLooksLikeReview('https://www.vulture.com/article/unrelated-thing.html', 'Slam Frank'));
});
