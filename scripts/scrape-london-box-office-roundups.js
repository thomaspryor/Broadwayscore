#!/usr/bin/env node
/**
 * London Box Office Review Roundups Scraper
 *
 * Discovers and extracts review data from londonboxoffice.co.uk roundup pages.
 * These roundups contain outlet name, star rating (★), critic name, excerpt,
 * and link to full review — all structured under <h4> headings.
 *
 * Strategy:
 * 1. Crawl /news-sitemap.xml for "review-round-up-" URLs
 * 2. Match roundup URLs to shows.json (West End category)
 * 3. Fetch HTML via ScrapingBee (static, no JS needed)
 * 4. Extract: outlet → ★ count → P0 score → critic → excerpt → review URL
 * 5. Dedup via findExistingReviewFile(), write review-text files
 *
 * Requires: SCRAPINGBEE_API_KEY
 *
 * Output: Updates/creates review files in data/review-texts/{showId}/
 * Archives: Saves HTML to data/aggregator-archive/lbo-roundups/
 *
 * Usage: node scripts/scrape-london-box-office-roundups.js [--shows=X,Y,Z] [--dry-run] [--force]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { serpQuery } = require('./lib/url-discovery');
const cheerio = require('cheerio');
const { matchTitleToShow, matchSlugToShow, loadShows, titleWordsMatch, buildSiblingCategoriesFromShows } = require('./lib/show-matching');
const { pickLboIndividualReviewUrls } = require('./lib/lbo-individual-serp');
const { checkArchiveCategory } = require('./lib/archive-cache-guard');
const { isLondonMarket } = require('./lib/venue-classification');
const { matchLboRoundup } = require('./lib/lbo-roundup-match');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { fetchPage, cleanup: cleanupScraper } = require('./lib/scraper');
const { classifyReason, describeSkip } = require('./lib/ingest-skip-classify');
// Shared JSON-LD reader — handles schema.org @graph, which a hand-rolled
// `Array.isArray(x) ? x : [x]` silently misses (scripts/lib/jsonld.js).
const { checkAggregatorPageProduction } = require('./lib/aggregator-page-production');
const { hasHelpFlag } = require('./lib/cli-help.js');

// --help must print usage and exit BEFORE any side effect (BRO-1711).
if (require.main === module && hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/scrape-london-box-office-roundups.js [options]\nSee the header comment of this script for options. --help/-h prints this and exits without side effects.');
  process.exit(0);
}

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/lbo-roundups');

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// Memoized showId -> same-title-sibling categories index (BRO-2565, mirroring
// scrape-bww-reviews.js's siblingCategoriesByShowId()) — feeds
// checkArchiveCategory()'s cross-market-sibling check below.
let _siblingCategoriesCache = null;
function siblingCategoriesByShowId() {
  if (_siblingCategoriesCache) return _siblingCategoriesCache;
  _siblingCategoriesCache = buildSiblingCategoriesFromShows(loadShows());
  return _siblingCategoriesCache;
}

// Stats
const stats = {
  sitemapUrls: 0,
  matchedShows: 0,
  pagesFetched: 0,
  reviewsExtracted: 0,
  newReviews: 0,
  updatedReviews: 0,
  skippedExisting: 0,
  skippedArchived: 0,
  skippedConflict: 0,
  errors: [],
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// Fetch raw XML without proxy (sitemap is public, no bot protection)
function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchRaw(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Sitemap discovery
// ---------------------------------------------------------------------------

async function discoverRoundupUrls() {
  console.log('Fetching LBO sitemap...');

  const xml = await fetchRaw('https://www.londonboxoffice.co.uk/news-sitemap.xml');
  const $ = cheerio.load(xml, { xmlMode: true });

  const roundups = [];
  const individual = [];
  // Article year per individual URL, from <lastmod> (BRO-5631): the sitemap
  // holds years of URLs, and same-title productions only separate by date.
  const individualYear = new Map();
  const roundupYear = new Map();
  $('url > loc').each((_, el) => {
    const loc = $(el).text().trim();
    // Match roundup URLs: "review-round-up-", "review-roundup-", etc.
    if (/review-round-?up[-:]|review-round-?up$/i.test(loc)) {
      roundups.push(loc);
      const y = Number(($(el).parent().find('lastmod').first().text() || '').slice(0, 4));
      if (y >= 1990 && y <= 2100) roundupYear.set(loc, y);
    }
    // Match individual review URLs: ends with "-review" or starts with "/review-"
    // Excludes roundups (already matched above) and non-review articles
    else if (/\/news\/post\/review-.+/i.test(loc) || /\/news\/post\/.+-review$/i.test(loc)) {
      individual.push(loc);
      const y = Number(($(el).parent().find('lastmod').first().text() || '').slice(0, 4));
      if (y >= 1990 && y <= 2100) individualYear.set(loc, y);
    }
  });

  console.log(`Found ${roundups.length} roundup URLs + ${individual.length} individual review URLs in sitemap`);
  stats.sitemapUrls = roundups.length;
  stats.individualUrls = individual.length;
  return { roundups, individual, individualYear, roundupYear };
}

// ---------------------------------------------------------------------------
// URL → show matching
// ---------------------------------------------------------------------------

function extractShowTitleFromUrl(url) {
  // URL pattern: /news/post/review-round-up-{show-name}-{theatre-name}
  // Also handles: /news/post/Review-Round-Up:-SHOW-NAME-at-the-Theatre
  const match = url.match(/review-round-?up[:-]+(.+)$/i);
  if (!match) return null;

  const slug = match[1];

  // Known theatre names to strip from the end
  const theatres = [
    'noel-coward-theatre', 'aldwych-theatre', 'apollo-theatre',
    'theatre-royal-haymarket', 'harold-pinter-theatre', 'duke-of-yorks-theatre',
    'duke-of-york-s-theatre', 'trafalgar-theatre', 'ambassadors-theatre',
    'bridge-theatre', 'savoy-theatre', 'wyndhams-theatre', 'wyndham-s-theatre',
    'donmar-warehouse', 'old-vic', 'the-old-vic', 'young-vic',
    'national-theatre', 'gielgud-theatre', 'lyceum-theatre',
    'london-palladium', 'phoenix-theatre', 'playhouse-theatre',
    'vaudeville-theatre', 'noël-coward-theatre', 'garrick-theatre',
    'criterion-theatre', 'duchess-theatre', 'fortune-theatre',
    'palace-theatre', 'piccadilly-theatre', 'prince-edward-theatre',
    'prince-of-wales-theatre', 'queens-theatre', 'savoy-theatre',
    'shaftesbury-theatre', 'st-james-theatre', 'st-martins-theatre',
    'gillian-lynne-theatre', 'barbican', 'soho-place',
    '@soho-place', 'at-the-ambassadors-theatre',
    'at-soho-place',
  ];

  let cleaned = slug;
  for (const theatre of theatres) {
    const suffix = new RegExp(`-${theatre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (suffix.test(cleaned)) {
      cleaned = cleaned.replace(suffix, '');
      break;
    }
  }

  // Convert hyphens to spaces, handle URL encoding
  return decodeURIComponent(cleaned).replace(/-/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Extract reviews from roundup HTML
// ---------------------------------------------------------------------------

const { extractReviewsFromLBO, extractIndividualReviewFromLBO } = require('./lib/lbo-extract');

// ---------------------------------------------------------------------------
// Extract from individual review page (single critic, no star rating)
// ---------------------------------------------------------------------------

// extractIndividualReviewFromLBO moved to ./lib/lbo-extract (BRO-5956).

/**
 * Extract show title from an individual review URL.
 * Patterns: /review-{show-name}-{theatre} or /{show-name}-{theatre}-review
 */
function extractShowTitleFromIndividualUrl(url) {
  // Pattern 1: /review-{show}-{theatre}
  const prefixMatch = url.match(/\/news\/post\/review-(.+)$/i);
  if (prefixMatch) {
    const slug = prefixMatch[1];
    return stripTheatreFromSlug(slug);
  }

  // Pattern 2: /{show}-{theatre}-review
  const suffixMatch = url.match(/\/news\/post\/(.+)-review$/i);
  if (suffixMatch) {
    const slug = suffixMatch[1];
    return stripTheatreFromSlug(slug);
  }

  return null;
}

function stripTheatreFromSlug(slug) {
  // Known theatre names to strip (reuse same list as roundup extraction)
  const theatres = [
    'noel-coward-theatre', 'aldwych-theatre', 'apollo-theatre',
    'theatre-royal-haymarket', 'harold-pinter-theatre', 'duke-of-yorks-theatre',
    'duke-of-york-s-theatre', 'trafalgar-theatre', 'ambassadors-theatre',
    'bridge-theatre', 'savoy-theatre', 'wyndhams-theatre', 'wyndham-s-theatre',
    'donmar-warehouse', 'old-vic', 'the-old-vic', 'young-vic',
    'national-theatre', 'gielgud-theatre', 'lyceum-theatre',
    'london-palladium', 'phoenix-theatre', 'playhouse-theatre',
    'vaudeville-theatre', 'noël-coward-theatre', 'garrick-theatre',
    'criterion-theatre', 'duchess-theatre', 'fortune-theatre',
    'palace-theatre', 'piccadilly-theatre', 'prince-edward-theatre',
    'prince-of-wales-theatre', 'queens-theatre', 'savoy-theatre',
    'shaftesbury-theatre', 'st-james-theatre', 'st-martins-theatre',
    'gillian-lynne-theatre', 'barbican', 'soho-place',
    '@soho-place', 'at-soho-place',
    'dorfman-theatre', 'lyttelton-theatre', 'olivier-theatre',
    'harold-pinter', 'sadlers-wells', 'sadlers-wells-east',
    'london-coliseum', 'bush-theatre', 'park-theatre',
    'omnibus-theatre', 'arcola-theatre', 'drury-lane',
    'jermyn-street-theatre', 'waterloo-east',
  ];

  let cleaned = slug;
  for (const theatre of theatres) {
    // Strip "-at-the-{theatre}" or just "-{theatre}" from end
    const atPattern = new RegExp(`-at-(?:the-)?${theatre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const directPattern = new RegExp(`-${theatre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (atPattern.test(cleaned)) {
      cleaned = cleaned.replace(atPattern, '');
      break;
    }
    if (directPattern.test(cleaned)) {
      cleaned = cleaned.replace(directPattern, '');
      break;
    }
  }

  return decodeURIComponent(cleaned).replace(/-/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Save review data
// ---------------------------------------------------------------------------

// BRO-3121: a title-matched LBO page can describe a PRIOR production of a
// revived show (Jane Eyre, Bristol Old Vic vs Southwark Playhouse). Its stars
// would then score as this production's review, so drop them unless the page's
// date or venue places it in this run. The excerpt is still kept.
function withholdStarsUnlessCurrentProduction(reviews, html, show, url) {
  const prod = checkAggregatorPageProduction({ html, show });
  if (prod.outOfRun) {
    console.warn(`  [SKIP-PAGE] ${url}: ${prod.reason} — another production, writing none of its ${reviews.length} row(s)`);
    stats.pagesOutOfRun = (stats.pagesOutOfRun || 0) + 1;
    reviews.length = 0;
    return prod;
  }
  if (!prod.corroborated) {
    const starred = reviews.filter((r) => r.stars !== null && r.stars !== undefined);
    if (starred.length) {
      console.warn(`  [NO-STARS] ${url}: ${prod.reason} — keeping ${starred.length} excerpt(s) without star scores`);
      stats.starsWithheld = (stats.starsWithheld || 0) + starred.length;
    }
    for (const r of reviews) { r.stars = null; r.score = null; }
  }
  return prod;
}

function saveLBOReview(showId, reviewInfo) {
  const sourceName = reviewInfo.isIndividual ? 'lbo-individual' : 'lbo-roundup';

  // Build score fields. aggregatorStars is stored in canonical "X/5" string
  // form so parseOriginalScore() and the rebuild's stars-aware paths can
  // resolve it; scoreSource is 'lbo-css-stars' to match the rest of the
  // codebase (the prior 'lbo-star-rating' label was orphaned and produced
  // numeric aggregatorStars values that downstream stars-handling missed).
  const scoreFields = {};
  if (reviewInfo.stars !== null && reviewInfo.stars !== undefined) {
    scoreFields.aggregatorStars = `${reviewInfo.stars}/5`;
    scoreFields.scoreSource = 'lbo-css-stars';
    scoreFields.originalScoreNormalized = Math.round((reviewInfo.stars / 5) * 100);
  }

  const result = createOrMergeReviewFile(showId, {
    outlet: reviewInfo.outlet,
    criticName: reviewInfo.critic,
    url: reviewInfo.url,
    source: sourceName,
    ...(reviewInfo.publishDate ? { publishDate: reviewInfo.publishDate } : {}),
    fields: {
      // New files are built from fields; top-level publishDate only feeds the
      // writer's reroute guards.
      ...(reviewInfo.publishDate ? { publishDate: reviewInfo.publishDate } : {}),
      lboRoundupExcerpt: reviewInfo.excerpt || undefined,
      ...scoreFields,
    },
  }, {
    dryRun: DRY_RUN,
    onMerge(existing) {
      // Upgrade critic name if incoming has one and existing is 'Unknown'
      if (reviewInfo.critic !== 'Unknown' && (!existing.criticName || existing.criticName === 'Unknown')) {
        existing.criticName = reviewInfo.critic;
      }
    },
  });

  if (result.action === 'new') stats.newReviews++;
  else if (result.action === 'updated') stats.updatedReviews++;
  else {
    // BRO-205: classify the skip reason instead of lumping every conflict
    // (cross-show-url-owned, no-outlet, suspicious-outlet-id, domain-mismatch,
    // aggregator-url-mismatch/-refinement-refused) into "already exists".
    const cls = classifyReason(result.reason);
    if (cls.kind === 'conflict' || cls.kind === 'unclassified') {
      stats.skippedConflict++;
      console.warn(`  ⚠️  ${describeSkip(showId, reviewInfo.url, cls)}`);
    } else {
      stats.skippedExisting++;
    }
  }

  return result.action === 'skipped' ? 'skipped' : result.action;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeLBORoundups() {
  console.log('=== London Box Office Review Roundups Scraper ===\n');

  // Parse CLI flags
  const args = process.argv.slice(2);
  const showsArg = args.find(a => a.startsWith('--shows='));
  const targetShowIds = showsArg ? showsArg.replace('--shows=', '').split(',').map(s => s.trim()).filter(Boolean) : null;

  if (targetShowIds) {
    console.log(`Targeted mode: ${targetShowIds.length} show(s): ${targetShowIds.join(', ')}`);
  }
  if (DRY_RUN) console.log('[DRY RUN] No files will be written\n');

  // Ensure archive directory exists
  if (!DRY_RUN && !fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const shows = loadShows();
  // Filter to West End shows only
  const weShows = shows.filter(s => isLondonMarket(s.category));
  console.log(`Loaded ${weShows.length} West End shows from shows.json\n`);

  // Step 1: Check curated roundup URL map first (most reliable)
  const matchedRoundups = [];
  const curatedMapPath = path.join(__dirname, '../data/lbo-roundup-urls.json');
  let curatedMap = {};
  try {
    const mapData = JSON.parse(fs.readFileSync(curatedMapPath, 'utf8'));
    curatedMap = mapData.shows || {};
    console.log(`Loaded ${Object.keys(curatedMap).length} curated LBO roundup URLs`);
  } catch (e) {
    console.log('No curated LBO roundup map found — will use sitemap discovery');
  }

  // Match curated URLs to target shows
  const curatedMatchedIds = new Set();
  for (const [showId, url] of Object.entries(curatedMap)) {
    if (targetShowIds && !targetShowIds.includes(showId)) continue;
    const show = weShows.find(s => s.id === showId);
    if (show) {
      matchedRoundups.push({ url, show, extractedTitle: show.title });
      curatedMatchedIds.add(showId);
      console.log(`  [CURATED] ${show.title} → ${url}`);
    }
  }

  // Step 2: Discover additional roundup + individual review URLs from sitemap
  let roundupUrls = [];
  let individualUrls = [];
  let individualYear = new Map();
  let roundupYear = new Map();
  try {
    const discovered = await discoverRoundupUrls();
    roundupUrls = discovered.roundups;
    individualUrls = discovered.individual;
    individualYear = discovered.individualYear;
    roundupYear = discovered.roundupYear;
  } catch (err) {
    console.error(`Failed to fetch sitemap: ${err.message}`);
    console.log('Falling back to targeted shows with Google SERP...');
  }

  // Match sitemap roundup URLs to shows (skip already-curated ones)
  for (const url of roundupUrls) {
    const extractedTitle = extractShowTitleFromUrl(url);
    if (!extractedTitle) continue;

    // Title match first, then slug + venue (BRO-6101: venues missing from the
    // hardcoded theatre list left Rent / Cats / Death Note at medium confidence).
    const hit = matchLboRoundup(url, extractedTitle, weShows, { year: roundupYear.get(url) });
    if (!hit) {
      const weak = matchTitleToShow(extractedTitle, weShows, { market: 'west-end' });
      if (weak && weak.show) console.log(`  [LOW CONFIDENCE] roundup "${extractedTitle}" → ${weak.show.title} (${weak.confidence}) — skipped`);
      continue;
    }
    const match = { show: hit.show, confidence: 'high' };
    if (curatedMatchedIds.has(match.show.id)) continue; // Already have curated URL
    if (targetShowIds && !targetShowIds.includes(match.show.id)) continue;
    matchedRoundups.push({ url, show: match.show, extractedTitle });
  }

  // Match individual review URLs to shows.
  //
  // Primary matcher is matchSlugToShow (token-based, venue-agnostic). The prior
  // path — extractShowTitleFromIndividualUrl + matchTitleToShow — depended on a
  // HARDCODED theatre-name list to strip the venue from the slug; any venue not
  // in that list (e.g. Royal Court) left the title polluted, dropped the match
  // to low confidence, and SILENTLY skipped the review. Archduke (Royal Court,
  // 2026-06-27) was lost this way. matchSlugToShow has no venue list, so a
  // missing theatre can no longer cause a silent miss.
  //
  // Anything that still fails to match high-confidence but looks like one of our
  // tracked shows (medium title match) is recorded to an audit file instead of
  // being dropped, so abbreviated-title URLs the slug matcher can't place
  // (e.g. "much-ado-shakespeares-globe-review") stay VISIBLE.
  const matchedIndividual = [];
  const unmatchedIndividual = [];

  for (const url of individualUrls) {
    const postSlug = url
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/news\/post\//, '')
      .replace(/\/$/, '');

    // 1. Venue-agnostic slug match (primary). matchSlugToShow ignores the
    //    market option — cross-market scoping comes from `weShows` already being
    //    pre-filtered to London productions (see weShows construction above).
    // The sitemap's <lastmod> year dates the article. Without it, same-title
    // productions (1536 West End vs the announced off-West-End 1536) fall to
    // the recency tiebreak (BRO-5631); no lastmod keeps the old behavior.
    const articleYear = individualYear.get(url);
    let match = matchSlugToShow(postSlug, weShows, articleYear ? { year: articleYear } : {});
    let via = 'slug';

    // 2. Legacy title-extraction fallback for odd URL shapes the slug matcher
    //    can't parse.
    if (!match || !match.show || match.confidence !== 'high') {
      const extractedTitle = extractShowTitleFromIndividualUrl(url);
      const tMatch = extractedTitle
        ? matchTitleToShow(extractedTitle, weShows, { market: 'west-end' })
        : null;
      if (tMatch && tMatch.show && tMatch.confidence === 'high') {
        match = tMatch;
        via = 'title';
      } else {
        // Not high-confidence. Record probable misses (looks like one of ours)
        // for visibility instead of silently skipping.
        const probable = (match && match.show) ? match : tMatch;
        if (probable && probable.show) {
          unmatchedIndividual.push({
            url,
            extractedTitle: extractedTitle || postSlug,
            probableShow: probable.show.id,
            confidence: probable.confidence || 'unknown',
          });
        }
        match = null;
      }
    }

    if (!match || !match.show) continue;
    if (targetShowIds && !targetShowIds.includes(match.show.id)) continue;
    matchedIndividual.push({ url, show: match.show, extractedTitle: postSlug, via });
  }

  // Persist probable-miss audit so silent drops become visible. Only writes when
  // a tracked-show candidate exists, so genuinely off-West-End fringe reviews
  // (which correctly match nothing) don't create noise.
  if (!DRY_RUN) {
    try {
      const auditPath = path.join('data', 'audit', 'lbo-unmatched-individual-reviews.json');
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      // Every entry already has a probableShow (only those are pushed). Do NOT
      // drop a miss just because another URL matched the same show this run — a
      // show can have several distinct critic reviews, and a second missing one
      // must still surface, or the visibility goal is defeated. Dedup by URL.
      const seenUrls = new Set();
      const probableMisses = unmatchedIndividual.filter((u) => {
        if (!u.probableShow || seenUrls.has(u.url)) return false;
        seenUrls.add(u.url);
        return true;
      });
      fs.writeFileSync(auditPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        note: 'LBO individual review URLs from the news sitemap that look like a tracked West End show but did not match high-confidence. Review and ingest manually (gather-reviews.yml -f shows=<id>) or extend matching.',
        count: probableMisses.length,
        reviews: probableMisses,
      }, null, 2) + '\n');
      if (probableMisses.length > 0) {
        console.log(`::warning::${probableMisses.length} LBO individual review(s) look like tracked shows but were not auto-matched — see data/audit/lbo-unmatched-individual-reviews.json`);
        stats.unmatchedIndividual = probableMisses.length;
      }
    } catch (err) {
      console.log(`  [audit] failed to write unmatched-individual audit: ${err.message}`);
    }
  }

  stats.matchedShows = matchedRoundups.length;
  stats.matchedIndividual = matchedIndividual.length;
  console.log(`\nMatched ${matchedRoundups.length} roundups + ${matchedIndividual.length} individual reviews to West End shows\n`);

  // If targeted mode and some shows weren't matched via sitemap, try SERP fallback
  if (targetShowIds && SCRAPINGBEE_KEY) {
    const matchedIds = new Set(matchedRoundups.map(r => r.show.id));
    const unmatchedTargets = targetShowIds.filter(id => !matchedIds.has(id));

    for (const showId of unmatchedTargets) {
      const show = weShows.find(s => s.id === showId);
      if (!show) {
        console.log(`[WARN] Show ${showId} not found in West End shows`);
        continue;
      }

      console.log(`[SERP] Searching for ${show.title} roundup...`);
      try {
        const query = `site:londonboxoffice.co.uk "review round up" "${show.title}"`;
        const results = await serpQuery(query, { nbResults: 5 });
        const searchResult = results
          ? (results.map(r => r.url).filter(u => u && u.includes('londonboxoffice.co.uk') && /review-round-?up/i.test(u))[0] || null)
          : null;

        if (searchResult) {
          console.log(`  Found via SERP: ${searchResult}`);
          matchedRoundups.push({ url: searchResult, show, extractedTitle: show.title });
          stats.matchedShows++;
        } else {
          console.log(`  No LBO roundup found for ${show.title}`);
        }
        await sleep(2000);
      } catch (err) {
        console.log(`  SERP error: ${err.message}`);
      }
    }
  }

  // SERP fallback for INDIVIDUAL byline reviews (targeted mode only; BRO-5631,
  // was PR #391). LBO first-party reviews (Stuart King and colleagues) are only
  // discoverable via news-sitemap.xml, which holds ~48h of URLs, so a byline
  // review not swept inside that window was lost for good (Avenue Q and 1536,
  // 2026-06-28). Accept a SERP hit only when its slug matches THIS show as the
  // winner against the full weShows pool, the same guard the sitemap path uses;
  // a single-show pool would accept a slug that is really about another show.
  if (targetShowIds && SCRAPINGBEE_KEY) {
    const matchedIndivIds = new Set(matchedIndividual.map(r => r.show.id));
    for (const showId of targetShowIds.filter(id => !matchedIndivIds.has(id))) {
      const show = weShows.find(s => s.id === showId);
      if (!show) continue;
      console.log(`[SERP] Searching for ${show.title} individual LBO review...`);
      try {
        const results = await serpQuery(`site:londonboxoffice.co.uk "${show.title}" review`, { nbResults: 8 });
        // Every qualifying URL goes on: the per-page date guard below drops an
        // earlier production's review and keeps this run's.
        const picked = pickLboIndividualReviewUrls((results || []).map(r => r && r.url), show, weShows, {
          year: show.openingDate ? Number(String(show.openingDate).slice(0, 4)) : null,
        });
        if (picked.length) {
          for (const url of picked) {
            console.log(`  Found individual via SERP: ${url}`);
            matchedIndividual.push({ url, show, extractedTitle: show.title, via: 'serp' });
          }
          stats.matchedIndividual = (stats.matchedIndividual || 0) + picked.length;
        } else {
          console.log(`  No LBO individual review found for ${show.title}`);
        }
        await sleep(2000);
      } catch (err) {
        console.log(`  SERP (individual) error: ${err.message}`);
      }
    }
  }

  // BRO-6648 S1-T4: drop the shows the opening-night lane holds before anything is written.
  const writable = new Set(require('./lib/opening-night-lane/lease-guard').writableShowIds(
    [...new Set([...matchedRoundups, ...matchedIndividual].map(r => r.show.id))], { label: 'lbo' }));
  for (const list of [matchedRoundups, matchedIndividual]) list.splice(0, list.length, ...list.filter(r => writable.has(r.show.id)));

  // Process each matched roundup
  for (const { url, show } of matchedRoundups) {
    const showId = show.id;
    const archivePath = path.join(archiveDir, `${showId}.html`);

    // Check cached archive (fresh < 14 days)
    const archiveFresh = !FORCE && fs.existsSync(archivePath) &&
      (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24) < 14;

    let html;
    let isFreshFetch = false;
    if (archiveFresh) {
      console.log(`[CACHE] ${showId}: Using archived HTML`);
      html = fs.readFileSync(archivePath, 'utf8');
      stats.skippedArchived++;
    } else {
      console.log(`[FETCH] ${showId}: ${url}`);
      try {
        const result = await fetchPage(url);
        html = result ? result.content : null;
        if (!html || html.length < 500) {
          console.log(`  Empty or too short page, skipping`);
          continue;
        }
        isFreshFetch = true;
        stats.pagesFetched++;
        await sleep(1500); // Rate limit
      } catch (err) {
        console.error(`  [ERROR] ${showId}: ${err.message}`);
        stats.errors.push(`${showId}: ${err.message}`);
        continue;
      }
    }

    // Validate: page title should mention the show we matched to, AND (BRO-2565)
    // carry the category-aware cross-market-sibling check + punctuation-mismatch
    // rescue BRO-2547/2549 established for BWW — the same predicate used at both
    // read time and write time here, since this loop's cache-hit branch above
    // falls into this same check before the html is trusted.
    // Run BEFORE writing the archive so we don't poison the cache that
    // gather-reviews.js and opening-night-poller.js read later.
    // (Stuart King mis-attribution incident, 2026-04-25.)
    const validation = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);
    if (!validation.ok) {
      console.log(`  [SKIP] ${validation.reason}: page title "${(validation.pageTitle || '').substring(0, 60)}" doesn't match show "${show.title}"`);
      stats.skippedMismatch = (stats.skippedMismatch || 0) + 1;
      // A cache-hit that now fails re-validation is purged so it doesn't sit
      // poisoned for up to 14 more days (BRO-2549's read-path pattern) — a
      // fresh fetch was never written to disk in the first place (guard runs
      // before the write below). Gated on !DRY_RUN like every other write in
      // this script — a diagnostic dry-run must not delete real archives.
      if (archiveFresh && !DRY_RUN) fs.unlinkSync(archivePath);
      continue;
    }

    // Now safe to persist the archive.
    if (isFreshFetch && !DRY_RUN) {
      fs.writeFileSync(archivePath, `<!-- Source: ${url} -->\n${html}`);
    }

    // Extract reviews
    const reviews = extractReviewsFromLBO(html, showId, url);
    withholdStarsUnlessCurrentProduction(reviews, html, show, url);
    stats.reviewsExtracted += reviews.length;
    console.log(`  Found ${reviews.length} reviews`);

    for (const review of reviews) {
      const result = saveLBOReview(showId, review);
      const starStr = review.stars !== null ? ` (${review.stars}★ → ${review.score})` : '';
      if (result === 'new') {
        console.log(`    [NEW] ${review.outlet}${starStr} — ${review.critic}`);
      } else if (result === 'updated') {
        console.log(`    [UPD] ${review.outlet}${starStr}`);
      }
    }
  }

  // Process individual reviews
  if (matchedIndividual.length > 0) {
    console.log(`\n--- Individual LBO Reviews (${matchedIndividual.length}) ---`);
    const individualArchiveDir = path.join(archiveDir, 'individual');
    if (!DRY_RUN && !fs.existsSync(individualArchiveDir)) {
      fs.mkdirSync(individualArchiveDir, { recursive: true });
    }

    for (const { url, show } of matchedIndividual) {
      const showId = show.id;
      const archiveName = url.split('/').pop() + '.html';
      const archivePath = path.join(individualArchiveDir, archiveName);

      // Check cached archive
      const archiveFresh = !FORCE && fs.existsSync(archivePath) &&
        (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24) < 14;

      let html;
      if (archiveFresh) {
        console.log(`[CACHE] ${showId}: Using archived individual review`);
        html = fs.readFileSync(archivePath, 'utf8');
      } else {
        console.log(`[FETCH] ${showId}: ${url}`);
        try {
          const result = await fetchPage(url);
          html = result ? result.content : null;
          if (!html || html.length < 500) {
            console.log(`  Empty or too short page, skipping`);
            continue;
          }
          if (!DRY_RUN) {
            fs.writeFileSync(archivePath, `<!-- Source: ${url} -->\n${html}`);
          }
          stats.pagesFetched++;
          await sleep(1500);
        } catch (err) {
          console.error(`  [ERROR] ${showId}: ${err.message}`);
          stats.errors.push(`${showId} (individual): ${err.message}`);
          continue;
        }
      }

      // Extract single review
      const review = extractIndividualReviewFromLBO(html, showId);
      review.url = url; // The LBO page IS the review
      const batch = [review];
      const prod = withholdStarsUnlessCurrentProduction(batch, html, show, url);
      if (batch.length === 0) continue; // another production's post
      // The post is the review, so its own date is the review's publishDate.
      if (prod.pageDate) review.publishDate = prod.pageDate;
      stats.reviewsExtracted++;

      const result = saveLBOReview(showId, review);
      if (result === 'new') {
        console.log(`    [NEW] London Box Office — ${review.critic}`);
        stats.individualNew = (stats.individualNew || 0) + 1;
      } else if (result === 'updated') {
        console.log(`    [UPD] London Box Office — ${review.critic}`);
      }
    }
  }

  // Print summary
  console.log('\n=== LBO Summary ===');
  console.log(`Sitemap: ${stats.sitemapUrls} roundups + ${stats.individualUrls || 0} individual reviews`);
  console.log(`Matched roundups: ${stats.matchedShows} | Matched individual: ${stats.matchedIndividual || 0}`);
  console.log(`Pages fetched: ${stats.pagesFetched}`);
  console.log(`Used cached archives: ${stats.skippedArchived}`);
  console.log(`Total reviews extracted: ${stats.reviewsExtracted}`);
  console.log(`New reviews: ${stats.newReviews} (${stats.individualNew || 0} individual)`);
  console.log(`Updated reviews: ${stats.updatedReviews}`);
  console.log(`Skipped (already have excerpt): ${stats.skippedExisting}`);
  if (stats.skippedConflict) console.log(`⚠️  Skipped (conflict — needs a human, see warnings above): ${stats.skippedConflict}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`  - ${e}`));
  }
  if (DRY_RUN) console.log('\n[DRY RUN] No files were written');

  // Zero-data guard: if sitemap returned 0 URLs, the site structure changed or we're blocked
  // (only fires on full runs, not when scoped to specific shows)
  if (stats.sitemapUrls === 0 && !targetShowIds) {
    console.error('❌ ZERO sitemap URLs from LBO — likely site change or block. Failing.');
    process.exit(1);
  }

  await cleanupScraper();
  return stats;
}

// Export extraction function for use by gather-reviews.js
module.exports = { extractReviewsFromLBO };

// Run if called directly
if (require.main === module) {
  scrapeLBORoundups().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
