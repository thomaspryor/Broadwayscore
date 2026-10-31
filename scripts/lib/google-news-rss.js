'use strict';
const { publishedStampToLocalDate, tzForMarket } = require('./local-date');

const cheerio = require('cheerio');
const { fetchPage, domainMatchesExpected } = require('./scraper');
const { titleMatchesShow, isWithinOpeningWindow } = require('./rss-discovery');
const { normalizeUrl, resolveOutletFromUrl, resolveOutletFromUrlIfPathInformed } = require('./review-normalization');
const { isLondonMarket } = require('./venue-classification');
const { isInOpeningWindow } = require('./opening-window-backoff');
const { isBroadwayLocalRegion, isWestEndLocalRegion } = require('./outlet-region-map');
const { extractByline } = require('./byline-extraction');
const { resolveCritic } = require('./resolve-critic');
const { decodeGoogleNewsLink, fetchGoogleNewsFeed } = require('./google-news-decode');

// Press titles that differ from the listing title (shows.json akaTitles), e.g.
// "Billy Crystal 860" is reviewed as "860". Searching only the listing title in
// quotes missed most of that show's opening-night reviews (2026-10-21).
function searchTitles(show) {
  const out = [];
  for (const t of [show && show.title, ...((show && Array.isArray(show.akaTitles)) ? show.akaTitles : [])]) {
    const v = typeof t === 'string' ? t.trim() : '';
    if (v.length >= 3 && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

// A headline that matches only a short press title ("860") must also carry a
// word of the listing title that the press title lacks ("Billy", "Crystal"),
// or "New Balance 860 v15 Review" passes for Billy Crystal 860.
const words = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
function headlineNamesShow(headline, show) {
  if (titleMatchesShow(headline, show.title, { fuzzy: true })) return true;
  const listing = words(show.title);
  const head = new Set(words(headline));
  return searchTitles(show).slice(1).some((aka) => {
    if (!titleMatchesShow(headline, aka, { fuzzy: true })) return false;
    const extra = listing.filter((w) => !words(aka).includes(w));
    return extra.length === 0 || extra.some((w) => head.has(w));
  });
}

function googleNewsRssUrl(show) {
  const london = isLondonMarket(show.category);
  const titles = searchTitles(show);
  const params = new URLSearchParams({
    q: `${titles.map((t) => `"${t}"`).join(' OR ')} review`,
    hl: london ? 'en-GB' : 'en-US',
    gl: london ? 'GB' : 'US',
    ceid: london ? 'GB:en' : 'US:en',
  });
  return `https://news.google.com/rss/search?${params}`;
}

function parseGoogleNewsItems(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('item').map((_, node) => {
    const item = $(node);
    return {
      title: item.find('title').text().trim(),
      link: item.find('link').text().trim(),
      pubDate: new Date(item.find('pubDate').text().trim()),
      sourceName: item.find('source').text().trim(),
      sourceUrl: item.find('source').attr('url') || '',
    };
  }).get();
}

// Nationals often headline a review without the word (Telegraph: "Kristin
// Scott Thomas is hypnotic in a riveting Cherry Orchard"; Independent, FT),
// which is how the Telegraph review was missed (BRO-3998). Like
// openingWindowFeedAccepts in rss-discovery, a same-show headline needs no
// "review" on opening day or the 2 days after (UTC calendar days), when press
// embargoes lift. Outside that, and always for feature/roundup shapes, it must.
const REVIEW_FREE_POST_DAYS = 2;
const NON_REVIEW_HEADLINE = /\b(interviews?|previews?|tickets|roundups?|reviews|first[- ]look|photos?|images|pictures|trailer|cast announced|full cast|meet the cast|best shows|to book|what the critics|critics (?:praise|say|react)|box office|grosses|lottery)\b/i;

function isReviewHeadline(item, show) {
  if (!headlineNamesShow(item.title, show)) return false;
  if (NON_REVIEW_HEADLINE.test(item.title)) return false;
  if (/\breview\b/i.test(item.title)) return true;
  return isWithinOpeningWindow(item.pubDate, show.openingDate, 0, REVIEW_FREE_POST_DAYS);
}

function outletMatchesMarket(info, show) {
  return info && (info.isDualMarket || (isLondonMarket(show.category)
    ? isWestEndLocalRegion(info.region) : isBroadwayLocalRegion(info.region)));
}

// Google RSS links can redirect in JavaScript. Read the rendered destination's
// canonical URL, or the interstitial's publisher link. Never ingest the wrapper
// or use its opaque token to infer article metadata.
function publisherUrlFromPage(content, sourceUrl, finalUrl) {
  let expected;
  try { expected = new URL(sourceUrl).hostname; } catch { return null; }
  const $ = cheerio.load(content);
  const accept = value => {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol)
          || !domainMatchesExpected(expected, url.hostname)
          || url.hostname === 'news.google.com' || url.pathname === '/') return null;
      return url.href;
    } catch { return null; }
  };
  const redirected = accept(finalUrl);
  if (redirected) return redirected;
  for (const selector of ['link[rel="canonical"]', 'meta[property="og:url"]']) {
    const url = accept($(selector).attr(selector.startsWith('link') ? 'href' : 'content'));
    if (url) return url;
  }
  const links = new Set();
  $('a[href], [data-n-au]').each((_, node) => {
    const url = accept($(node).attr('data-n-au') || $(node).attr('href'));
    if (url) links.add(url);
  });
  return links.size === 1 ? [...links][0] : null;
}

/** Per-show opening-window discovery, shared by the poller and gather-reviews.
 * fetchPageImpl, feedImpl and decodeImpl are test seams; production always
 * uses the shared scraper and the plain-HTTP Google helpers.
 */
async function discoverGoogleNewsReviews(show, options = {}) {
  const { knownUrls = new Set(), now = new Date(), verbose = false, fetchPageImpl = fetchPage,
    feedImpl = fetchGoogleNewsFeed, decodeImpl = decodeGoogleNewsLink } = options;
  // Missing dates cannot safely bound either polling or publication eligibility.
  if (!show.openingDate || !isInOpeningWindow(show, now)) return [];
  const since = new Date(show.previewsStartDate || show.openingDate).getTime();
  if (!Number.isFinite(since)) return [];
  const seen = new Set([...knownUrls].map(normalizeUrl));
  const results = [];
  try {
    // Plain HTTP first (BRO-6589); the Playwright fetch is the fallback.
    const feedXml = await feedImpl(googleNewsRssUrl(show)).catch(() => null)
      || (await fetchPageImpl(googleNewsRssUrl(show), { skipVerify: true, preferPlaywright: true, fast: true }))?.content || '';
    if (verbose && !feedXml) console.log('  google-news-rss: feed fetch returned nothing');
    let items = parseGoogleNewsItems(feedXml).filter(item =>
      Number.isFinite(item.pubDate.getTime()) && item.pubDate.getTime() >= since
      && item.pubDate.getTime() <= new Date(now).getTime()
      // fuzzy title match: the outlet may misspell the title (CATERINA, BRO-4001);
      // the feed is already scoped to this one show, so a near match can't steal another's.
      && isReviewHeadline(item, show)
      && item.link && item.sourceName && resolveOutletFromUrl(item.sourceUrl));
    // Prioritize nationals and rotate bounded batches across poll cycles so
    // already-known links cannot permanently starve the remaining publishers.
    const registry = require('../../data/outlet-registry.json').outlets;
    items.sort((a, b) => (registry[resolveOutletFromUrl(a.sourceUrl).outletId]?.tier || 3)
      - (registry[resolveOutletFromUrl(b.sourceUrl).outletId]?.tier || 3));
    const wrappers = new Set();
    items = items.filter(item => {
      const sourceOutlet = resolveOutletFromUrl(item.sourceUrl);
      const info = registry[sourceOutlet.outletId];
      // A shared-domain source (Time Out) needs the resolved article edition
      // before its market can be determined. Recheck every resolved URL below.
      if (!info || (!resolveOutletFromUrlIfPathInformed(item.sourceUrl)
          && !outletMatchesMarket(info, show))) return false;
      if (wrappers.has(item.link)) return false;
      wrappers.add(item.link);
      return true;
    });
    const batches = Math.ceil(items.length / 12);
    const offset = batches ? (Math.floor(new Date(now).getTime() / (15 * 60000)) % batches) * 12 : 0;
    // Decode stops for the rest of the batch after 2 straight misses (blocked
    // or RPC shape changed), so a dead decoder adds at most 3 wasted tries
    // (one per worker below).
    let decodeTried = 0, decodeOk = 0, decodeMissStreak = 0;
    const batch = items.slice(offset, offset + 12);
    const found = new Array(batch.length);
    const resolveItem = async (item, i) => {
      try {
        const wrapper = new URL(item.link);
        if (wrapper.protocol !== 'https:' || wrapper.hostname !== 'news.google.com') return;
        const publisherHost = new URL(item.sourceUrl).hostname.replace(/^www\./, '');
        let page = null;
        let url = null;
        // BRO-6589: resolve the wrapper over HTTP first; the Playwright wait
        // below costs up to 20s per item and is now the fallback.
        if (decodeMissStreak < 2) {
          decodeTried++;
          const decoded = await decodeImpl(item.link).catch(() => null);
          url = decoded ? publisherUrlFromPage('', item.sourceUrl, decoded) : null;
          if (url) { decodeOk++; decodeMissStreak = 0; } else decodeMissStreak++;
        }
        if (!url) {
          page = await fetchPageImpl(item.link, {
            skipVerify: true, preferPlaywright: true,
            // Wait for the publisher or its interstitial link, not analytics
            // network-idle on the destination (which often never settles).
            playwrightWaitForSelector: `link[rel="canonical"][href*="${publisherHost}"], meta[property="og:url"][content*="${publisherHost}"], a[href*="${publisherHost}"]`,
          });
          url = publisherUrlFromPage(page?.content || '', item.sourceUrl, page?.finalUrl);
        }
        if (!url) {
          if (verbose) console.log(`  google-news-rss: unresolved publisher link (${item.sourceName})`);
          return;
        }
        const outlet = resolveOutletFromUrl(url);
        if (!outlet || !outletMatchesMarket(registry[outlet.outletId], show) || seen.has(normalizeUrl(url))) return;
        seen.add(normalizeUrl(url));
        // An interstitial has no publisher byline. Fetch the resolved article
        // through the same scraper rather than trust Google page metadata.
        const $ = cheerio.load(page?.content || '');
        const canonical = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content');
        if (normalizeUrl(page?.finalUrl || canonical || '') !== normalizeUrl(url)) {
          try { page = await fetchPageImpl(url, { preferPlaywright: true, fast: true }); }
          catch { page = null; } // Keep the resolved URL for the normal byline recovery path.
        }
        found[i] = {
          showId: show.id, url, outletId: outlet.outletId,
          outlet: outlet.displayName || item.sourceName,
          criticName: resolveCritic({ byline: extractByline(page?.content || ''), outletEntry: registry[outlet.outletId] }), title: item.title,
          publishDate: publishedStampToLocalDate(item.pubDate, url, { tz: tzForMarket(show.category || show.market) || undefined }),
          dateSource: 'google-news-rss', source: 'google-news-rss',
        };
        if (verbose) console.log(`  google-news-rss candidate: ${outlet.outletId} ${url}`);
      } catch (err) {
        if (verbose) console.log(`  google-news-rss: redirect failed (${item.sourceName}): ${err.message}`);
      }
    };
    // BRO-6589: each item ends in a ~15s Playwright article fetch for the
    // byline; three at a time keeps a 12-item batch near a minute instead of
    // three. The dedupe check-and-add above runs with no await in between, so
    // two wrappers for one article cannot both pass it.
    let next = 0;
    const worker = async () => { while (next < batch.length) { const i = next++; await resolveItem(batch[i], i); } };
    await Promise.all(Array.from({ length: Math.min(3, batch.length) }, worker));
    results.push(...found.filter(Boolean));
    if (verbose && decodeTried) console.log(`  google-news-rss: HTTP-decoded ${decodeOk}/${decodeTried} wrapper link(s)`);
  } catch (err) {
    if (verbose) console.log(`  google-news-rss error: ${err.message}`);
  }
  if (verbose) console.log(`  [google-news-rss Total] ${results.length} new review candidate(s)`);
  return results;
}

module.exports = { searchTitles, headlineNamesShow, discoverGoogleNewsReviews, googleNewsRssUrl, parseGoogleNewsItems, publisherUrlFromPage, isReviewHeadline };
