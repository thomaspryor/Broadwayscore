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
  looksLikeFeed,
  looksLikeSitemap,
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
  test('a book review of a novel tied to a show matches nothing (BRO-4656)', () => {
    const wicked = [{ id: 'wicked-2003', title: 'Wicked', status: 'open' }, { id: 'wicked-tour-2021', title: 'Wicked', status: 'open' }];
    assert.deepEqual(findMatchingShows("'Galinda: A Charmed Childhood' book review: Wicked's Glinda before the bubble",
      '/galinda-charmed-childhood-gregory-maguire-review/', wicked), []);
    // A theatre word keeps it: a stage review that compares the musical with the book.
    assert.equal(findMatchingShows('Wicked musical review: better than the book review crowd says', '/wicked-review/', wicked).length, 2);
    assert.equal(findMatchingShows('Review: Wicked still flies at the Fox', '/wicked-review-fox/', wicked).length, 2);
    const outsiders = [{ id: 'the-outsiders-2024', title: 'The Outsiders', status: 'open' }];
    assert.deepEqual(findMatchingShows("'Auslander' Review: The Lives of Outsiders", '/arts-culture/books/auslander-review-the-lives-of-outsiders-ae0ce2c2', outsiders), []);
  });

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

describe('findMatchingShows — whole-word matching (ship-check on #940)', () => {
  const shows = [
    { id: 'and-juliet-2022', title: '& Juliet', status: 'open' },
    { id: 'chess-2025', title: 'Chess', status: 'open' },
    { id: 'lean-to-off-broadway-2026', title: 'Lean-To', status: 'open' },
    { id: 'the-balusters-2026', title: 'The Balusters', status: 'open' },
    { id: 'hamilton-2015', title: 'Hamilton', status: 'open' },
  ];
  const ids = (h, u) => findMatchingShows(h, u, shows).map(s => s.id);

  test('"Romeo and Juliet" is not "& Juliet" (2026-09-27 live contamination)', () => {
    assert.deepEqual(ids('Romeo and Juliet review', '/reviews/romeo-and-juliet-review-new-vic-newcastle-under-lyme-russell-kane-not-too-tame'), []);
    assert.deepEqual(ids('& Juliet review', '/reviews/and-juliet-review-shaftesbury'), ['and-juliet-2022']);
  });

  test('a title inside a longer word does not match', () => {
    assert.deepEqual(ids('', '/reviews/white-rabbit-red-rabbit-duchess-theatre-review/'), []);
    assert.deepEqual(ids('', '/news/baby-wants-candy-shamilton-the-other-palace'), []);
  });

  test('slug-only and glued-slug matches still work', () => {
    assert.deepEqual(ids('', '/reviews/hamilton-review-victoria-palace'), ['hamilton-2015']);
    assert.deepEqual(ids('', '/2026/09/lean-to/'), ['lean-to-off-broadway-2026']);
    assert.deepEqual(ids('', '/page/world/TheBalusters.html'), ['the-balusters-2026']);
  });
});

// BRO-6340: a proxied retry can return a 200 block/interstitial page. It must be
// rejected (so the poller falls back to SERP) instead of parsing as an empty feed.
describe('looksLikeFeed', () => {
  test('accepts RSS 2.0, Atom and RSS 1.0 documents', () => {
    assert.equal(looksLikeFeed('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'), true);
    assert.equal(looksLikeFeed('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), true);
    assert.equal(looksLikeFeed('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>'), true);
  });
  test('rejects HTML pages, empty and missing content', () => {
    assert.equal(looksLikeFeed('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Access denied</body></html>'), false);
    assert.equal(looksLikeFeed('<html><body><a href="/feed">RSS feed</a></body></html>'), false);
    assert.equal(looksLikeFeed(''), false);
    assert.equal(looksLikeFeed(undefined), false);
    assert.equal(looksLikeFeed('<html><body><pre>&lt;rss&gt;</pre><rss version="2.0"></rss></body></html>'), false);
  });
  test('accepts a feed behind a BOM, stylesheet PI and comment', () => {
    assert.equal(looksLikeFeed('\uFEFF<?xml version="1.0"?>\n<?xml-stylesheet href="/feed.xsl"?>\n<!-- generator -->\n<rss version="2.0"></rss>'), true);
  });
});

describe('looksLikeSitemap', () => {
  test('accepts urlset and sitemapindex, rejects feeds and HTML', () => {
    assert.equal(looksLikeSitemap('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://observer.co.uk/</loc></url></urlset>'), true);
    assert.equal(looksLikeSitemap('<?xml version="1.0"?><sitemapindex></sitemapindex>'), true);
    assert.equal(looksLikeSitemap('<rss version="2.0"></rss>'), false);
    assert.equal(looksLikeSitemap('<!DOCTYPE html><html><body>403 Forbidden</body></html>'), false);
    assert.equal(looksLikeFeed('<urlset></urlset>'), false);
  });
});

// ---------------------------------------------------------------------------
// Feed staleness (BRO-6352): thewrap/observer feeds froze for 4 months while
// both outlets kept publishing; "0 items in window" read as "no reviews".
// ---------------------------------------------------------------------------

describe('feed staleness (BRO-6352)', async () => {
  const { isFeedStale, newestItemDate, latestReviewDateByOutlet } = require('../../scripts/lib/outlet-listing-helpers.js');
  const { buildFeedHealthReport } = require('../../scripts/outlet-listing-poller.js');
  const { evaluateOutletFeedHealth } = require('../../scripts/health-check.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const now = Date.parse('2026-10-25T12:00:00Z');

  test('alive outlet + stale feed → flagged', () => {
    assert.equal(isFeedStale({ newestFiltered: '2026-06-10', filteredCount: 12, latestReviewDate: '2026-10-24', now }), true);
  });
  test('alive outlet + feed with no matching items at all → flagged', () => {
    assert.equal(isFeedStale({ newestFiltered: null, filteredCount: 0, latestReviewDate: '2026-10-24', now }), true);
  });
  test('dead outlet + stale feed → not flagged', () => {
    assert.equal(isFeedStale({ newestFiltered: '2026-06-10', filteredCount: 12, latestReviewDate: '2026-08-01', now }), false);
    assert.equal(isFeedStale({ newestFiltered: '2026-06-10', filteredCount: 12, latestReviewDate: null, now }), false);
  });
  test('fresh feed → not flagged', () => {
    assert.equal(isFeedStale({ newestFiltered: '2026-10-20', filteredCount: 5, latestReviewDate: '2026-10-24', now }), false);
  });
  test('short site-wide feed with no matching item → not flagged; long one → flagged; unreadable feed → flagged', () => {
    assert.equal(isFeedStale({ newestFiltered: null, filteredCount: 0, newestAny: '2026-10-25', oldestAny: '2026-10-18', latestReviewDate: '2026-10-21', now }), false);
    assert.equal(isFeedStale({ newestFiltered: null, filteredCount: 0, newestAny: '2026-10-25', oldestAny: '2026-07-01', latestReviewDate: '2026-10-21', now }), true);
    assert.equal(isFeedStale({ newestFiltered: null, filteredCount: 0, newestAny: null, oldestAny: null, latestReviewDate: '2026-10-21', now }), true);
  });
  test('undated-but-present items → not flagged (nothing to compare)', () => {
    assert.equal(isFeedStale({ newestFiltered: null, filteredCount: 3, latestReviewDate: '2026-10-24', now }), false);
  });

  test('newestItemDate / latestReviewDateByOutlet ignore undated rows', () => {
    assert.equal(newestItemDate([{ publishDate: '2026-05-01' }, { publishDate: null }, { publishDate: '2026-06-02' }]), '2026-06-02');
    assert.equal(newestItemDate([{ publishDate: null }]), null);
    assert.deepEqual(latestReviewDateByOutlet([
      { outletId: 'thewrap', publishDate: '2026-10-24' }, { outletId: 'thewrap', publishDate: '2026-09-01' },
      { outletId: 'observer', publishDate: null }, { outletId: null, publishDate: '2026-10-01' },
    ]), { thewrap: '2026-10-24' });
  });

  test('parseRssFeed with an epoch cutoff sees the frozen feed\'s newest item', () => {
    const xml = '<rss><channel><item><link>https://x.com/a</link><title>A</title><pubDate>Tue, 10 Jun 2026 12:00:00 GMT</pubDate></item></channel></rss>';
    assert.equal(parseRssFeed(xml, new Date(now - 7 * 86400000)).length, 0);
    assert.equal(newestItemDate(parseRssFeed(xml, new Date(0))), '2026-06-10');
  });

  test('buildFeedHealthReport flags only alive outlets; fetch errors never count as stale; partial run merges', () => {
    const reviews = [{ outletId: 'thewrap', publishDate: '2026-10-24' }, { outletId: 'quiet', publishDate: '2026-03-01' }, { outletId: 'broken', publishDate: '2026-10-20' }];
    const health = {
      thewrap: { strategy: 'rss', url: 'u1', newestAny: '2026-06-10', newestFiltered: '2026-06-10', filteredCount: 4 },
      quiet: { strategy: 'rss', url: 'u2', newestAny: '2026-03-01', newestFiltered: '2026-03-01', filteredCount: 4 },
      broken: { strategy: 'sitemap', url: 'u3', newestAny: null, newestFiltered: null, error: 'HTTP 403' },
    };
    const day1 = buildFeedHealthReport(health, reviews, { now });
    assert.deepEqual(day1.failing, [], 'one failed fetch is not yet failing');
    const day2 = buildFeedHealthReport(health, reviews, { now, previous: day1 });
    const report = buildFeedHealthReport(health, reviews, { now, previous: day2 });
    assert.deepEqual(report.stale, ['thewrap']);
    assert.equal(report.outlets.broken.failStreak, 3);
    assert.deepEqual(report.failing, ['broken'], 'a live outlet whose feed errored 3 runs running is failing, never stale');
    assert.equal(Object.keys(report.outlets).length, 3);
    assert.equal(report.outlets.thewrap.latestReviewDate, '2026-10-24');

    const fresh = { thewrap: { strategy: 'rss', url: 'u1', newestAny: '2026-10-23', newestFiltered: '2026-10-23', filteredCount: 4 } };
    const merged = buildFeedHealthReport(fresh, reviews, { now, previous: report, partial: true });
    assert.deepEqual(merged.stale, []);
    assert.equal(Object.keys(merged.outlets).length, 3, 'a --outlets run keeps the other feeds');
  });

  test('health-check row: warn on stale, pass when clean or missing, warn when snapshot is old', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-health-'));
    const file = path.join(dir, 'outlet-feed-health.json');
    assert.equal(evaluateOutletFeedHealth({ filePath: file, now }).status, 'pass');
    const reviews = [{ outletId: 'thewrap', publishDate: '2026-10-24' }];
    const health = { thewrap: { strategy: 'rss', url: 'u1', newestAny: '2026-06-10', newestFiltered: '2026-06-10', filteredCount: 4 } };
    fs.writeFileSync(file, JSON.stringify(buildFeedHealthReport(health, reviews, { now })));
    const row = evaluateOutletFeedHealth({ filePath: file, now });
    assert.equal(row.status, 'warn');
    assert.match(row.message, /thewrap/);
    assert.equal(evaluateOutletFeedHealth({ filePath: file, now: now + 5 * 86400000 }).status, 'warn');
    fs.writeFileSync(file, JSON.stringify(buildFeedHealthReport({}, reviews, { now })));
    assert.equal(evaluateOutletFeedHealth({ filePath: file, now }).status, 'pass');
    const failingOnly = { thewrap: { strategy: 'rss', url: 'u1', newestAny: null, newestFiltered: null, error: 'direct fetch returned a non-rss page' } };
    let r = null;
    for (let i = 0; i < 3; i++) r = buildFeedHealthReport(failingOnly, reviews, { now, previous: r });
    fs.writeFileSync(file, JSON.stringify(r));
    assert.match(evaluateOutletFeedHealth({ filePath: file, now }).message, /1 failing: thewrap/);
  });
});
