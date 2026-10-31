import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { discoverShows, discoverFromSitemap, parseListingShows, parseSitemapSlugs } = require('../../scripts/lib/broadway-com-discovery');

const logger = { log() {} };
const slugs = ['hamilton', 'wicked', 'chicago', 'hadestown', 'the-lion-king', 'aladdin'];
const listing = (names) => names.map(slug => `<a href="/shows/${slug}/">${slug}</a>`).join('');
const sitemap = (names) => `<urlset>${names.map(slug => `<url><loc>https://www.broadway.com/shows/${slug}/</loc></url>`).join('')}</urlset>`;
const shell = '<html><body>' + 'x'.repeat(11000) + '</body></html>';
const challenge = '<html>Client Challenge</html>';

for (const [name, discover, page, url, renderJs] of [
  ['listing', discoverShows, listing, 'https://www.broadway.com/shows/tickets/', true],
  ['sitemap', discoverFromSitemap, sitemap, 'https://www.broadway.com/sitemap-shows.xml', false],
]) {
  const resultSlugs = (results) => results.map(result => typeof result === 'string' ? result : result.slug);
  const run = async (direct, fallback = page(slugs), status = 200) => {
    const calls = [];
    const results = await discover({
      httpsGet: async (requestedUrl) => {
        assert.equal(requestedUrl, url);
        return { status, data: direct };
      },
      fetchPage: async (...args) => {
        calls.push(args);
        return { content: fallback };
      },
      logger,
    });
    return { slugs: resultSlugs(results), calls };
  };

  test(`${name}: a healthy five-show response avoids fallback`, async () => {
    const result = await run(page(slugs.slice(0, 5)));
    assert.deepEqual(result.slugs, slugs.slice(0, 5));
    assert.deepEqual(result.calls, []);
  });

  for (const [shape, direct] of [
    ['full-size empty shell without challenge markers', shell],
    ['full-size sparse response', page(slugs.slice(0, 2)) + shell],
    ['four unique shows', page(slugs.slice(0, 4))],
    ['classic bot challenge', challenge],
  ]) {
    test(`${name}: ${shape} retries the shared scraper`, async () => {
      const result = await run(direct);
      assert.deepEqual(result.slugs, slugs);
      assert.deepEqual(result.calls, [[url, { renderJs }]]);
    });
  }

  test(`${name}: duplicate and utility URLs cannot inflate sparse discovery`, async () => {
    const result = await run(page(['tickets', ...Array(10).fill('hamilton')]));
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.slugs, slugs);
  });

  test(`${name}: a compact valid fallback is accepted without a byte-size gate`, async () => {
    const result = await run(shell, page(slugs));
    assert.deepEqual(result.slugs, slugs);
    assert.equal(result.calls.length, 1);
  });

  test(`${name}: partial fallback preserves and deduplicates direct results`, async () => {
    const result = await run(page(slugs.slice(0, 2)), page(slugs.slice(1, 3)));
    assert.deepEqual(result.slugs, slugs.slice(0, 3));
    assert.equal(result.calls.length, 1);
  });

  test(`${name}: a degraded fallback never discards direct results`, async () => {
    const result = await run(page(slugs.slice(0, 2)), shell);
    assert.deepEqual(result.slugs, slugs.slice(0, 2));
    assert.equal(result.calls.length, 1);
  });

  test(`${name}: a challenge returned by fallback is not accepted as recovered content`, async () => {
    const result = await run(page(slugs.slice(0, 2)), challenge);
    assert.deepEqual(result.slugs, slugs.slice(0, 2));
    assert.equal(result.calls.length, 1);
  });
}

test('listing parser preserves titles, entity decoding, deduplication and utility filtering', () => {
  assert.deepEqual(parseListingShows('<a href="/shows/hamilton/">Hamilton &amp; Friends&#39; &quot;Show&quot;</a>' +
    '<a href="/shows/hamilton/">Duplicate</a><a href="/shows/tickets/">Tickets</a>' +
    '<a href="/shows/nav/">Shows</a><a href="/shows/empty/"> </a>'), [{
    title: 'Hamilton & Friends\' "Show"', slug: 'hamilton', url: 'https://www.broadway.com/shows/hamilton/',
  }]);
});

test('sitemap retries even when URL tags contain no usable show URLs', async () => {
  let calls = 0;
  const result = await discoverFromSitemap({
    httpsGet: async () => ({ status: 200, data: '<urlset><url><loc>https://www.broadway.com/</loc></url></urlset>' }),
    fetchPage: async () => { calls++; return { content: sitemap(slugs) }; }, logger,
  });
  assert.deepEqual(result, slugs);
  assert.equal(calls, 1);
});

test('sitemap parser rejects HTML navigation, utility URLs, and other hosts', () => {
  assert.deepEqual(parseSitemapSlugs(listing(slugs)), []);
  assert.deepEqual(parseSitemapSlugs('<urlset>' +
    '<url><loc>https://other-broadway.com/shows/hamilton/</loc></url>' +
    '<url><loc>https://www.broadway.com/shows/tickets/</loc></url></urlset>'), []);
});

test('listing fails safely if both fetches contain no shows', async () => {
  await assert.rejects(discoverShows({
    httpsGet: async () => ({ status: 200, data: shell }),
    fetchPage: async () => ({ content: shell }), logger,
  }), /no shows and scraper fallback failed/);
});

test('listing still rejects non-200 direct responses', async () => {
  await assert.rejects(discoverShows({
    httpsGet: async () => ({ status: 503, data: shell }),
    fetchPage: async () => assert.fail('HTTP failure must abort'), logger,
  }), /returned 503/);
});

test('sitemap stays optional if the fallback throws, preserving any direct slugs', async () => {
  for (const directSlugs of [[], slugs.slice(0, 2)]) {
    const result = await discoverFromSitemap({
      httpsGet: async () => ({ status: 200, data: sitemap(directSlugs) }),
      fetchPage: async () => { throw new Error('fallback unavailable'); }, logger,
    });
    assert.deepEqual(result, directSlugs);
  }
});

test('sitemap returns no slugs when both fetches lack valid entries', async () => {
  const result = await discoverFromSitemap({
    httpsGet: async () => ({ status: 200, data: shell }),
    fetchPage: async () => null, logger,
  });
  assert.deepEqual(result, []);
});
