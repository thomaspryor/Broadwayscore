#!/usr/bin/env node
/**
 * Scrape theatre.reviews roundup pages for West End shows
 *
 * theatre.reviews is a handcrafted WE review aggregator with per-outlet
 * star ratings (1-5), critic names, excerpts, and links to full reviews.
 * 10+ reviews per show, static HTML, no JS rendering needed.
 *
 * URL pattern: https://theatre.reviews/reviews-roundup/{title-slug}-{venue-slug}-reviews/
 * Discovery: category archive at /category/reviews-roundup/ (10 per page, paginated)
 *
 * HTML structure (WordPress, verified Mar 2026):
 *   - Star tier headers: <p><span style="color: #ff0000;">N stars ⭑⭑⭑</span></p>
 *     or plain <p>N stars ⭑⭑⭑</p>
 *   - Review paragraphs follow each tier header (no stars in them)
 *   - Outlet in <a href="reviewURL">Outlet Name</a> or plain text
 *   - Critic name embedded in prose: "Outlet's CriticName" or "CriticName for Outlet"
 *   - Excerpts in single curly quotes: 'text...'
 *   - Average rating at bottom: <strong>Critics' Average Rating X.X⭑</strong>
 *
 * Usage:
 *   node scripts/scrape-theatre-reviews.js [--shows=X,Y,Z] [--dry-run] [--force]
 *
 * Output: Archives to data/aggregator-archive/theatre-reviews/{show-id}.html
 *         Creates review files in data/review-texts/{show-id}/
 */

const { writableShowIds } = require('./lib/opening-night-lane/lease-guard');
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { matchTitleToShow, loadShows, buildSiblingCategoriesFromShows } = require('./lib/show-matching');
const { checkArchiveCategory, readCachedArchiveIfValid } = require('./lib/archive-cache-guard');
const { normalizeOutlet } = require('./lib/review-normalization');
const { isLondonMarket } = require('./lib/venue-classification');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { aggregatorStarsPatch } = require('./lib/paywall-stub-score');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { rowOutletId, loadShowFiles, classifyRows, coverageEntry, archiveUrlOf, sameRoundupUrl } = require('./lib/tr-reconcile');
const { parseRoundupPost, matchAllRoundups, rematchWithVenues } = require('./lib/tr-roundup-match');
const { discoverRoundupPostsRest, fetchRoundupBodyVenues } = require('./lib/theatre-reviews-discovery');
const { markOutOfScope, pinsFromOverrides } = require('./lib/tr-out-of-scope');

// Memoized sibling-category index (same shape as scrape-bww-reviews.js) so
// checkArchiveCategory()'s cross-market-sibling check can fire (BRO-2550).
let _siblingCategoriesCache = null;
function siblingCategoriesByShowId() {
  if (_siblingCategoriesCache) return _siblingCategoriesCache;
  _siblingCategoriesCache = buildSiblingCategoriesFromShows(loadShows());
  return _siblingCategoriesCache;
}

// --help must print usage and exit BEFORE any side effect (BRO-1711).
if (require.main === module && hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/scrape-theatre-reviews.js [options]\nSee the header comment of this script for options. --help/-h prints this and exits without side effects.');
  process.exit(0);
}

const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'theatre-reviews');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const showsArg = process.argv.find(a => a.startsWith('--shows='));
const TARGET_SHOWS = showsArg ? showsArg.split('=')[1].split(',') : null;

// Stats
const stats = { pagesChecked: 0, reviewsExtracted: 0, filesCreated: 0, filesUpdated: 0, filesSkipped: 0, errors: 0 };

/**
 * Fetch a URL via plain HTTPS (no API key needed — static HTML site)
 */
function fetchPlain(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchPlain(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/**
 * Plain request first (static site, free); when a CI runner is blocked
 * (theatre.reviews' CleanTalk answered 'Failed to fetch' for the Cleansed
 * round-up from GitHub Actions, BRO-4431), fall back to the shared scraper.
 */
async function fetchPage(url) {
  let html = null;
  try { html = await fetchPlain(url); } catch { html = null; }
  if (html) return html;
  try {
    const { fetchPage: scraperFetch } = require('./lib/scraper');
    const r = await scraperFetch(url, { timeout: 30000 });
    return r && typeof r === 'object' ? r.content : r;
  } catch {
    return null;
  }
}

/**
 * --shows mode: find each target show's round-up through the WordPress
 * search API (covers the whole archive; the category-archive walk below
 * stopped at page 2 from CI and never reached Golden Boy, BRO-4431).
 */
async function discoverRoundupsBySearch(targetShows) {
  const { fetchJSON } = require('./lib/scraper');
  const { pickTheatreReviewsRoundup } = require('./lib/theatre-reviews-discovery');
  const found = [];
  for (const show of targetShows) {
    const od = Date.parse(show.openingDate || show.previewsStartDate || '');
    if (!od) continue;
    const after = new Date(od - 7 * 86400000).toISOString();
    try {
      const posts = await fetchJSON(`https://theatre.reviews/wp-json/wp/v2/posts?per_page=5&after=${encodeURIComponent(after)}&search=${encodeURIComponent(show.title)}`);
      const url = pickTheatreReviewsRoundup(Array.isArray(posts) ? posts : [], show.title);
      if (url) {
        found.push({ url, show, extractedTitle: show.title });
        console.log(`  Matched (search): "${show.title}" → ${show.id}`);
      }
    } catch (e) {
      console.log(`  search failed for ${show.id}: ${e.message}`);
    }
  }
  return found;
}

/**
 * Discover roundup URLs by paginating the category archive.
 * /category/reviews-roundup/ shows 10 per page; we follow /page/N/ links.
 */
async function discoverRoundupUrls() {
  const seen = new Set();
  const urls = [];
  const MAX_PAGES = 30; // safety cap — site has ~23 pages

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = page === 1
      ? 'https://theatre.reviews/category/reviews-roundup/'
      : `https://theatre.reviews/category/reviews-roundup/page/${page}/`;

    const html = await fetchPage(pageUrl);
    if (!html) break; // 404 = no more pages

    const $ = cheerio.load(html);
    let found = 0;
    $('a[href*="/reviews-roundup/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || !href.includes('/reviews-roundup/')) return;
      // Skip the category page itself and pagination links
      if (href.match(/\/category\//) || href.match(/\/page\//)) return;
      const full = href.startsWith('http') ? href : `https://theatre.reviews${href}`;
      if (!seen.has(full)) {
        seen.add(full);
        urls.push(full);
        found++;
      }
    });

    console.log(`  Page ${page}: ${found} new URLs (${urls.length} total)`);
    if (found === 0) break; // no new URLs = last page

    await new Promise(r => setTimeout(r, 1000)); // rate limit between pages
  }

  console.log(`Discovered ${urls.length} roundup URLs from category archive\n`);
  return urls;
}

/**
 * Extract show title from a roundup URL slug
 * e.g., "into-the-woods-bridge-reviews" → "Into the Woods"
 */
function extractTitleFromSlug(url) {
  const match = url.match(/reviews-roundup\/(.+?)\/?\s*$/);
  if (!match) return null;
  let slug = match[1]
    .replace(/-reviews$/, '')
    .replace(/-with-.*$/, '')     // strip "with-cynthia-erivo" etc
    .replace(/-at-.*$/, '');      // strip "at-the-bridge" etc

  // Try removing venue suffixes (common patterns)
  const venueSuffixes = [
    'bridge', 'donmar', 'hampstead', 'menier', 'old-vic', 'young-vic',
    'adelphi', 'gielgud', 'savoy', 'apollo', 'noel-coward', 'wyndham',
    'marylebone', 'almeida', 'barbican', 'soho-place', 'bonneville',
  ];
  for (const suffix of venueSuffixes) {
    slug = slug.replace(new RegExp(`-${suffix}$`), '');
  }

  // Convert slug to title case
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Extract reviews from a theatre.reviews roundup page.
 *
 * HTML structure: star-tier headers (<p> with "N stars ⭑⭑⭑") act as section
 * dividers. Review paragraphs follow each header and inherit that tier's rating.
 * Reviews themselves contain NO star characters — only the headers do.
 *
 * Returns array of { outlet, critic, stars, starsOutOf, excerpt, url, source }
 */
function extractReviews(html, showId) {
  const $ = cheerio.load(html);
  const reviews = [];

  const content = $('.entry-content, .post-content, article, .content').first();
  const paragraphs = content.length ? content.find('p') : $('p');

  let currentStars = 0;
  // BRO-4431: a "0 stars –" tier lists critics who published NO rating (the
  // Mail's Patrick Marmion "vetoed" stars on Cleansed). Before, the header
  // didn't match, so those rows inherited the previous tier's stars.
  let seenTier = false;

  paragraphs.each((_, el) => {
    const $p = $(el);
    let text = $p.text().trim();
    if (!text) return;

    // --- Detect star-tier header ---
    // Patterns: "4 stars ⭑⭑⭑⭑" or "Three stars ⭑⭑⭑" (digit or word, with or without <span>)
    const WORD_TO_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5 };
    const tierMatch = text.match(/^(\d|zero|one|two|three|four|five)\s*stars?\s*(?:[⭑★]+|[–—-]|)$/i);
    if (tierMatch) {
      const raw = tierMatch[1].toLowerCase();
      currentStars = raw in WORD_TO_NUM ? WORD_TO_NUM[raw] : parseInt(raw, 10);
      seenTier = true;
      return;
    }

    // "(1 star assumed) The i's Fiona Mountford ..." — TR GUESSED the rating;
    // keep the row (it is a real review) but not the guessed stars.
    let assumed = false;
    const assumedMatch = text.match(/^\(\s*\d\s*stars?\s+assumed\s*\)\s*/i);
    if (assumedMatch) {
      assumed = true;
      text = text.slice(assumedMatch[0].length);
    }

    // --- Detect "Critics' Average Rating" footer — stop processing ---
    if (text.match(/critics[''\u2019]?\s*(average|avg)\s*rating/i)) return;

    // --- Detect inline star format: "Outlet's Critic (N★)" or "(N★)" ---
    const inlineStarMatch = text.match(/\((\d)[★⭑\*]\)/);
    if (inlineStarMatch) {
      const inlineReview = parseReviewParagraph($, $p, text, parseInt(inlineStarMatch[1], 10));
      if (inlineReview) {
        reviews.push(inlineReview);
        return;
      }
    }

    // Skip if we haven't seen a star header yet
    if (!seenTier) return;

    // Skip editorial boilerplate
    if (text.match(/^\[Links to full reviews/i)) return;
    if (text.match(/^If you[''\u2019]ve seen/i)) return;
    if (text.match(/can be seen at/i) && text.length < 200) return;

    // --- Try to extract a review from this paragraph ---
    const review = parseReviewParagraph($, $p, text, assumed || currentStars === 0 ? null : currentStars);
    if (review) {
      reviews.push(review);
    }
  });

  return reviews;
}

/**
 * Parse a single review paragraph into structured data.
 * Returns null if the paragraph doesn't look like a review.
 */
// Capitalised words that open a sentence before the outlet, not part of its name.
const PROSE_LEAD_IN_WORDS = new Set(['and', 'but', 'also', 'over', 'meanwhile', 'elsewhere', 'lastly', 'finally',
  'writing', 'while', 'whilst', 'however', 'here', 'there', 'then', 'next', 'plus', 'so', 'yet', 'for']);

function parseReviewParagraph($, $p, text, stars) {
  // Extract the first external link (usually the outlet link + review URL)
  const links = [];
  $p.find('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (href && href.startsWith('http') && !href.includes('theatre.reviews')) {
      links.push({ href, text: $(a).text().trim() });
    }
  });

  let outlet = '';
  let critic = '';
  let reviewUrl = '';

  if (links.length > 0) {
    // First external link is typically the outlet
    const outletLink = links[0];
    reviewUrl = outletLink.href;

    // Handle possessive in link text: "The Independent's" → "The Independent"
    outlet = outletLink.text.replace(/['\u2018\u2019]s?\s*$/, '').trim();
  }

  // --- Extract critic name from prose patterns ---
  // Pattern A: "Outlet's CriticName verb:" — e.g., "The Guardian's Arifa Akbar was blown away:"
  // Pattern B: "CriticName for/at Outlet verb:" — e.g., "Dave Fargnoli for The Stage commented:"
  // Pattern C: "Outlet's CriticName verb:" where outlet is plain text (no link)

  // Try Pattern A: <Outlet>'s <Critic>
  // Note: theatre.reviews uses U+2018 (left single quote) for possessives
  // BRO-4431: also "The Times’ Clive Davis" / "The Financial Times’ Sarah
  // Hemming" (plural possessive, no trailing s) and "The i’s Fiona Mountford"
  // (lower-case outlet). Those rows were dropped, and they are exactly the
  // paywalled T1/T2 reviews TR lists without a link.
  const POSSESSIVE = "(?:['\\u2018\\u2019]s|(?<=s)['\\u2018\\u2019])\\s+";
  const CRITIC = "([A-Z][a-z]+(?:\\s[A-Z][a-z]+(?:-[A-Z][a-z]+)?)+)";
  const patternA = text.match(new RegExp("^(?:<[^>]+>)?((?:The\\s+i)|[A-Z][\\w\\s&.'-]+?)" + POSSESSIVE + CRITIC));
  if (patternA) {
    const proseOutlet = patternA[1].trim();
    // BRO-2726: theatre.reviews sometimes links only PART of the outlet name
    // ("T<a>he Standard</a>‘s", "<a>Time Ou</a>t’s"), so the link text alone
    // produced outletIds "he-standard" / "time-ou". When the link text is a
    // strict prefix or suffix of the prose outlet (3+ chars, so a stray
    // one-letter link can't hijack it), the prose is the whole name. A link can
    // also cover whole words of the name ("Financial <a>Times</a>’",
    // "<a>Time</a> Out’s"), so the rest of the name is accepted when it is
    // capitalised name words; lead-in prose ("Over at <a>The Stage</a>’s",
    // "And <a>The Guardian</a>’s") has a lower-case or filler word and keeps the
    // link text (BRO-5261 retro-review).
    const extra = proseOutlet.startsWith(outlet) ? proseOutlet.slice(outlet.length)
      : proseOutlet.endsWith(outlet) ? proseOutlet.slice(0, proseOutlet.length - outlet.length) : null;
    const extraWords = extra == null ? [] : extra.trim().split(/\s+/).filter(Boolean);
    const cutsWord = extra != null && /^[A-Za-z]+$/.test(extra)
      && (proseOutlet.startsWith(outlet) ? /[A-Za-z]$/.test(outlet) : /^[A-Za-z]/.test(outlet));
    const nameWords = extraWords.length > 0
      && extraWords.every((w) => /^[A-Z][\w&.'-]*$/.test(w) && !PROSE_LEAD_IN_WORDS.has(w.toLowerCase()));
    const isFragment = outlet.length >= 3 && proseOutlet.length > outlet.length && (cutsWord || nameWords);
    if (!outlet || isFragment) outlet = proseOutlet;
    critic = patternA[2].trim();
  }

  // Try Pattern B: <Critic> for/at <Outlet>
  if (!critic) {
    const patternB = text.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+(?:-[A-Z][a-z]+)?)+)\s+(?:for|at|of)\s+(?:the\s+)?([A-Z][\w\s&.'-]+?)(?:\s+(?:called|commented|described|concluded|noted|reported|thought|found|said|summed|began|looked|was|wrote|observed))/i);
    if (patternB) {
      critic = patternB[1].trim();
      if (!outlet) outlet = patternB[2].trim();
    }
  }

  // Try Pattern C: "The Outlet's CriticName" where outlet has no link
  if (!critic && !outlet) {
    const patternC = text.match(new RegExp("^(?:The\\s+)?([A-Z][\\w\\s&.'-]+?)" + POSSESSIVE + CRITIC));
    if (patternC) {
      outlet = patternC[1].trim();
      critic = patternC[2].trim();
    }
  }

  // If we still don't have an outlet, this probably isn't a review paragraph
  if (!outlet) return null;

  // Ensure outlet doesn't end with possessive artifacts
  outlet = outlet.replace(/['\u2018\u2019]s?\s*$/, '').trim();

  // --- Extract excerpts (text in single curly quotes) ---
  // Matches: \u2018...\u2019 (curly) and '...' (straight)
  // BRO-2726: an opening quote must not follow a letter (theatre.reviews
  // writes possessives as "Standard\u2018s", which opened a bogus excerpt
  // "s Nick Curtis called the play ..."), and a closing quote must not be
  // followed by one ("Posner\u2019s" inside a quote ended the excerpt early).
  const excerpts = [];
  const quoteRegex = /(?<![\p{L}\p{N}])[\u2018']((?:(?![\u2019'](?![\p{L}\p{N}]))[\s\S])+)[\u2019'](?![\p{L}\p{N}])/gu;
  let m;
  while ((m = quoteRegex.exec(text)) !== null) {
    const q = m[1].trim();
    if (q.length > 20) excerpts.push(q); // skip tiny fragments
  }
  const excerpt = excerpts.join(' … ');

  return {
    outlet,
    outletId: normalizeOutlet(outlet),
    critic: critic || 'Unknown',
    stars: stars || null,
    starsOutOf: 5,
    excerpt,
    url: reviewUrl,
    source: 'theatre-reviews',
  };
}

/**
 * Create or update review files from extracted reviews
 */
function writeReviewFiles(reviews, showId, reviewTextsDir = REVIEW_TEXTS_DIR, leaseOpts = {}) {
  // BRO-6648 S1-T4: a show the opening-night lane holds is the lane's to write.
  if (!writableShowIds([showId], { label: 'theatre-reviews', ...leaseOpts }).length) return { created: 0, updated: 0, skipped: reviews.length, leased: true, outcomes: reviews.map(r => ({ action: 'skipped', outlet: r.outlet, critic: r.critic || null, reason: 'opening-night lane holds this show' })) };
  let created = 0, updated = 0, skipped = 0;
  const outcomes = [];

  for (const review of reviews) {
    const outletId = rowOutletId(review);

    const fields = {};
    if (review.excerpt) fields.theatreReviewsExcerpt = review.excerpt;
    // Store theatre.reviews' star rating as metadata only — NOT as the outlet's
    // originalScore. TR rates shows independently; attributing TR's rating to
    // the listed outlet causes wrong scores (e.g. TR gives 3/5, outlet gave 5/5).
    if (review.stars) fields.theatreReviewsStars = `${review.stars}/${review.starsOutOf}`;
    // BRO-4431 exception: a paywalled tier-1/2 star outlet (Times, FT, i,
    // Mail...) with no readable body would otherwise stay an unscored stub
    // forever. There, and only there, TR's tier IS the score we can see
    // (304/332 agreement with outlets' own ratings) — relay it as
    // aggregatorStars, which the scorer trusts for known star outlets.
    // Applied to the file as written (new) or merged into (existing), never
    // via `fields`, whose blank-fill merge would also reach files that have a
    // scorable body.
    const relay = { stars: review.stars, starsOutOf: review.starsOutOf, source: 'theatre-reviews' };

    const result = createOrMergeReviewFile(showId, {
      outlet: review.outlet,
      outletId,
      criticName: review.critic,
      url: review.url,
      source: review.source || 'theatre-reviews',
      fields,
    }, {
      dryRun: DRY_RUN,
      reviewTextsDir,
      onMerge(existing) {
        // Upgrade critic name if incoming has one and existing is 'Unknown' —
        // same pattern as scrape-london-box-office-roundups.js's saveLBOReview.
        if (review.critic && review.critic !== 'Unknown' && (!existing.criticName || existing.criticName === 'Unknown')) {
          existing.criticName = review.critic;
        }
        const mergePatch = aggregatorStarsPatch(existing, relay);
        if (mergePatch) Object.assign(existing, mergePatch);
      },
    });

    if (result.action === 'new' && result.filepath && !DRY_RUN) {
      try {
        const written = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));
        const patch = aggregatorStarsPatch(written, relay);
        if (patch) require('./lib/review-write-guard').safeWriteReview(result.filepath, { ...written, ...patch });
      } catch (e) {
        console.warn(`  ⚠ aggregatorStars relay failed for ${result.filepath}: ${e.message}`);
      }
    }

    outcomes.push({ outlet: review.outlet, critic: review.critic || null, action: result.action, reason: result.reason || null });
    if (result.action === 'new') created++;
    else if (result.action === 'updated') updated++;
    else if (result.action === 'skipped') skipped++;
  }

  return { created, updated, skipped, outcomes };
}

const INDEX_PATH = path.join(ARCHIVE_DIR, '_roundup-index.json');
const COVERAGE_PATH = path.join(__dirname, '..', 'data', 'audit', 'theatre-reviews-coverage.json');
const SCOPE_OVERRIDES_PATH = path.join(__dirname, '..', 'data', 'theatre-reviews-scope-overrides.json');
const { nextFetchFailureState } = require('./lib/tr-fetch-failure');
// Fetch time budget (the workflow timeout is 90 min). A cold archive drains over several runs
// instead of timing out and losing the index; TR_FETCH_BUDGET_MIN overrides it.
const FETCH_BUDGET_MS = (Number(process.env.TR_FETCH_BUDGET_MIN) || 65) * 60 * 1000;
const INDEX_CHECKPOINT_EVERY = 10;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** Legacy path, used only when the REST archive walk returned nothing. */
async function legacyDiscover(weShows) {
  const matched = [];
  if (TARGET_SHOWS) {
    // Targeted runs: the WP search API reaches the whole archive (BRO-4431).
    const targets = weShows.filter(s => TARGET_SHOWS.includes(s.id));
    for (const f of await discoverRoundupsBySearch(targets)) {
      matched.push({ roundup: { url: f.url, title: f.show.title, modified: null, date: null }, show: f.show, confidence: 'search', reasons: ['wp-search'] });
    }
    if (matched.length) return { matched, unmatched: [] };
  }
  const roundupUrls = await discoverRoundupUrls();
  for (const url of roundupUrls) {
    const title = extractTitleFromSlug(url);
    if (!title) continue;
    const match = matchTitleToShow(title, weShows, { market: 'west-end' });
    if (!match || !match.show || match.confidence !== 'high') continue;
    if (matched.some(m => m.show.id === match.show.id)) continue;
    matched.push({ roundup: { url, title, modified: null, date: null }, show: match.show, confidence: 'legacy', reasons: ['legacy-title-only'] });
  }
  return { matched, unmatched: [] };
}

async function main() {
  console.log('=== Theatre.Reviews Scraper (full-archive reconcile) ===\n');

  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const shows = loadShows ? loadShows() : JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const weShows = shows.filter(s => isLondonMarket(s.category));
  console.log(`Loaded ${weShows.length} London market shows\n`);

  // Step 1: discover every round-up post through the WP REST API (whole archive).
  const { fetchJSON } = require('./lib/scraper');
  const disc = await discoverRoundupPostsRest(fetchJSON);
  console.log(`Discovery: ${disc.posts.length} round-up posts over ${disc.pages} REST page(s), complete=${disc.complete}`);

  if (!disc.posts.length && !TARGET_SHOWS) {
    // The old title-only category walk cannot tell productions apart (Waiting for Godot 2017 got the
    // 2024 round-up), so a full run with no REST data writes nothing rather than fall back to it.
    console.log('::warning::theatre.reviews REST discovery returned nothing; skipping the run (no wrong-production fallback)');
    process.exitCode = 1;
    return;
  }

  // Step 2: match posts to shows by title + venue + date window.
  let { matched, unmatched } = disc.posts.length
    ? matchAllRoundups(disc.posts.map(parseRoundupPost), weShows, pinsFromOverrides(readJson(SCOPE_OVERRIDES_PATH, {})))
    : await legacyDiscover(weShows);
  if (!disc.posts.length) console.log('  REST discovery returned nothing; used the legacy category walk');
  if (disc.posts.length && unmatched.length && !TARGET_SHOWS) {
    // The slug can name the wrong house, and scope needs the venue: read the body venue of each
    // unmatched round-up and match once more.
    const venues = await fetchRoundupBodyVenues(fetchJSON, unmatched.map(u => u.roundup.id).filter(id => id != null));
    ({ matched, unmatched } = rematchWithVenues(matched, unmatched, weShows, venues));
  }
  if (TARGET_SHOWS) {
    matched = matched.filter(m => TARGET_SHOWS.includes(m.show.id));
    // A target the matcher left unmatched falls back to the date-gated WP search (opening-night runs).
    const missingTargets = weShows.filter(s => TARGET_SHOWS.includes(s.id) && !matched.some(m => m.show.id === s.id));
    if (missingTargets.length) {
      for (const f of await discoverRoundupsBySearch(missingTargets)) {
        matched.push({ roundup: { url: f.url, title: f.show.title, modified: null, date: null }, show: f.show, confidence: 'search', reasons: ['wp-search'] });
      }
    }
  }
  console.log(`Matched ${matched.length} round-ups to shows; ${unmatched.length} unmatched\n`);

  // Step 3: fetch (skipping unchanged archived pages), extract, reconcile, write the missing rows.
  const index = readJson(INDEX_PATH, {});
  const entries = [];
  let consecutiveFailures = 0;
  let movedFailures = 0;
  let st = { abort: false };
  let aborted = false;
  let budgetHit = false;
  let fetchesSinceCheckpoint = 0;
  const startedAt = Date.now();
  const saveIndex = () => { if (!DRY_RUN) fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2)); };
  const archivedFor = new Set();

  for (const { roundup, show } of matched) {
    archivedFor.add(show.id);
    const archivePath = path.join(ARCHIVE_DIR, `${show.id}.html`);
    let html = null;
    let fromCache = false;

    const prev = index[show.id];
    const cached = !FORCE ? readCachedArchiveIfValid(archivePath, Infinity, show, siblingCategoriesByShowId()[show.id]) : null;
    if (cached && !cached.valid) console.log(`  [PURGED] ${show.title}: cached archive failed ${cached.check.reason}`);
    if (cached && cached.valid) {
      const canon = archiveUrlOf(cached.html);
      const urlOk = canon ? sameRoundupUrl(canon, roundup.url) : !!(prev && sameRoundupUrl(prev.url, roundup.url));
      const unchanged = prev && sameRoundupUrl(prev.url, roundup.url) && prev.modified && prev.modified === roundup.modified;
      if (urlOk && (unchanged || !roundup.modified)) { html = cached.html; fromCache = true; }
      else if (!urlOk) console.log(`  [LEGACY ARCHIVE] ${show.title}: archived page is not ${roundup.url}; refetching`);
    }

    if (!html) {
      if (!aborted && !budgetHit && Date.now() - startedAt > FETCH_BUDGET_MS) {
        budgetHit = true;
        console.log(`::warning::theatre.reviews fetch time budget (${FETCH_BUDGET_MS / 60000} min) reached; remaining round-ups are fetched on the next run`);
      }
      if (budgetHit) { entries.push({ showId: show.id, roundupUrl: roundup.url, openingDate: show.openingDate || null, skipped: 'fetch-deferred' }); continue; }
      if (aborted) { entries.push({ showId: show.id, roundupUrl: roundup.url, openingDate: show.openingDate || null, skipped: 'fetch-aborted' }); continue; }
      console.log(`  Fetching: ${show.title} → ${roundup.url}`);
      try {
        html = await fetchPage(roundup.url);
      } catch { html = null; }
      if (!html) {
        stats.errors++;
        // A round-up that redirects to another page is a moved/dead page, not a
        // provider outage: it must not trip the spend-guard abort and leave the
        // coverage report unwritten (BRO-6089).
        let moved = false;
        try { moved = require('./lib/scraper').wasUrlMismatch(roundup.url); } catch { /* optional */ }
        // A redirecting round-up is a moved page, not an outage: separate, larger cap (BRO-6089).
        st = nextFetchFailureState({ consecutive: consecutiveFailures, moved: movedFailures }, { failed: true, moved });
        consecutiveFailures = st.consecutive; movedFailures = st.moved;
        console.log(`    ✗ Failed to fetch (${moved ? 'url moved, ' + movedFailures : consecutiveFailures} in a row)`);
        entries.push({ showId: show.id, roundupUrl: roundup.url, openingDate: show.openingDate || null, skipped: 'fetch-failed' });
        if (st.abort) {
          aborted = true;
          console.log(`  ✗ Too many fetch failures (${movedFailures} moved-page, ${consecutiveFailures} other, since the last success): stopping fetches (scraper spend guard); remaining round-ups are reported as skipped`);
        }
        continue;
      }
      consecutiveFailures = 0; movedFailures = 0;
      const v = checkArchiveCategory(html, show, siblingCategoriesByShowId()[show.id]);
      if (!v.ok) {
        console.log(`    ✗ archive guard (${v.reason}): "${(v.pageTitle||'').substring(0,60)}" — skipped`);
        stats.errors++;
        entries.push({ showId: show.id, roundupUrl: roundup.url, openingDate: show.openingDate || null, skipped: `archive-guard:${v.reason}` });
        continue;
      }
      if (!DRY_RUN) {
        fs.writeFileSync(archivePath, html);
        index[show.id] = { url: roundup.url, modified: roundup.modified || null, fetchedAt: new Date().toISOString() };
        if (++fetchesSinceCheckpoint >= INDEX_CHECKPOINT_EVERY) { saveIndex(); fetchesSinceCheckpoint = 0; }
      }
      stats.pagesChecked++;
      await new Promise(r => setTimeout(r, 4000));
    } else {
      console.log(`  [CACHED] ${show.title}`);
    }

    const rows = extractReviews(html, show.id);
    const files = loadShowFiles(path.join(REVIEW_TEXTS_DIR, show.id));
    const c = classifyRows(rows, files, show);
    // Held rows still go through the writer (it merges TR stars/excerpts into the existing
    // file); excluded rows are never written, so a flagged review is not resurrected.
    const toWrite = [...c.held.map(h => h.row), ...c.missing];
    const res = writeReviewFiles(toWrite, show.id);
    const refused = res.outcomes.filter(o => o.action === 'skipped');
    const stillMissing = c.missing
      .map(m => ({ m, o: refused.find(o => o.outlet === m.outlet && (o.critic || null) === (m.critic || null)) }))
      .filter(x => x.o)
      .map(x => ({ ...x.m, refusal: x.o.reason }));
    const createdKeys = new Set(res.outcomes.filter(o => o.action === 'new').map(o => `${o.outlet}|${o.critic || ''}`));
    const addedRows = c.missing.filter(m => createdKeys.has(`${m.outlet}|${m.critic || ''}`));
    const added = DRY_RUN ? 0 : addedRows.length;
    stats.reviewsExtracted += rows.length;
    stats.filesCreated += res.created;
    stats.filesUpdated += res.updated;
    stats.filesSkipped += res.skipped;
    const entry = coverageEntry(show, roundup.url, { ...c, missing: DRY_RUN ? c.missing : stillMissing });
    entry.openingDate = show.openingDate || null;
    entry.added = DRY_RUN ? 0 : added;
    entry.addedRows = DRY_RUN ? [] : addedRows.map(m => ({ outlet: m.outlet, critic: m.critic || null }));
    entry.matchConfidence = matched.find(m => m.show.id === show.id).confidence;
    entry.fromCache = fromCache;
    entries.push(entry);
    if (!fromCache) console.log(`    ✓ ${rows.length} rows: ${c.held.length} held, ${c.excluded.length} excluded, ${c.missing.length} missing, ${entry.added} added`);
  }

  // Archives that no matched round-up claims any more (legacy wrong-production pages).
  let orphanArchives = [];
  try {
    orphanArchives = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, '')).filter(id => !archivedFor.has(id));
  } catch { /* no archive dir */ }
  // BRO-6089: an orphan whose canonical URL is a round-up matched to ANOTHER show
  // is a wrong-production page; park it so gather-reviews/poller cannot replay it.
  // Unclaimed orphans stay (gather-reviews also writes valid archives).
  // Targeted runs shrink `matched`, so every other archive would look orphaned: full runs only.
  // Claims = REST date-window matches that passed the archive guard, never legacy title-only ones.
  const claimed = matched.filter(m => m.confidence !== 'legacy' && !entries.some(e => e.showId === m.show.id && e.skipped));
  const quarantined = TARGET_SHOWS ? [] : require('./lib/tr-archive-claim').quarantineClaimedOrphans(
    ARCHIVE_DIR, orphanArchives, claimed.map(m => ({ showId: m.show.id, url: m.roundup.url })), { dryRun: DRY_RUN });
  for (const q of quarantined) console.log(`  [QUARANTINED] ${q.showId}.html is the round-up matched to ${q.owner}`);
  if (!DRY_RUN) orphanArchives = orphanArchives.filter(id => !quarantined.some(q => q.showId === id));

  // A degraded full run (REST walk incomplete or fetches aborted) must not replace the last good report.
  const degraded = !TARGET_SHOWS && (!disc.complete || aborted);
  if (!DRY_RUN) {
    saveIndex();
    if (degraded) console.log('::warning::degraded theatre.reviews run (incomplete REST walk or aborted fetches): coverage report not overwritten');
    else writeCoverage(entries, unmatched, orphanArchives, disc);
  }
  if (degraded) process.exitCode = 1;

  console.log('\n=== Summary ===');
  console.log(`  Round-ups discovered: ${disc.posts.length} (matched ${matched.length}, unmatched ${unmatched.length})`);
  console.log(`  Pages fetched: ${stats.pagesChecked}`);
  console.log(`  Reviews listed: ${stats.reviewsExtracted}`);
  console.log(`  Files created: ${stats.filesCreated}`);
  console.log(`  Files updated: ${stats.filesUpdated}`);
  console.log(`  Files skipped (guard-rejected): ${stats.filesSkipped}`);
  console.log(`  Orphan archives (no matching round-up): ${orphanArchives.length}`);
  console.log(`  Errors: ${stats.errors}`);
}

function writeCoverage(entries, unmatched, orphanArchives, disc) {
  const prior = readJson(COVERAGE_PATH, null);
  let shows = entries;
  let unmatchedOut = markOutOfScope(
    unmatched.map(u => ({ url: u.roundup.url, title: u.roundup.title, date: u.roundup.date, ...(u.roundup.venue ? { venue: u.roundup.venue } : {}), reason: u.reason, candidates: u.candidates })), // venue-write-guard-ok: coverage report field, not a shows.json write
    readJson(SCOPE_OVERRIDES_PATH, {}),
  );
  if (TARGET_SHOWS && prior && Array.isArray(prior.shows)) {
    // A targeted run replaces only its own shows; the rest of the last full run stays.
    const ids = new Set(entries.map(e => e.showId));
    // BRO-6089: ...and a prior entry whose round-up URL a new entry now owns is stale (two owners of one URL).
    const urls = new Set(entries.filter(e => e.roundupUrl && !e.skipped).map(e => e.roundupUrl.replace(/\/+$/, '').toLowerCase()));
    shows = [...prior.shows.filter(e => !ids.has(e.showId) && !(e.roundupUrl && urls.has(e.roundupUrl.replace(/\/+$/, '').toLowerCase()))), ...entries];
    unmatchedOut = prior.unmatched || [];
  }
  // A show whose page was not fetched this run (budget, abort, failure) keeps its last good entry.
  if (prior && Array.isArray(prior.shows)) {
    const old = new Map(prior.shows.map(e => [e.showId, e]));
    shows = shows.map(e => (e.skipped && old.has(e.showId) && !old.get(e.showId).skipped) ? { ...old.get(e.showId), stale: e.skipped } : e);
  }
  shows.sort((a, b) => String(a.showId).localeCompare(String(b.showId)));
  const sum = (k) => shows.reduce((n, e) => n + (e[k] || 0), 0);
  const out = {
    _meta: {
      generatedAt: new Date().toISOString(),
      scope: TARGET_SHOWS ? 'partial-merge' : 'full-archive',
      roundupsDiscovered: disc.posts.length,
      restWalkComplete: disc.complete,
      showsMatched: shows.length,
      listed: sum('listed'), held: sum('held'), excluded: sum('excluded'), missing: sum('missing'), added: sum('added'),
      unmatched: unmatchedOut.filter(x => !x.outOfScope).length,
      outOfScope: unmatchedOut.filter(x => x.outOfScope).length,
      fetchSkipped: shows.filter(e => e.skipped).length,
    },
    shows,
    unmatched: unmatchedOut,
    orphanArchives,
  };
  fs.mkdirSync(path.dirname(COVERAGE_PATH), { recursive: true });
  fs.writeFileSync(COVERAGE_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`  Coverage report: ${path.relative(process.cwd(), COVERAGE_PATH)}`);
}

// Export for use by opening-night-poller
module.exports = { extractReviews, discoverRoundupUrls, extractTitleFromSlug, writeReviewFiles };

// Only run main() when executed directly (not when required)
if (require.main === module) {
  main().then(() => {
    process.exit(process.exitCode || 0);
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
