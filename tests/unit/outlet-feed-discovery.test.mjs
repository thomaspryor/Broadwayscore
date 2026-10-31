/**
 * BRO-4185: feed-first outlet discovery.
 * Run: node --test tests/unit/outlet-feed-discovery.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseRssFeed } = require('../../scripts/lib/outlet-listing-helpers.js');
const {
  extractFeedLinksFromHtml,
  squarespaceCollectionFeeds,
  feedCandidateUrls,
  summarizeFeed,
} = require('../../scripts/probe-outlet-feeds.js');
const { isSameUrlFlaggedTarget, OUTLET_STRATEGY_CONFIG, SKIP_OUTLETS } = require('../../scripts/outlet-listing-poller.js');
const { generateReviewFilename } = require('../../scripts/lib/review-normalization.js');
const { findMatchingShows } = require('../../scripts/lib/outlet-listing-helpers.js');
const { titleMatchesShow } = require('../../scripts/lib/rss-discovery.js');

// Real headlines/slugs from the 2026-09-27 live probe (BRO-4185).
describe('headline/slug matching across hyphens', () => {
  const deepHeat = { id: 'deep-heat-rivalry-off-west-end-2026', title: 'Deep Heat Rivalry', status: 'open' };
  const holes = { id: 'the-holes-off-broadway-2026', title: 'The Holes', status: 'open' };
  const awhy = { id: 'america-who-hurt-you-off-broadway-2026', title: 'America, Who Hurt You?', status: 'open' };
  const heat = { id: 'heat-x', title: 'Heatwave', status: 'open' };
  const shows = [deepHeat, holes, awhy, heat];

  test('poller: hyphenated headline matches the spaced title', () => {
    const ids = findMatchingShows('Review: Deep-Heat Rivalry at The Other Palace Studio', '/review-deep-heat-rivalry-at-the-other-palace-studio/', shows).map(s => s.id);
    assert.deepEqual(ids, [deepHeat.id]);
  });

  test('poller: a multi-word title now matches from the URL slug alone', () => {
    const ids = findMatchingShows('The world has a group chat about America', '/america-who-hurt-you-sarah-jones-review/', shows).map(s => s.id);
    assert.ok(ids.includes(awhy.id));
  });

  test('poller: the spaced form is word-bounded ("deep heat" does not match "deep-heatwave")', () => {
    const deepHeatOnly = { id: 'deep-heat-x', title: 'Deep Heat', status: 'open' };
    assert.deepEqual(findMatchingShows('', '/deep-heatwave-review/', [deepHeatOnly]).map(s => s.id), []);
    assert.deepEqual(findMatchingShows('', '/deep-heat-review/', [deepHeatOnly]).map(s => s.id), ['deep-heat-x']);
  });

  test('rss-discovery: hyphenated headline matches; curly apostrophes fold', () => {
    assert.equal(titleMatchesShow('Deep-Heat Rivalry – The Other Palace, London', 'Deep Heat Rivalry'), true);
    assert.equal(titleMatchesShow('I’m Every Woman: The Chaka Khan Musical – review', "I'm Every Woman"), true);
  });

  test('rss-discovery: a repeated-word title ("Man to Man") needs the whole phrase', () => {
    for (const h of ['‘Star Wars’ Is Continuing Skywalker Saga With ‘Spider-Man’ Director Jon Watts', 'MAN AND BOY. Dorfman, SE1', 'Review: The Last Man at Southwark Playhouse Elephant']) {
      assert.equal(titleMatchesShow(h, 'Man to Man'), false, h);
    }
    assert.equal(titleMatchesShow('Man to Man – Royal Court review', 'Man to Man'), true);
  });
});

const EPOCH = new Date(0);

describe('parseRssFeed hardening', () => {
  test('unparseable pubDate no longer throws; item kept with null date', () => {
    const xml = '<rss><channel><item><title>Review: X</title><link>https://a.com/x</link><pubDate>not a date</pubDate></item></channel></rss>';
    const items = parseRssFeed(xml, new Date('2026-09-01'));
    assert.equal(items.length, 1);
    assert.equal(items[0].publishDate, null);
  });

  test('RSS 1.0 <item rdf:about> is parsed', () => {
    const xml = '<rdf:RDF><item rdf:about="https://a.com/y"><title>Y</title><link>https://a.com/y</link></item></rdf:RDF>';
    assert.deepEqual(parseRssFeed(xml, EPOCH).map(i => i.url), ['https://a.com/y']);
  });

  test("Atom single-quoted href (Blogger) resolves to the alternate link, not the tag: id", () => {
    const xml = "<feed><entry><id>tag:blogger.com,1999:post-1</id><published>2026-09-24T10:00:00Z</published>"
      + "<link rel='replies' href='https://b.com/x#comments'/><link rel='alternate' href='https://b.com/2026/09/review.html'/>"
      + '<title>Theater Review</title></entry></feed>';
    const items = parseRssFeed(xml, EPOCH);
    assert.deepEqual(items.map(i => i.url), ['https://b.com/2026/09/review.html']);
    assert.equal(items[0].publishDate, '2026-09-24');
  });

  test('plain Squarespace RSS item still parses (regression)', () => {
    const xml = '<rss><channel><item><title>The Holes</title><link>https://www.offoffonline.com/offoffonline/2026/9/24/holes</link>'
      + '<pubDate>Thu, 24 Sep 2026 14:00:00 +0000</pubDate></item></channel></rss>';
    const items = parseRssFeed(xml, new Date('2026-09-20'));
    assert.equal(items.length, 1);
    assert.equal(items[0].publishDate, '2026-09-24');
  });

  test('<items> container is not mistaken for an item', () => {
    const xml = '<rss><items><foo/></items></rss>';
    assert.equal(parseRssFeed(xml, EPOCH).length, 0);
  });
});

describe('probe helpers', () => {
  const html = `<html><head>
    <link rel="alternate" type="application/rss+xml" title="Feed" href="/feed/" />
    <link rel="alternate" type="application/rss+xml" title="Comments" href="https://x.com/comments/feed/" />
    <link rel='alternate' type='application/atom+xml' href='https://x.com/atom.xml'>
    <link rel="stylesheet" href="/style.css">
  </head></html>`;

  test('extractFeedLinksFromHtml resolves relative, drops comment feeds and non-feeds', () => {
    assert.deepEqual(extractFeedLinksFromHtml(html, 'https://x.com/'), ['https://x.com/feed/', 'https://x.com/atom.xml']);
  });

  test('squarespaceCollectionFeeds only fires on Squarespace pages', () => {
    assert.deepEqual(squarespaceCollectionFeeds('<a href="/news">News</a>', 'https://s.com/'), []);
    const sq = '<script src="https://static1.squarespace.com/x.js"></script><a href="/offoffonline">Reviews</a><a href="/about/">About</a><a href="/a/b">deep</a>';
    assert.deepEqual(squarespaceCollectionFeeds(sq, 'https://s.com/'),
      ['https://s.com/offoffonline?format=rss', 'https://s.com/about?format=rss']);
  });

  test('feedCandidateUrls: declared alternates first, deduped against common paths', () => {
    const c = feedCandidateUrls('x.com', html);
    assert.equal(c[0], 'https://x.com/feed/');
    assert.equal(c.filter(u => u === 'https://x.com/feed/').length, 1);
    assert.ok(c.includes('https://x.com/rss.xml'));
  });

  test('summarizeFeed rejects HTML soft-404s and empty feeds, counts review-ish items', () => {
    assert.equal(summarizeFeed('<html><body><item>not xml feed</item></body></html>'), null);
    assert.equal(summarizeFeed('<rss><channel></channel></rss>'), null);
    const s = summarizeFeed('<?xml version="1.0"?><rss><channel>'
      + '<item><title>Review: A</title><link>https://a.com/review-a</link><pubDate>Fri, 25 Sep 2026 10:00:00 GMT</pubDate></item>'
      + '<item><title>News</title><link>https://a.com/news</link></item></channel></rss>');
    assert.equal(s.itemCount, 2);
    assert.equal(s.reviewishCount, 1);
    assert.equal(s.newest, '2026-09-25');
  });
});

describe('poller config', () => {
  test('every configured rss entry has an absolute http(s) url and a valid urlFilter', () => {
    for (const [id, c] of Object.entries(OUTLET_STRATEGY_CONFIG)) {
      if (c.strategy !== 'rss') continue;
      assert.match(c.url, /^https?:\/\//, id);
      if (c.urlFilter) assert.ok(c.urlFilter instanceof RegExp, id);
    }
  });

  test('BRO-4185 outlets that missed reviews on 2026-09-26 are now feed-configured', () => {
    for (const id of ['off-off-online', 'this-week-in-new-york', 'firstnightmagazine', 'london-unattached']) {
      assert.equal(OUTLET_STRATEGY_CONFIG[id]?.strategy, 'rss', id);
    }
  });

  test('loureviews is owned by poll-loureviews.yml, not the poller', () => {
    assert.equal(OUTLET_STRATEGY_CONFIG.loureviews, undefined);
    assert.ok(SKIP_OUTLETS.has('loureviews'));
  });
});

describe('isSameUrlFlaggedTarget (classifies a writer refusal; never a skip)', () => {
  function withFile(data, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-'));
    fs.mkdirSync(path.join(dir, 'show-a'));
    fs.writeFileSync(path.join(dir, 'show-a', generateReviewFilename('blogcritics', 'unknown')), JSON.stringify(data));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  test('flagged file with the same url (modulo trailing slash/case) → same-url', () => {
    withFile({ url: 'https://blogcritics.org/Crazy-Mama/', wrongProduction: true }, dir => {
      assert.equal(isSameUrlFlaggedTarget('show-a', 'blogcritics', 'https://blogcritics.org/crazy-mama', dir), true);
    });
  });

  test('flagged file with a DIFFERENT url → false (reported as a blocked new URL)', () => {
    withFile({ url: 'https://blogcritics.org/old/', wrongProduction: true }, dir => {
      assert.equal(isSameUrlFlaggedTarget('show-a', 'blogcritics', 'https://blogcritics.org/new/', dir), false);
    });
  });

  test('unflagged file → false', () => {
    withFile({ url: 'https://blogcritics.org/x/' }, dir => {
      assert.equal(isSameUrlFlaggedTarget('show-a', 'blogcritics', 'https://blogcritics.org/x/', dir), false);
    });
  });

  test('missing file → false', () => {
    assert.equal(isSameUrlFlaggedTarget('nope', 'blogcritics', 'https://x', os.tmpdir()), false);
  });
});
