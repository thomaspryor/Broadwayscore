/**
 * West End / Off-West-End "shows we don't have at all" discovery (task
 * #1466, the WE analogue of the OB aggregator-roundup backstop in
 * promote-ob-venue-candidates.js).
 *
 * The existing WET/TR/LBO discover libs (wet-roundup-discover.js,
 * tr-roundup-discover.js, lbo-roundup-discover.js) all take a KNOWN show
 * object and search for ITS roundup — they can only confirm outlet coverage
 * for a show already in shows.json (see gap-reference-sources.js). None of
 * them can answer "what NEW show does this roundup page name?" This module
 * is the reverse direction: crawl each source's own LISTING of recent
 * roundups (not a per-show search) and extract {title, venue} candidates.
 *
 * Verified live sources (2026-08-14):
 *   - WestEndTheatre.com: WP-API category=10 (Reviews) WITHOUT a `search=`
 *     param returns the 20 most recent roundup posts across ALL shows.
 *     Post titles follow "<Show Title> Review(s): <subhead>" consistently.
 *     Venue is NOT in the listing — a per-post fetch is needed, and each
 *     post's NewsArticle JSON-LD `description` reliably reads "...of <Show
 *     Title> at <Venue>, ...", which also carries datePublished. This
 *     category spans ALL UK theatre WET covers (confirmed live: RSC
 *     Stratford and National Theatre pages appear here too), so a venue
 *     check is NOT optional — see decideWestEndAggregatorPromotion.
 *   - theatre.reviews: per its own discover lib, has "no listing-page
 *     equivalent of BWW's /reviews.php" — excluded here, not just unused.
 *   - London Box Office: news-sitemap.xml lists every /news/post/ URL with
 *     <lastmod>, no per-article fetch needed. Review-roundup slugs embed
 *     BOTH title and venue ("review-roundup-<title>-<venue>",
 *     "<title>-<venue>-review", etc.) — matchWestEndVenueFromSlug() below
 *     extracts both by finding which canonical West End venue name is a
 *     substring of the slug (same "bounded construction, validated per
 *     candidate" pattern lbo-roundup-discover.js already uses).
 *
 * Deliberately WEST END ONLY, not Off-West-End: unlike Off-Broadway (which
 * has a curated OFF_BROADWAY_VENUES directory), there is no curated
 * Off-West-End venue directory — isOffWestEndVenue() just means "not a known
 * West End venue," which is true of RSC Stratford, regional UK receiving
 * houses, and literally everything else in the world. Gating on
 * WEST_END_VENUES (55 curated theatres) is the only directory precise
 * enough to auto-promote unattended; a genuine new Off-West-End venue still
 * needs a human (same reasoning OB's decideOffBroadwayAggregatorPromotion
 * used for --admin-force on uncatalogued venues).
 */

const { WEST_END_VENUES } = require('./venue-classification');

// Slugs kept AS-IS (not "the "-stripped): WEST_END_VENUES already carries
// both "old vic" and "the old vic" as separate entries specifically so a
// slug like "...-the-old-vic-review" can match the longer, more specific
// "the-old-vic" form first (sorted longest-first below) rather than leaving
// a stray "-the-" fragment in the extracted title remainder.
//
// Minimum length 5 (not 4): live-tested 2026-08-14 and found "arts" (4
// chars, a real WEST_END_VENUES entry) false-matching inside unrelated slugs
// — "review-heathers-the-musical-arts-at-marble-arch" (the actual venue is
// "@sohoplace", not "Arts") — because "arts" is also an ordinary English
// word, unlike every other venue name in the list. A genuine Arts Theatre
// roundup simply won't auto-match via this slug matcher; it still reaches
// promotion via the WET-listing path (which validates venue from prose, not
// a slug substring) or a human add.
const WE_SLUG_MIN_LENGTH = 5;
// Canonical venue names excluded from slug matching entirely even though
// they're long enough to pass WE_SLUG_MIN_LENGTH — adversarial ship-check
// review (2026-08-14) found both are common enough as OTHER real, non-West-
// End venues' names that a slug substring match would misattribute them:
// "playhouse" (Nottingham Playhouse, Liverpool Playhouse, Leeds Playhouse —
// all real regional receiving houses) and "cambridge" (Cambridge Arts
// Theatre, a real regional venue unrelated to the West End's Cambridge
// Theatre). Same treatment as "arts" above — excluded from the SLUG matcher
// only; a genuine West End Playhouse/Cambridge Theatre roundup still reaches
// promotion via the WET-listing path, which validates venue from prose via
// venueFromWetDescription, not a slug substring.
const WE_SLUG_GENERIC_EXCLUDE = new Set(['playhouse', 'cambridge']);
const VENUE_SLUG_ENTRIES = [...WEST_END_VENUES]
  .map(v => ({ venue: v, slug: v.replace(/[.']/g, '').replace(/\s+/g, '-') }))
  .filter(e => e.slug.length >= WE_SLUG_MIN_LENGTH && !WE_SLUG_GENERIC_EXCLUDE.has(e.slug))
  .sort((a, b) => b.slug.length - a.slug.length);

/** Generic tokens that trail/lead a venue mention in a slug but aren't part
 *  of any canonical venue string here (WEST_END_VENUES entries are bare
 *  names, e.g. "soho place", not "soho place theatre"). Stripped from the
 *  title remainder after venue extraction so they don't leak into the title. */
function stripGenericVenueWords(remainder) {
  return remainder
    .replace(/^(theatre|theater)-/, '')
    .replace(/-(theatre|theater)$/, '')
    .replace(/^-+|-+$/g, '');
}

// Known non-West-End venues whose NAME happens to end in a canonical West
// End venue's slug, so a naive substring/suffix match misattributes them —
// live-tested 2026-08-14, both caught this way: "review-space-dogs-the
// -other-palace" (actual venue "The Other Palace") and "a-christmas-carol-a
// -ghost-story-alexandra-palace-review" (actual venue "Alexandra Palace"),
// neither West End, both matching "palace" (Palace Theatre, a real
// WEST_END_VENUES entry) as a suffix. Checked BEFORE the generic matcher so
// a known collision never silently mis-promotes; not exhaustive — a fresh
// collision found later gets added here, same as GENERIC_VENUE_SLUGS in
// venue-classification.js handles the analogous cross-production risk.
// "national" is kept matchable (unlike "playhouse"/"cambridge" above) because
// National Theatre South Bank is a real, already-catalogued WEST_END_VENUES
// entry (e.g. "The Misanthrope" @ "National Theatre (Lyttelton)" is a live
// west-end show) — but other companies also use "National" in their name and
// are NOT South Bank / West End: National Theatre Wales, National Theatre of
// Scotland, Welsh National Opera. Adversarial ship-check review (2026-08-14).
const WE_SLUG_FALSE_POSITIVE_RE = /(^|-)(the-)?other-palace(-|$)|(^|-)alexandra-palace(-|$)|(^|-)(welsh-)?national-theatre-wales(-|$)|(^|-)national-theatre-scotland(-|$)|(^|-)welsh-national-opera(-|$)/;

/**
 * Extracts a WET-listing post's show title from its rendered title, e.g.
 * "Death Note Reviews: an ambitious..." -> "Death Note". Returns null if the
 * title doesn't match the roundup convention (skip rather than guess).
 */
function titleFromWetPostTitle(rendered) {
  if (!rendered) return null;
  const clean = rendered
    .replace(/&#8217;/g, "'").replace(/&#8211;/g, '–').replace(/&#8216;/g, "'")
    .replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
  const m = clean.match(/^(.*?)\s+[Rr]eviews?:\s*/);
  return m ? m[1].trim() : null;
}

/**
 * Extracts venue from a WET post's NewsArticle JSON-LD `description`, which
 * consistently reads "A review round up of <show> at <venue>, with ...".
 * Falls back to null (never guesses) if the pattern isn't present.
 */
function venueFromWetDescription(description) {
  if (!description) return null;
  const m = description.match(/\bat\s+(?:the\s+)?([A-Z][A-Za-z0-9'&.‘’ -]*?)(?:,|\s+with\b|\s*\.|\s+where\b|$)/);
  if (!m) return null;
  const venue = m[1].trim();
  return venue.length >= 3 && venue.length <= 60 ? venue : null;
}

/**
 * Fetch WET's recent-roundups listing (category=10, no search param).
 * @param {object} [opts] { fetchJSON, log, perPage }
 * @returns {Promise<Array<{title: string, sourceUrl: string, articlePublishedAt: string|null, wpPostId: number}>>}
 */
async function fetchWetRecentRoundups(opts = {}) {
  const fetchJSON = opts.fetchJSON || require('./scraper').fetchJSON;
  const log = opts.log || console.log;
  const perPage = opts.perPage || 20;
  const apiUrl = `https://www.westendtheatre.com/wp-json/wp/v2/posts?categories=10&per_page=${perPage}&_fields=id,date,link,title`;
  let posts = [];
  try {
    posts = await fetchJSON(apiUrl);
    if (!Array.isArray(posts)) posts = [];
  } catch (e) {
    log(`  WET listing fetch error: ${(e.message || '').slice(0, 80)}`);
    return [];
  }
  const out = [];
  for (const post of posts) {
    const title = titleFromWetPostTitle(post.title?.rendered);
    if (!title || !post.link) continue;
    out.push({
      title,
      sourceUrl: post.link,
      articlePublishedAt: post.date || null,
      wpPostId: post.id,
    });
  }
  return out;
}

/**
 * Fetch a single WET roundup post's venue + confirmed publish date via its
 * NewsArticle JSON-LD block. Bounded — call only for posts not already
 * matched to an existing show (mirrors extract-aggregator-candidates.js's
 * "cheap classify pre-filter, then only fetch when needed" pattern).
 * @returns {Promise<{venue: string|null, articlePublishedAt: string|null}>}
 */
/**
 * Fetch a page and pull {description, datePublished} out of its first
 * NewsArticle JSON-LD block. Shared by WET (venue lives in `description`)
 * and LBO (needs `datePublished` as the TRUE publish date — see
 * fetchLboArticleDate's docstring for why the sitemap's <lastmod> can't be
 * trusted for this).
 */
async function fetchNewsArticleJsonLd(url, opts = {}) {
  const fetchPage = opts.fetchPage || require('./scraper').fetchPage;
  const log = opts.log || console.log;
  try {
    const result = await fetchPage(url, { renderJs: false });
    const html = result && result.content ? result.content : '';
    if (!html) return { description: null, datePublished: null };
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    let description = null;
    let datePublished = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (description || datePublished) return; // first NewsArticle block wins
      let parsed;
      try { parsed = JSON.parse($(el).html()); } catch { return; }
      if (parsed && parsed['@type'] === 'NewsArticle') {
        description = parsed.description || null;
        datePublished = parsed.datePublished || null;
      }
    });
    return { description, datePublished };
  } catch (e) {
    log(`  NewsArticle JSON-LD fetch error (${url}): ${(e.message || '').slice(0, 80)}`);
    return { description: null, datePublished: null };
  }
}

async function fetchWetPostVenue(url, opts = {}) {
  const { description, datePublished } = await fetchNewsArticleJsonLd(url, opts);
  return { venue: venueFromWetDescription(description), articlePublishedAt: datePublished };
}

/**
 * Fetch an LBO review page's TRUE publish date via its NewsArticle JSON-LD
 * `datePublished`. Required — do NOT use news-sitemap.xml's <lastmod> as a
 * staleness signal: live-tested 2026-08-14, a 2025-07-11 "Girl from the
 * North Country" review page's sitemap <lastmod> read as recent (whatever
 * last touched the CMS record, not the article date), which would have
 * defeated the promotion staleness gate and could have resurrected a
 * long-closed run as "currently open."
 */
async function fetchLboArticleDate(url, opts = {}) {
  const { datePublished } = await fetchNewsArticleJsonLd(url, opts);
  return { articlePublishedAt: datePublished };
}

/**
 * Does `slug` (a news-sitemap.xml path segment) contain a canonical West End
 * venue name? Returns { venue, remainder } — remainder is the slug with the
 * matched venue substring (and adjoining hyphens) removed, for title
 * extraction — or null if no canonical venue matches.
 */
function matchWestEndVenueFromSlug(slug) {
  if (!slug) return null;
  if (WE_SLUG_FALSE_POSITIVE_RE.test(slug)) return null;
  for (const { venue, slug: venueSlug } of VENUE_SLUG_ENTRIES) {
    const idx = slug.indexOf(venueSlug);
    if (idx === -1) continue;
    // Require a hyphen or string boundary on both sides so "vic" doesn't
    // match inside an unrelated word.
    const before = idx === 0 || slug[idx - 1] === '-';
    const afterIdx = idx + venueSlug.length;
    const after = afterIdx === slug.length || slug[afterIdx] === '-';
    if (!before || !after) continue;
    const remainder = stripGenericVenueWords(
      (slug.slice(0, idx) + slug.slice(afterIdx)).replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
    );
    return { venue, remainder };
  }
  return null;
}

// Standard English title-case: lowercase these unless they're the first word.
const TITLE_CASE_LOWERCASE = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'to', 'in', 'at', 'for', 'on']);

/** "how-the-other-half-loves" -> "How the Other Half Loves". */
function slugToTitle(slug) {
  const words = slug.split('-').filter(Boolean);
  return words
    .map((w, i) => (i > 0 && TITLE_CASE_LOWERCASE.has(w)) ? w : w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const LBO_PREFIX_STRIP = /^(review-roundup-|review-round-up-|review-)/;
const LBO_SUFFIX_STRIP = /(-reviews|-review)$/;

/**
 * Fetch LBO's news-sitemap.xml and extract {title, venue} review-roundup
 * candidates via canonical-venue slug matching. No per-article fetch.
 * @param {object} [opts] { fetchPage, log }
 * @returns {Promise<Array<{title: string, venue: string, sourceUrl: string, articlePublishedAt: string|null}>>}
 */
async function fetchLboRecentRoundups(opts = {}) {
  const fetchPage = opts.fetchPage || require('./scraper').fetchPage;
  const log = opts.log || console.log;
  let xml = '';
  try {
    const result = await fetchPage('https://www.londonboxoffice.co.uk/news-sitemap.xml', { renderJs: false });
    xml = result && result.content ? result.content : '';
  } catch (e) {
    log(`  LBO sitemap fetch error: ${(e.message || '').slice(0, 80)}`);
    return [];
  }
  if (!xml) return [];

  const out = [];
  const urlBlockRe = /<url>([\s\S]*?)<\/url>/g;
  let block;
  while ((block = urlBlockRe.exec(xml)) !== null) {
    const locM = block[1].match(/<loc>([^<]+)<\/loc>/);
    const loc = locM ? locM[1].trim() : null;
    if (!loc || !loc.includes('/news/post/')) continue;
    const slugMatch = loc.match(/\/news\/post\/([^/?#]+)/);
    const rawSlug = slugMatch ? slugMatch[1] : null;
    if (!rawSlug || !/review/i.test(rawSlug)) continue;

    const stripped = rawSlug.replace(LBO_PREFIX_STRIP, '').replace(LBO_SUFFIX_STRIP, '');
    const venueMatch = matchWestEndVenueFromSlug(stripped);
    if (!venueMatch || !venueMatch.remainder) continue;

    const lastmodM = block[1].match(/<lastmod>([^<]+)<\/lastmod>/);
    out.push({
      title: slugToTitle(venueMatch.remainder),
      venue: venueMatch.venue,
      sourceUrl: loc,
      // NOT a publish date — sitemap <lastmod> tracks whenever the CMS last
      // touched the record, which can read as "fresh" for a page published
      // over a year ago (live-tested 2026-08-14). Kept only as an
      // unconfirmed hint for logging; callers MUST call fetchLboArticleDate
      // for the real date before making any promotion decision.
      sitemapLastmodUnconfirmed: lastmodM ? lastmodM[1] : null,
    });
  }
  return out;
}

module.exports = {
  titleFromWetPostTitle,
  venueFromWetDescription,
  fetchWetRecentRoundups,
  fetchWetPostVenue,
  matchWestEndVenueFromSlug,
  slugToTitle,
  fetchLboRecentRoundups,
  fetchLboArticleDate,
  fetchNewsArticleJsonLd,
};
