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
// or "New Balance 860 v15 Review" passes for Billy Crystal 860. A press title of
// 2+ significant words ("It's a Wonderful Life" for "...: A Live Radio Play") is
// identity on its own (BRO-7778: the extra-word rule dropped "Review: It's a
// Wonderful Life"). Stopwords never count as the extra word ("The sacrifices we
// make" passed for SACRIFICES: The Musical on "the").
const LISTING_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'musical', 'play', 'new']);
const words = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
function headlineNamesShow(headline, show) {
  const { registryShowTitles } = require('./show-names');
  // BRO-7785: the lane's one other-staging test, over every name (billed, main, press titles), so a headline the lane
  // refuses ("...: A Live Radio Play at Stages Houston") is refused here too.
  if (require('./rss-discovery').headlineNamesOtherStaging(headline, show.title, { akaTitles: searchTitles(show).slice(1) })) return false;
  // akaTitles: [] here: press titles go through headlineNamesPressTitle's own rule below.
  return titleMatchesShow(headline, show.title, { fuzzy: true, akaTitles: [], mainTitle: true, allShowTitles: registryShowTitles() })
    || headlineNamesPressTitle(headline, show);
}
// The press-title half of headlineNamesShow on its own, for callers whose listing-title test is stricter than this
// fuzzy one (playbill-verdict-discover.js, BRO-6872).
function headlineNamesPressTitle(headline, show) {
  const { sigWords, otherProductionCue } = require('./show-names');
  const listing = words(show.title).filter((w) => !LISTING_STOP.has(w));
  const head = new Set(words(headline));
  return searchTitles(show).slice(1).some((aka) => {
    if (!titleMatchesShow(headline, aka, { fuzzy: true, akaTitles: [] })) return false;
    if (otherProductionCue(headline, aka, show)) return false; // another staging or the film (BRO-7778)
    if (sigWords(aka).filter((w) => w.length >= 3 && /[a-z]/.test(w)).length >= 2) return true;
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

// Pun headlines name no show: The New York Sun headlined its Blue Man Group
// review "A Blue Streak of Staleness" (2026-11-17), so the title-quoted query
// never returned it and the headline test would have dropped it anyway. On
// opening day and the 2 days after, a recency feed on the base title (before
// any quoted or colon subtitle) surfaces such items; they are kept only for
// tier-1/2 outlets and only when the fetched article names the show by its
// full or aka title. An unreadable page (bot checkpoint, paywall stub) drops
// the item: ingest has no wrong-show check strong enough to rely on.
const HEADLINE_FREE_MAX_TIER = 2;
// At most this many headline-free items are resolved per show per cycle, so
// off-topic articles can never fill the 12-item batch ahead of real reviews.
const HEADLINE_FREE_MAX_PER_CYCLE = 3;
const QUOTE_CHARS = /[\u201C\u201D\u2018\u2019"]/g;
/** The title before any quoted, colon, dash or paren subtitle, or null when
 * that is too generic to search on ("August", "Art", "Life", "CATS"). */
function baseSearchTitle(show) {
  const title = String((show && show.title) || '').trim();
  const base = title.split(/\s*[\u201C\u201D"\u00AB:\u2013\u2014(]\s*/)[0].replace(QUOTE_CHARS, '').trim();
  return base.split(/\s+/).length >= 2 && base.length >= 6 ? base : null;
}

/** Recency feed URL, or null when the show has no distinctive base title. */
function googleNewsRecencyUrl(show) {
  const base = baseSearchTitle(show);
  if (!base) return null;
  const london = isLondonMarket(show.category);
  const params = new URLSearchParams({
    q: `"${base}" when:2d`,
    hl: london ? 'en-GB' : 'en-US',
    gl: london ? 'GB' : 'US',
    ceid: london ? 'GB:en' : 'US:en',
  });
  return `https://news.google.com/rss/search?${params}`;
}

const foldPhrase = (t) => String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[\u2018\u2019\u02BC']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** True when the article (body text, og:title, og:description; nav, aside,
 * header and footer stripped) names the show by its FULL listing title or an
 * aka title. A franchise base title ("Blue Man Group") is not enough: it also
 * matches articles about other productions. */
function articleNamesShow(content, show) {
  if (!content) return false;
  const $ = cheerio.load(content);
  const meta = ['meta[property="og:title"]', 'meta[property="og:description"]', 'meta[name="description"]']
    .map((sel) => $(sel).attr('content') || '').join(' ');
  // Link text is dropped too: TheaterMania's casting news names other shows
  // only in its "related articles" link cards (2026-11-18 dry run).
  $('script, style, noscript, nav, aside, header, footer, a').remove();
  const hay = ` ${foldPhrase(`${meta} ${$('title').text()} ${$.root().text()}`)} `;
  return searchTitles(show).map(foldPhrase).filter((p) => p.length >= 6 && p.includes(' '))
    .some((p) => hay.includes(` ${p} `));
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

// A recency-feed item whose headline does not name the show: a review shape,
// published opening day to +2 days. The article-body check happens after
// the publisher URL resolves.
// Feature, casting and photo shapes that a headline-free item must not have
// (2026-11-18 dry run: "An Exclusive Look at ... Opening-Night Ensemble",
// "Zach Grenier Will Star in ...", "... Hitting The Road With a Concert Tour").
const HEADLINE_FREE_FEATURE = /\b(look at|opening[- ]night|red carpet|will star|to star|stars? in|joins?|cast|casting|tour|concert|announce[sd]?|exclusive|video|watch|listen|podcast|q&a|in conversation)\b/i;
function isHeadlineFreeCandidate(item, show) {
  return !headlineNamesShow(item.title, show) && !NON_REVIEW_HEADLINE.test(item.title)
    && !HEADLINE_FREE_FEATURE.test(item.title)
    && isWithinOpeningWindow(item.pubDate, show.openingDate, 0, REVIEW_FREE_POST_DAYS);
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
    const inDate = item => Number.isFinite(item.pubDate.getTime()) && item.pubDate.getTime() >= since
      && item.pubDate.getTime() <= new Date(now).getTime()
      && item.link && item.sourceName && resolveOutletFromUrl(item.sourceUrl);
    let items = parseGoogleNewsItems(feedXml).filter(item => inDate(item)
      // fuzzy title match: the outlet may misspell the title (CATERINA, BRO-4001);
      // the feed is already scoped to this one show, so a near match can't steal another's.
      && isReviewHeadline(item, show));
    const registry = require('../../data/outlet-registry.json').outlets;
    // Headline-free reviews (see googleNewsRecencyUrl): only inside the review-free window.
    // Kill switch without a code revert: GNEWS_HEADLINE_FREE_DISABLED=true.
    const recencyUrl = googleNewsRecencyUrl(show);
    if (recencyUrl && process.env.GNEWS_HEADLINE_FREE_DISABLED !== 'true'
        && isWithinOpeningWindow(new Date(now), show.openingDate, 0, REVIEW_FREE_POST_DAYS)) {
      // Plain HTTP only: this second feed is a supplement, so no browser fallback cost.
      const recencyXml = await feedImpl(recencyUrl).catch(() => null) || '';
      const links = new Set(items.map(item => item.link));
      let added = 0;
      for (const item of parseGoogleNewsItems(recencyXml)) {
        if (added >= HEADLINE_FREE_MAX_PER_CYCLE) break;
        // Headlines that name the show belong to the main "review" query; only
        // headline-free items are taken from this feed.
        if (links.has(item.link) || !inDate(item) || !isHeadlineFreeCandidate(item, show)) continue;
        const tier = registry[resolveOutletFromUrl(item.sourceUrl).outletId]?.tier;
        if (!tier || tier > HEADLINE_FREE_MAX_TIER) continue;
        links.add(item.link);
        items.push({ ...item, headlineFree: true });
        added++;
      }
    }
    // Prioritize nationals and rotate bounded batches across poll cycles so
    // already-known links cannot permanently starve the remaining publishers.
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
        if (item.headlineFree && !articleNamesShow(page?.content, show)) {
          if (verbose) console.log(`  google-news-rss: headline-free item does not name the show (${item.sourceName})`);
          return;
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

module.exports = { baseSearchTitle, googleNewsRecencyUrl, articleNamesShow, isHeadlineFreeCandidate, searchTitles, headlineNamesShow, headlineNamesPressTitle, discoverGoogleNewsReviews, googleNewsRssUrl, parseGoogleNewsItems, publisherUrlFromPage, isReviewHeadline };
