/**
 * RSS Feed Discovery for Opening Night Poller
 *
 * Checks theater-specific and entertainment RSS feeds for new reviews.
 * Theater feeds (Variety Legit, NYT Theater, Guardian Stage) are
 * topic-specific and don't need keyword filtering. Entertainment feeds
 * (THR, Deadline) need title matching.
 *
 * Supports both RSS 2.0 (<item>) and Atom (<entry>) feed formats.
 */

const https = require('https');
const http = require('http');

// Theater-specific feeds (all items are relevant — no keyword filtering needed)
const THEATER_FEEDS = [
  { url: 'https://variety.com/v/legit/feed/', outletId: 'variety', name: 'Variety Legit' },
  // Playbill RSS is defunct (404 as of March 2026) — kept for future reference
  // { url: 'https://playbill.com/feed', outletId: 'playbill', name: 'Playbill' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Theater.xml', outletId: 'nytimes', name: 'NYT Theater' },
  { url: 'https://www.theguardian.com/stage/rss', outletId: 'guardian', name: 'Guardian Stage' },
];

// West End theater feeds (verified March 2026)
const WE_THEATER_FEEDS = [
  { url: 'https://www.whatsonstage.com/feed/', outletId: 'whatsonstage', name: 'WhatsOnStage' },
  { url: 'https://www.standard.co.uk/culture/theatre/rss', outletId: 'standard', name: 'Evening Standard Theatre', needsFilter: true },
  // The Stage has no RSS feed (404 as of March 2026)
  // Telegraph theatre RSS is defunct (404 as of March 2026)
];

// General entertainment feeds (need title keyword filtering)
const ENTERTAINMENT_FEEDS = [
  // Vulture RSS is defunct (404 as of March 2026) — kept for future reference
  // { url: 'https://www.vulture.com/feed/rss/index.xml', outletId: 'vulture', name: 'Vulture', needsFilter: true },
  { url: 'https://www.hollywoodreporter.com/feed/', outletId: 'hollywood-reporter', name: 'THR', needsFilter: true },
  { url: 'https://deadline.com/feed/', outletId: 'deadline', name: 'Deadline', needsFilter: true },
];

const ALL_FEEDS = [...THEATER_FEEDS, ...WE_THEATER_FEEDS, ...ENTERTAINMENT_FEEDS];

/**
 * Fetch a URL and return the body text
 */
function fetchUrl(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'BroadwayScorecard/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Parse RSS 2.0 XML and extract items with title, link, pubDate.
 * Uses regex — no XML library dependency needed for simple RSS structure.
 */
function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = (itemXml.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
    const link = (itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (itemXml.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    if (title && link) {
      items.push({
        title: title.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        link: link.trim(),
        pubDate: pubDate.trim() ? new Date(pubDate.trim()) : null,
      });
    }
  }
  return items;
}

/**
 * Parse Atom XML and extract entries with title, link, updated/published.
 * Handles <link href="..."/> (self-closing) and <link>text</link> formats.
 */
function parseAtomItems(xml) {
  const items = [];
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    const title = (entryXml.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
    // Atom links: <link href="URL"/> or <link rel="alternate" href="URL"/>
    const linkHref = (entryXml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/) || [])[1]
      || (entryXml.match(/<link[^>]*href=["']([^"']+)["']/) || [])[1] || '';
    const dateStr = (entryXml.match(/<updated[^>]*>([\s\S]*?)<\/updated>/) || [])[1]
      || (entryXml.match(/<published[^>]*>([\s\S]*?)<\/published>/) || [])[1] || '';
    if (title && linkHref) {
      items.push({
        title: title.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        link: linkHref.trim(),
        pubDate: dateStr.trim() ? new Date(dateStr.trim()) : null,
      });
    }
  }
  return items;
}

/**
 * Auto-detect feed format and parse accordingly.
 * Handles RSS 2.0 (<rss>/<item>) and Atom (<feed>/<entry>).
 */
function parseFeedItems(xml) {
  if (xml.includes('<feed') && xml.includes('<entry')) {
    return parseAtomItems(xml);
  }
  return parseRSSItems(xml);
}

/**
 * Check if a title likely contains a review for the given show.
 * Matches show title words (ignoring articles) against RSS item title.
 */
function titleMatchesShow(itemTitle, showTitle) {
  // Strip articles and punctuation, get significant words
  const normalize = t => t.toLowerCase().replace(/['']/g, "'").replace(/[^a-z0-9' ]/g, '').trim();
  const showWords = normalize(showTitle)
    .split(/\s+/)
    .filter(w => !['the', 'a', 'an', 'of', 'and', 'in', 'at', 'on', 'to', 'for'].includes(w))
    .filter(w => w.length > 1);

  if (showWords.length === 0) return false;

  const itemLower = normalize(itemTitle);
  // All significant show words must appear in the item title
  const matchCount = showWords.filter(w => itemLower.includes(w)).length;
  // Require at least 80% of words to match (handles subtitles, alternate names)
  return matchCount >= Math.ceil(showWords.length * 0.8);
}

/**
 * Check if an item was published within the lookback window
 */
function isRecent(pubDate, maxHoursAgo = 48) {
  if (!pubDate || isNaN(pubDate.getTime())) return true; // No date = include it
  const hoursAgo = (Date.now() - pubDate.getTime()) / (1000 * 60 * 60);
  return hoursAgo <= maxHoursAgo;
}

/**
 * Check all RSS feeds for reviews of a show.
 *
 * @param {string} showTitle - The show title to search for
 * @param {Object} options
 * @param {number} options.maxHoursAgo - How far back to look (default 48h)
 * @param {Set} options.knownUrls - URLs already discovered (skip these)
 * @param {boolean} options.verbose - Log progress
 * @returns {Promise<Array<{url: string, outletId: string, source: string}>>}
 */
async function checkRSSFeeds(showTitle, options = {}) {
  const { maxHoursAgo = 48, knownUrls = new Set(), verbose = false } = options;
  const results = [];

  for (const feed of ALL_FEEDS) {
    try {
      const xml = await fetchUrl(feed.url);
      const items = parseFeedItems(xml);

      for (const item of items) {
        // Skip old items
        if (!isRecent(item.pubDate, maxHoursAgo)) continue;

        // Skip already-known URLs
        if (knownUrls.has(item.link)) continue;

        // Entertainment feeds need title matching; theater feeds include all recent items
        if (feed.needsFilter && !titleMatchesShow(item.title, showTitle)) continue;

        // For theater feeds, still check title match (they cover many shows)
        if (!feed.needsFilter && !titleMatchesShow(item.title, showTitle)) continue;

        // Check for review-like keywords in title
        const titleLower = item.title.toLowerCase();
        const isReviewLike = titleLower.includes('review') ||
          titleLower.includes('critic') ||
          titleMatchesShow(item.title, showTitle);

        if (isReviewLike || !feed.needsFilter) {
          results.push({
            url: item.link,
            outletId: feed.outletId,
            outlet: feed.name,
            title: item.title,
            publishDate: item.pubDate ? item.pubDate.toISOString().slice(0, 10) : null,
            source: 'rss-discovery',
          });
          if (verbose) {
            console.log(`    RSS [${feed.name}]: ${item.title}`);
          }
        }
      }
    } catch (err) {
      if (verbose) {
        console.log(`    RSS [${feed.name}]: ${err.message}`);
      }
      // Feed errors are non-fatal — other layers will catch missed reviews
    }
  }

  return results;
}

module.exports = { checkRSSFeeds, ALL_FEEDS, titleMatchesShow, parseRSSItems, parseAtomItems, parseFeedItems };
