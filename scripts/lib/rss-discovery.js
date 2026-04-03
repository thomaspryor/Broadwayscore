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

// Theater-specific feeds (narrow enough that date-window filtering is safe)
// NOTE: Guardian Stage is NOT here — it covers all performing arts globally (WE, opera, dance, regional).
// Guardian is handled by the Guardian Open Platform API in site-search-discovery.js (tag=stage/stage).
// openingWindow: true — marks feeds narrow enough to use ±2-day date window when openingDate is known.
// Only Broadway-specific feeds qualify; WE feeds (even without needsFilter) must still title-match.
const THEATER_FEEDS = [
  { url: 'https://variety.com/v/legit/feed/', outletId: 'variety', name: 'Variety Legit', openingWindow: true, market: 'broadway' },
  // Playbill RSS is defunct (404 as of March 2026) — kept for future reference
  // { url: 'https://playbill.com/feed', outletId: 'playbill', name: 'Playbill' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Theater.xml', outletId: 'nytimes', name: 'NYT Theater', openingWindow: true, market: 'broadway' },
  // Guardian Stage removed: covers all performing arts globally, too broad for date-window filtering.
  // Use Guardian Open Platform API in site-search-discovery.js instead.
  { url: 'https://www.broadwaynews.com/tag/review/rss/', outletId: 'broadwaynews', name: 'Broadway News Reviews', needsFilter: true, market: 'broadway' },
  { url: 'https://nystagereview.com/feed/', outletId: 'nysr', name: 'NY Stage Review', needsFilter: true, market: 'broadway' },
  { url: 'https://www.newyorktheater.me/feed/', outletId: 'nyt-theater', name: 'NY Theater', needsFilter: true, market: 'broadway' },
];

// West End theater feeds (verified March 2026)
const WE_THEATER_FEEDS = [
  { url: 'https://www.whatsonstage.com/feed/', outletId: 'whatsonstage', name: 'WhatsOnStage', market: 'west-end' },
  { url: 'https://www.standard.co.uk/culture/theatre/rss', outletId: 'standard', name: 'Evening Standard Theatre', needsFilter: true, market: 'west-end' },
  { url: 'https://theatreweekly.com/feed/', outletId: 'theatre-weekly', name: 'Theatre Weekly', needsFilter: true, market: 'west-end' },
  // The Stage has no RSS feed (404 as of March 2026)
  // Telegraph theatre RSS is defunct (404 as of March 2026)
  // Time Out London theatre RSS is defunct (404 as of March 2026)
  // London Theatre (londontheatre.co.uk) returns HTML, not RSS (March 2026)
  // BWW West End RSS is defunct (404 as of March 2026)
];

// General entertainment feeds (need title keyword filtering)
const ENTERTAINMENT_FEEDS = [
  // Vulture RSS is defunct (404 as of March 2026) — kept for future reference
  // { url: 'https://www.vulture.com/feed/rss/index.xml', outletId: 'vulture', name: 'Vulture', needsFilter: true },
  { url: 'https://www.hollywoodreporter.com/feed/', outletId: 'hollywood-reporter', name: 'THR', needsFilter: true },
  { url: 'https://deadline.com/feed/', outletId: 'deadline', name: 'Deadline', needsFilter: true },
  { url: 'https://feeds.content.dowjones.io/public/rss/RSSLifestyle', outletId: 'wsj', name: 'WSJ Lifestyle', needsFilter: true },
  { url: 'https://www.latimes.com/entertainment-arts/rss2.0.xml', outletId: 'latimes', name: 'LA Times Entertainment', needsFilter: true },
  { url: 'https://feeds.washingtonpost.com/rss/entertainment', outletId: 'washpost', name: 'WashPost Entertainment', needsFilter: true },
  { url: 'https://www.newyorker.com/feed/culture', outletId: 'newyorker', name: 'New Yorker Culture', needsFilter: true },
  { url: 'https://www.nbcnewyork.com/entertainment/?rss=y', outletId: 'nbcny', name: 'NBC New York', needsFilter: true },
  { url: 'https://www.huffpost.com/section/entertainment/feed', outletId: 'huffpost', name: 'HuffPost Entertainment', needsFilter: true },
  { url: 'https://www.slantmagazine.com/feed/', outletId: 'slantmagazine', name: 'Slant Magazine', needsFilter: true },
  // Added April 2026 — verified working, expand non-SERP coverage for opening nights
  { url: 'https://nypost.com/entertainment/feed/', outletId: 'nypost', name: 'NY Post Entertainment', needsFilter: true },
  { url: 'https://www.indiewire.com/feed/', outletId: 'indiewire', name: 'IndieWire', needsFilter: true },
  { url: 'https://www.rollingstone.com/tv-movies/feed/', outletId: 'rollingstone', name: 'Rolling Stone', needsFilter: true },
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
  // Word-boundary match: prevents "tru" matching "trump" or "bug" matching "debug".
  // Boundaries: start/end of string, space, hyphen, slash, period, quote, underscore.
  const wordMatch = (haystack, word) => {
    const escaped = word.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|[\\s\\-/.\'"_])' + escaped + '(?:$|[\\s\\-/.\'"_])', 'i').test(haystack);
  };
  // All significant show words must appear in the item title
  const matchCount = showWords.filter(w => wordMatch(itemLower, w)).length;
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
 * Check if an item was published within ±windowDays of the show's opening date.
 * Uses absolute value to cover both preview-period reviews and post-opening reviews.
 * Returns true if no openingDate or invalid pubDate (fail-open).
 */
function isWithinOpeningWindow(pubDate, openingDate, windowDays = 2) {
  if (!openingDate || !pubDate || isNaN(pubDate.getTime())) return true;
  const opening = new Date(openingDate);
  if (isNaN(opening.getTime())) return true;
  const diffDays = Math.abs((pubDate.getTime() - opening.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays <= windowDays;
}

/**
 * Check all RSS feeds for reviews of a show.
 *
 * @param {string} showTitle - The show title to search for
 * @param {Object} options
 * @param {number} options.maxHoursAgo - How far back to look (default 48h)
 * @param {Set} options.knownUrls - URLs already discovered (skip these)
 * @param {boolean} options.verbose - Log progress
 * @param {string} options.openingDate - Show's opening date (YYYY-MM-DD). When provided,
 *   narrow THEATER_FEEDS use a ±2-day date window instead of title matching.
 *   Entertainment feeds always use title matching regardless of this option.
 * @returns {Promise<Array<{url: string, outletId: string, source: string}>>}
 */
async function checkRSSFeeds(showTitle, options = {}) {
  const { maxHoursAgo = 48, knownUrls = new Set(), verbose = false, openingDate = null, market = null, outletFilter = null } = options;
  const results = [];

  for (const feed of ALL_FEEDS) {
    // Skip feeds restricted to a different market
    if (market && feed.market && feed.market !== market) continue;
    // Skip feeds not in the outlet filter (when provided)
    if (outletFilter && !outletFilter.includes(feed.outletId)) continue;
    try {
      const xml = await fetchUrl(feed.url);
      const items = parseFeedItems(xml);

      let feedResults = 0;
      for (const item of items) {
        // Skip old items
        if (!isRecent(item.pubDate, maxHoursAgo)) continue;

        // Skip already-known URLs
        if (knownUrls.has(item.link)) continue;

        if (feed.needsFilter) {
          // Entertainment feeds (THR, Deadline): always title-match — they cover everything
          if (!titleMatchesShow(item.title, showTitle)) continue;
        } else if (feed.openingWindow && openingDate) {
          // Narrow Broadway-specific feeds (NYT Theater, Variety Legit): when openingDate is known,
          // use a ±2-day date window instead of title matching. These feeds are topic-scoped to
          // Broadway/theater, so date-windowing is safe and avoids title-match failures.
          // WE feeds (WhatsOnStage, Standard) do NOT have openingWindow:true — they fall through
          // to the else-branch and always title-match, even when openingDate is provided.
          if (!isWithinOpeningWindow(item.pubDate, openingDate, 2)) continue;
        } else {
          // All other feeds (WE feeds, Broadway feeds without openingDate): title-match
          if (!titleMatchesShow(item.title, showTitle)) continue;
        }

        // Reject non-review content: interviews, box office, cast news, photos
        const titleLower = item.title.toLowerCase();
        const nonReviewPatterns = ['interview', 'box office', 'grosses', 'begins previews',
          'first look', 'cast announced', 'full cast', 'meet the cast', 'photos:',
          'tickets on sale', 'lottery', 'rush policy'];
        if (nonReviewPatterns.some(t => titleLower.includes(t))) continue;

        // Check for review-like keywords in title (applied to all feeds)
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
          feedResults++;
          if (verbose) {
            console.log(`    RSS [${feed.name}]: ${item.title}`);
          }
        }
      }

      // Sanity check: if a single feed returns many items, it may indicate date window is too broad
      if (feedResults > 20 && verbose) {
        console.warn(`    RSS [${feed.name}]: WARNING — ${feedResults} items returned (possible over-broad match)`);
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

module.exports = { checkRSSFeeds, ALL_FEEDS, titleMatchesShow, isWithinOpeningWindow, parseRSSItems, parseAtomItems, parseFeedItems };
