/**
 * Tests for outlet-listing-poller helpers.
 * Run: node --test tests/unit/outlet-listing-poller.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findMatchingShows,
  parseRssFeed,
  parseWpApiPosts,
  parseSitemapXml,
  extractListingUrls,
  buildSerpQuery,
  mergeAlwaysOnOutlets,
} = require('../../scripts/lib/outlet-listing-helpers.js');

// ---------------------------------------------------------------------------
// findMatchingShows
// ---------------------------------------------------------------------------

describe('findMatchingShows', () => {
  const shows = [
    { id: 'new-born-off-broadway-2026', title: 'New Born', status: 'open' },
    { id: 'what-happened-was-off-broadway-2026', title: 'What Happened Was', status: 'open' },
    { id: 'six-broadway-2022', title: 'Six', status: 'open' },
    { id: 'chicago-2024', title: 'Chicago', status: 'open' },
    { id: 'rent-revival', title: 'Rent', status: 'open' },
    { id: 'suffs-2023', title: 'Suffs', status: 'open' },
    { id: 'job-off-broadway-2025', title: 'Job', status: 'open' },
    { id: 'giant-2026', title: 'Giant', status: 'open' },
    { id: 'redwood-broadway-2025', title: 'Redwood', status: 'open' },
    { id: 'buena-vista-social-club-2024', title: 'Buena Vista Social Club', status: 'open' },
  ];

  test('matches dual-show WSJ article to both shows', () => {
    const headline = 'New Born and What Happened Was Review: Complicated Relationships';
    const urlSlug = '/articles/new-born-and-what-happened-was-reviews-complicated-relationships-a8f3ecb8';
    const matched = findMatchingShows(headline, urlSlug, shows);
    const ids = matched.map(s => s.id);
    assert.ok(ids.includes('new-born-off-broadway-2026'), 'should match New Born');
    assert.ok(ids.includes('what-happened-was-off-broadway-2026'), 'should match What Happened Was');
    assert.equal(matched.length, 2, 'should only match 2 shows');
  });

  test('matches dual-show NYSR article to both shows', () => {
    const headline = 'What Happened Was and New Born: A Showcase for Fine Actors at the Minetta Lane';
    const urlSlug = '/2026/05/14/what-happened-was-and-new-born-a-showcase-for-fine-actors-at-the-minetta-lane/';
    const matched = findMatchingShows(headline, urlSlug, shows);
    const ids = matched.map(s => s.id);
    assert.ok(ids.includes('new-born-off-broadway-2026'), 'should match New Born');
    assert.ok(ids.includes('what-happened-was-off-broadway-2026'), 'should match What Happened Was');
  });

  test('single-show article matches only that show', () => {
    const headline = 'Suffs Review: Revolutionary Musical Electrifies';
    const urlSlug = '/theater/suffs-review-2023';
    const matched = findMatchingShows(headline, urlSlug, shows);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].id, 'suffs-2023');
  });

  test('does NOT match Six from general article mentioning six actors', () => {
    const headline = 'Best Theater Performances of the Year: Six Standout Roles';
    const urlSlug = '/theater/best-performances-2026';
    const matched = findMatchingShows(headline, urlSlug, shows);
    const ids = matched.map(s => s.id);
    assert.ok(!ids.includes('six-broadway-2022'), 'Six should not false-match "six standout roles"');
  });

  test('does NOT match Chicago from article about Chicago the city', () => {
    const headline = 'Chicago Theater Scene Roundup: What to See This Week';
    const urlSlug = '/theater/chicago-theater-roundup';
    const matched = findMatchingShows(headline, urlSlug, shows);
    const ids = matched.map(s => s.id);
    assert.ok(!ids.includes('chicago-2024'), 'Chicago should not match "chicago theater scene"');
  });

  test('does NOT match Rent from article mentioning rent as word', () => {
    const headline = 'Affordable Theater: Shows You Can See Without Paying Rent';
    const urlSlug = '/theater/affordable-shows-2026';
    const matched = findMatchingShows(headline, urlSlug, shows);
    const ids = matched.map(s => s.id);
    assert.ok(!ids.includes('rent-revival'), 'Rent should not match "paying rent"');
  });

  test('does NOT match Job or Giant (short single-word titles not in common set)', () => {
    const headline = 'Looking for a job in theater can be a giant undertaking';
    const urlSlug = '/feature/theater-careers-2026';
    const matched = findMatchingShows(headline, urlSlug, shows);
    const ids = matched.map(s => s.id);
    assert.ok(!ids.includes('job-off-broadway-2025'), 'Job should not match "job in theater"');
    assert.ok(!ids.includes('giant-2026'), 'Giant should not match "giant undertaking"');
  });

  test('matches multi-word title Buena Vista Social Club', () => {
    const headline = 'Buena Vista Social Club Review: A Joyful Evening';
    const urlSlug = '/theater/buena-vista-social-club-review';
    const matched = findMatchingShows(headline, urlSlug, shows);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].id, 'buena-vista-social-club-2024');
  });

  test('returns empty array for unrelated article', () => {
    const headline = 'Broadway Box Office Results: Grosses Up 10% This Week';
    const urlSlug = '/news/broadway-grosses-may-2026';
    const matched = findMatchingShows(headline, urlSlug, shows);
    assert.equal(matched.length, 0);
  });

  test('returns empty array for empty inputs', () => {
    assert.deepEqual(findMatchingShows('', '', shows), []);
    assert.deepEqual(findMatchingShows(null, null, shows), []);
  });
});

// ---------------------------------------------------------------------------
// parseRssFeed
// ---------------------------------------------------------------------------

describe('parseRssFeed', () => {
  const RECENT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
  const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);   // 30 days ago
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

  test('parses RSS 2.0 items within window', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>Suffs Review</title><link>https://vulture.com/suffs-review</link><pubDate>${RECENT.toUTCString()}</pubDate></item>
<item><title>Old Review</title><link>https://vulture.com/old-review</link><pubDate>${OLD.toUTCString()}</pubDate></item>
</channel></rss>`;
    const items = parseRssFeed(xml, cutoff);
    assert.equal(items.length, 1);
    assert.equal(items[0].url, 'https://vulture.com/suffs-review');
    assert.equal(items[0].headline, 'Suffs Review');
  });

  test('handles CDATA in title', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title><![CDATA[New Born & What Happened Was Review]]></title><link>https://guardian.com/review</link><pubDate>${RECENT.toUTCString()}</pubDate></item>
</channel></rss>`;
    const items = parseRssFeed(xml, cutoff);
    assert.equal(items.length, 1);
    assert.equal(items[0].headline, 'New Born & What Happened Was Review');
  });

  test('excludes items older than cutoff', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>Old Review</title><link>https://vulture.com/old</link><pubDate>${OLD.toUTCString()}</pubDate></item>
</channel></rss>`;
    const items = parseRssFeed(xml, cutoff);
    assert.equal(items.length, 0);
  });
});

// ---------------------------------------------------------------------------
// parseWpApiPosts
// ---------------------------------------------------------------------------

describe('parseWpApiPosts', () => {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  test('parses WP API posts within window', () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const posts = [
      { link: 'https://nystagereview.com/review-1', title: { rendered: 'New Born Review' }, date: recent },
      { link: 'https://nystagereview.com/old-review', title: { rendered: 'Old Review' }, date: old },
    ];
    const items = parseWpApiPosts(posts, cutoff);
    assert.equal(items.length, 1);
    assert.equal(items[0].url, 'https://nystagereview.com/review-1');
  });

  test('strips HTML from rendered title', () => {
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const posts = [{ link: 'https://nysr.com/r', title: { rendered: '<em>Suffs</em> Review' }, date: recent }];
    const items = parseWpApiPosts(posts, cutoff);
    assert.equal(items[0].headline, 'Suffs Review');
  });
});

// ---------------------------------------------------------------------------
// parseSitemapXml
// ---------------------------------------------------------------------------

describe('parseSitemapXml', () => {
  const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const OLD    = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  test('returns URLs within cutoff matching urlFilter', () => {
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://www.vulture.com/article/suffs-theater-review-2026.html</loc><lastmod>${RECENT}</lastmod></url>
  <url><loc>https://www.vulture.com/article/old-theater-review.html</loc><lastmod>${OLD}</lastmod></url>
  <url><loc>https://www.vulture.com/article/not-a-review.html</loc><lastmod>${RECENT}</lastmod></url>
</urlset>`;
    const items = parseSitemapXml(xml, cutoff, /theater-review/);
    assert.equal(items.length, 1);
    assert.equal(items[0].url, 'https://www.vulture.com/article/suffs-theater-review-2026.html');
  });

  test('includes entries with no <lastmod> (do not silently drop)', () => {
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://www.vulture.com/article/new-theater-review.html</loc></url>
</urlset>`;
    const items = parseSitemapXml(xml, cutoff, /theater-review/);
    assert.equal(items.length, 1, 'should include URL with no lastmod');
    assert.equal(items[0].publishDate, null);
  });

  test('excludes URLs not matching urlFilter', () => {
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://www.vulture.com/article/film-review.html</loc><lastmod>${RECENT}</lastmod></url>
</urlset>`;
    const items = parseSitemapXml(xml, cutoff, /theater-review/);
    assert.equal(items.length, 0);
  });

  test('works without urlFilter (returns all in-window URLs)', () => {
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://example.com/article-one</loc><lastmod>${RECENT}</lastmod></url>
  <url><loc>https://example.com/article-two</loc><lastmod>${OLD}</lastmod></url>
</urlset>`;
    const items = parseSitemapXml(xml, cutoff);
    assert.equal(items.length, 1);
  });
});

// ---------------------------------------------------------------------------
// parseRssFeed — urlFilter and titleFilter (S1-T2/T3 config options)
// ---------------------------------------------------------------------------

describe('parseRssFeed with filters applied by caller', () => {
  const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toUTCString();
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  test('urlFilter keeps review URLs, drops non-review URLs (theatermania pattern)', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>Suffs Review</title><link>https://theatermania.com/news/review-suffs-2026</link><pubDate>${RECENT}</pubDate></item>
<item><title>Opening Night Tonight</title><link>https://theatermania.com/news/opening-suffs</link><pubDate>${RECENT}</pubDate></item>
</channel></rss>`;
    const urlFilter = /\/news\/review-/;
    const items = parseRssFeed(xml, cutoff).filter(i => urlFilter.test(i.url));
    assert.equal(items.length, 1);
    assert.ok(items[0].url.includes('/news/review-'));
  });

  test('titleFilter keeps articles with "review" in title, drops features (nytimes pattern)', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>Suffs Review: Revolutionary</title><link>https://nytimes.com/suffs-review</link><pubDate>${RECENT}</pubDate></item>
<item><title>Broadway Season in Review</title><link>https://nytimes.com/season-roundup</link><pubDate>${RECENT}</pubDate></item>
<item><title>Opening Night for New Born</title><link>https://nytimes.com/new-born-opening</link><pubDate>${RECENT}</pubDate></item>
</channel></rss>`;
    const titleFilter = /\b(review|critic['']?s\s+pick)\b/i;
    const items = parseRssFeed(xml, cutoff).filter(i => titleFilter.test(i.headline));
    assert.equal(items.length, 2, 'should match "Suffs Review" and "Season in Review"');
    assert.ok(items.every(i => titleFilter.test(i.headline)));
  });
});

// ---------------------------------------------------------------------------
// extractListingUrls — dedup behavior (image-only vs text anchors)
// ---------------------------------------------------------------------------

describe('extractListingUrls', () => {
  test('image-only anchor does not block text anchor for same URL', () => {
    // Before the dedup fix, the image anchor (empty headline) was added to
    // seen first, causing the text anchor to be silently skipped.
    const html = `
      <a href="/reviews/suffs-review"><img src="suffs.jpg" alt="Suffs"></a>
      <a href="/reviews/suffs-review">Suffs Review: Electrifying</a>
    `;
    const items = extractListingUrls(html, 'thestage.co.uk');
    assert.equal(items.length, 1, 'should return exactly 1 item (deduped)');
    assert.equal(items[0].headline, 'Suffs Review: Electrifying');
  });

  test('two text anchors for same URL yield only one result', () => {
    const html = `
      <a href="/reviews/suffs-review">Suffs Review: Electrifying</a>
      <a href="/reviews/suffs-review">Suffs Review: Electrifying</a>
    `;
    const items = extractListingUrls(html, 'thestage.co.uk');
    assert.equal(items.length, 1);
  });

  test('thestage urlFilter /\\/reviews\\/[^/]+/ keeps review URLs, drops /review-round-ups/', () => {
    const html = `
      <a href="/reviews/suffs-review">Suffs Review</a>
      <a href="/review-round-ups/romeo-and-juliet-round-up">Romeo Roundup</a>
      <a href="/reviews/new-born-review-2026">New Born Review</a>
    `;
    const urlFilter = /\/reviews\/[^/]+/;
    const items = extractListingUrls(html, 'thestage.co.uk')
      .filter(i => urlFilter.test(i.url));
    assert.equal(items.length, 2);
    assert.ok(items.every(i => i.url.includes('/reviews/')));
    assert.ok(!items.some(i => i.url.includes('/review-round-ups/')));
  });
});

// ---------------------------------------------------------------------------
// buildSerpQuery — UK vs US spelling
// ---------------------------------------------------------------------------

describe('buildSerpQuery', () => {
  test('uses "theatre" for .co.uk domains', () => {
    const q = buildSerpQuery('thestage.co.uk');
    assert.ok(q.includes('theatre'), `expected "theatre" in "${q}"`);
    assert.ok(!q.includes('theater'), `unexpected "theater" in "${q}"`);
  });

  test('uses "theater" for US domains', () => {
    const q = buildSerpQuery('theatermania.com');
    assert.ok(q.includes('theater'), `expected "theater" in "${q}"`);
    assert.ok(!q.includes('theatre review'), `unexpected "theatre" in "${q}"`);
  });

  test('uses "theater" for times-uk if domain is not .co.uk', () => {
    const q = buildSerpQuery('thetimes.com');
    assert.ok(q.includes('theater'));
  });

  test('includes site: prefix', () => {
    const q = buildSerpQuery('thestage.co.uk');
    assert.ok(q.startsWith('site:thestage.co.uk'));
  });
});

// ---------------------------------------------------------------------------
// mergeAlwaysOnOutlets — configured outlets are polled regardless of volume gate
// (regression: The Recs' late 5-star Lost Boys review was missed because the
//  outlet fell below the ≥5-shows derived-qualifying gate and was never polled)
// ---------------------------------------------------------------------------

describe('mergeAlwaysOnOutlets', () => {
  test('always includes configured outlets even when not derived', () => {
    const derived = ['nytimes', 'variety'];
    const configured = ['the-recs', 'nytimes', 'guardian'];
    const out = mergeAlwaysOnOutlets(derived, configured, new Set());
    assert.ok(out.includes('the-recs'), 'the-recs must be polled even below the volume gate');
    assert.ok(out.includes('guardian'));
  });

  test('dedupes outlets present in both sources', () => {
    const out = mergeAlwaysOnOutlets(['nytimes'], ['nytimes', 'the-recs'], new Set());
    assert.equal(out.filter(x => x === 'nytimes').length, 1);
  });

  test('preserves derived-first ordering, then new configured', () => {
    const out = mergeAlwaysOnOutlets(['a', 'b'], ['b', 'c'], new Set());
    assert.deepEqual(out, ['a', 'b', 'c']);
  });

  test('excludes skip-listed outlets from both sources', () => {
    const out = mergeAlwaysOnOutlets(['a', 'broadwayworld'], ['the-recs', 'broadwayworld'], new Set(['broadwayworld']));
    assert.ok(!out.includes('broadwayworld'));
    assert.ok(out.includes('the-recs'));
  });

  test('drops falsy ids', () => {
    const out = mergeAlwaysOnOutlets(['a', null, ''], ['the-recs', undefined], new Set());
    assert.deepEqual(out, ['a', 'the-recs']);
  });
});
