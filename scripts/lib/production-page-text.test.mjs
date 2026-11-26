/** production-page-text (BRO-7833). Colocated so CI's scripts/lib/*.test.mjs glob runs it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { productionPageUrls, extractProductionPageText, fetchProductionPageText, isReviewUrl } = require('./production-page-text.js');

test('picks discovery listing pages and venue show pages, never review articles', () => {
  const urls = productionPageUrls({
    evidenceUrls: [
      'https://www.theguardian.com/stage/2026/sep/03/present-laughter-review',
      'https://www.broadwayworld.com/chicago/article/Review-LITTLE-SHOP-20261109',
      'https://www.thestage.co.uk/reviews/the-39-steps-review',
      'https://www.theatreinchicago.com/all-the-world/13594/',
      'https://americanrepertorytheater.org/shows-events/1972-a-rock-opera/',
    ],
  });
  assert.deepEqual(urls, [
    'https://www.theatreinchicago.com/all-the-world/13594/',
    'https://americanrepertorytheater.org/shows-events/1972-a-rock-opera/',
  ]);
});

test('a bare venue homepage officialUrl describes no show; a show-page officialUrl counts', () => {
  assert.deepEqual(productionPageUrls({ officialUrl: 'https://northlight.org/' }), []);
  assert.deepEqual(productionPageUrls({ officialUrl: 'https://www.diversionary.org/arrowhead' }), ['https://www.diversionary.org/arrowhead']);
  assert.equal(isReviewUrl('https://example.org/blog/our-new-season'), true);
  assert.equal(isReviewUrl('not a url'), true);
});

test('extracts meta, JSON-LD and long body paragraphs, drops scripts/nav and duplicates', () => {
  const story = 'After Hannah barely escapes an illegal abortion, she meets the Janes, an underground network of women.';
  const html = `<html><head>
    <meta name="description" content="${story}">
    <meta property="og:description" content="${story}">
    <script type="application/ld+json">{"@type":"Event","description":"A rock opera set in 1972 Chicago about choice and courage."}</script>
    <script>var p = "<p>${'x'.repeat(200)}</p>";</script></head>
    <body><nav><p>${'Menu item '.repeat(20)}</p></nav>
    <p>${story} Together they fight for the right to choose, whatever the cost to themselves.</p>
    <p>Short.</p></body></html>`;
  const text = extractProductionPageText(html);
  assert.match(text, /Together they fight/);
  assert.match(text, /rock opera set in 1972/);
  assert.doesNotMatch(text, /Menu item/);
  assert.doesNotMatch(text, /xxxx/);
  // the meta copy is folded into the longer paragraph that contains it
  assert.equal(text.split(story).length - 1, 1);
  assert.equal(extractProductionPageText(''), '');
});

test('fetchProductionPageText moves past a failed or empty page to the next one', async () => {
  const show = { evidenceUrls: ['https://a.example/show/x', 'https://b.example/show/x'] };
  const seen = [];
  const page = await fetchProductionPageText(show, async (u) => {
    seen.push(u);
    if (u.startsWith('https://a.')) throw new Error('blocked');
    return `<p>${'Two actors find themselves in an ever-shifting relationship during the holidays. '.repeat(2)}</p>`;
  });
  assert.deepEqual(seen, ['https://a.example/show/x', 'https://b.example/show/x']);
  assert.equal(page.url, 'https://b.example/show/x');
  assert.match(page.text, /ever-shifting relationship/);
  assert.equal(await fetchProductionPageText({}, async () => '<p>x</p>'), null);
});
