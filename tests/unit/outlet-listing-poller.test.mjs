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
