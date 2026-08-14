#!/usr/bin/env node
/**
 * Scrape Broadway.com audience reviews and update audience-buzz.json
 *
 * Broadway.com has verified ticket buyer reviews with 0.5-5.0 star ratings.
 * Data extracted from JSON-LD structured data on each show page (no HTML scraping needed).
 *
 * Two-phase approach:
 * 1. Discovery: Fetch /shows/ listing page → extract all show slugs + titles
 * 2. Extraction: For each matched show, fetch /shows/{slug}/ → parse JSON-LD aggregateRating
 *
 * Score conversion: (ratingValue / 5.0) * 100
 *
 * Usage:
 *   node scripts/scrape-broadway-com-audience.js [--show=hamilton-2015] [--limit=10] [--dry-run] [--verbose]
 */

const fs = require('fs');
const path = require('path');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { isLondonMarket, isBroadwayCategory } = require('./lib/venue-classification');
const { fetchPage } = require('./lib/scraper');
const { loadAudienceBuzz, saveAudienceBuzz } = require('./lib/audience-buzz-write-guard');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const includeClosed = args.includes('--include-closed');

const REQUEST_DELAY_MS = 2000; // 2s between requests — be polite
const USER_AGENT = 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)';

const showsPath = path.join(__dirname, '../data/shows.json');

let audienceBuzz, showsData, showMapById;

// ---- HTTP helpers ----

async function httpsGet(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'user-agent': USER_AGENT,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const data = await res.text();
    return { status: res.status, data };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout: ${url}`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrapper around fetchPage with a hard timeout to prevent hanging.
 */
async function fetchPageWithTimeout(url, options = {}, timeoutMs = 30000) {
  return Promise.race([
    fetchPage(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`fetchPage timeout after ${timeoutMs / 1000}s`)), timeoutMs)
    ),
  ]);
}

/**
 * Detect bot challenge pages (Cloudflare, etc.) that return valid 200 but no real content.
 */
function isBotChallenge(html) {
  return html.length < 10000 && (
    html.includes('Client Challenge') ||
    html.includes('Just a moment') ||
    html.includes('cf-browser-verification') ||
    html.includes('_fs-ch-')
  );
}

// ---- Discovery: Parse /shows/ listing page ----

/**
 * Fetch the Broadway.com /shows/ listing page and extract all show slugs + titles.
 * Returns array of { title, slug, url }.
 */
async function discoverShows() {
  console.log('Fetching Broadway.com /shows/tickets/ listing...');
  let { status, data: html } = await httpsGet('https://www.broadway.com/shows/tickets/');

  if (status !== 200) {
    throw new Error(`Broadway.com /shows/ returned ${status}`);
  }

  // If listing page is bot-challenged, retry via shared scraper (Playwright → Bright Data → ScrapingBee)
  if (isBotChallenge(html)) {
    console.log('  Bot challenge on listing page, trying scraper fallback chain...');
    const result = await fetchPageWithTimeout('https://www.broadway.com/shows/tickets/', { renderJs: true });
    const scraperHtml = result?.content || '';
    if (scraperHtml.length > 10000 && !isBotChallenge(scraperHtml)) {
      html = scraperHtml;
    } else {
      console.error(`  Scraper fallback failed for listing page (${scraperHtml.length} bytes)`);
      throw new Error('Broadway.com /shows/ blocked by bot challenge and scraper fallback failed');
    }
  }

  const shows = [];

  // Extract show links: /shows/{slug}/
  // Pattern: <a href="/shows/slug/">Title</a> or similar link structures
  const linkPattern = /<a[^>]+href="\/shows\/([a-z0-9-]+)\/"[^>]*>([^<]+)<\/a>/gi;
  let match;
  const seen = new Set();

  while ((match = linkPattern.exec(html)) !== null) {
    const slug = match[1];
    const title = match[2].trim()
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ');

    // Skip navigation/utility slugs and duplicates
    if (seen.has(slug)) continue;
    if (['shows', 'broadway-guide', 'discount-broadway-tickets', 'tickets', 'find-by-date'].includes(slug)) continue;
    if (title.length < 2) continue;
    // Skip generic navigation links
    if (['Shows', 'Tickets', 'Shows (tickets)'].includes(title)) continue;

    seen.add(slug);
    shows.push({
      title,
      slug,
      url: `https://www.broadway.com/shows/${slug}/`,
    });
  }

  console.log(`  Discovered ${shows.length} shows on Broadway.com`);
  return shows;
}

/**
 * Fetch Broadway.com sitemap to discover ALL show slugs (including closed shows).
 * The /shows/ listing only has currently-running shows. The sitemap has everything.
 * Returns array of slugs found.
 */
async function discoverFromSitemap() {
  console.log('\nFetching Broadway.com sitemap for closed shows...');

  // The main sitemap.xml is a sitemap index. The actual show URLs are in sitemap-shows.xml.
  const sitemapUrl = 'https://www.broadway.com/sitemap-shows.xml';

  let xml;
  // Try direct fetch first (sitemap-shows.xml is often not bot-challenged)
  const { data: rawXml } = await httpsGet(sitemapUrl);
  if (!isBotChallenge(rawXml) && rawXml.includes('<url>')) {
    xml = rawXml;
  } else {
    // Bot-challenged — fall through to the shared fetchPage() chain (tries
    // free Playwright first for broadway.com, then Scrapingdog/Bright Data,
    // before ever considering ScrapingBee). Previously called ScrapingBee
    // directly with premium_proxy=true ($2.48/1k, more than Bright Data's
    // $1.50/1k) for a page that's just static XML (task #5).
    console.log('  Sitemap bot-challenged, trying shared fetchPage()...');
    try {
      const result = await fetchPage(sitemapUrl, { renderJs: false });
      xml = result.content;
    } catch (e) {
      console.log(`  fetchPage sitemap fetch failed: ${e.message}`);
    }
  }

  if (!xml || !xml.includes('/shows/')) {
    console.log('  No show URLs found in sitemap');
    return [];
  }

  // Extract /shows/{slug}/ URLs from sitemap XML
  const slugs = [];
  const urlPattern = /broadway\.com\/shows\/([a-z0-9-]+)\//gi;
  let match;
  const seen = new Set();

  while ((match = urlPattern.exec(xml)) !== null) {
    const slug = match[1];
    if (seen.has(slug)) continue;
    if (['shows', 'broadway-guide', 'discount-broadway-tickets', 'tickets', 'find-by-date'].includes(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }

  console.log(`  Found ${slugs.length} show slugs in sitemap`);
  return slugs;
}

// ---- Extraction: Parse JSON-LD from show page ----

/**
 * Extract aggregateRating from JSON-LD on a Broadway.com show page.
 * Returns { ratingValue, ratingCount } or null if not found.
 */
function extractJsonLdRating(html) {
  // Find all JSON-LD script blocks
  const jsonLdPattern = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = jsonLdPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (item.aggregateRating) {
          const rating = item.aggregateRating;
          const ratingValue = parseFloat(rating.ratingValue);
          const ratingCount = parseInt(rating.ratingCount || rating.reviewCount, 10);

          if (!isNaN(ratingValue) && !isNaN(ratingCount) && ratingCount > 0) {
            return { ratingValue, ratingCount };
          }
        }
      }
    } catch {
      // Invalid JSON — skip this block
    }
  }

  return null;
}

/**
 * Fallback: extract rating from rendered HTML when JSON-LD is absent.
 * Looks for patterns like "Customer Reviews (270)" and a nearby score like "4.8".
 * Returns { ratingValue, ratingCount } or null.
 */
function extractHtmlRating(html) {
  // Pattern 1: "Customer Reviews (N)" — count in parentheses
  const countMatch = html.match(/Customer\s+Reviews?\s*\((\d+)\)/i);
  if (!countMatch) return null;
  const ratingCount = parseInt(countMatch[1], 10);
  if (!ratingCount || ratingCount < 1) return null;

  // Pattern 2: Standalone score near the reviews section
  // Look for a rating value like "4.8" in the vicinity (within 2000 chars of "Customer Reviews")
  const countIdx = html.indexOf(countMatch[0]);
  const vicinity = html.substring(Math.max(0, countIdx - 1000), countIdx + 2000);

  // Look for a decimal rating (1.0-5.0) that appears as text content, not in URLs
  // Common patterns: ">4.8<", ">4.8 ", aria-label with rating
  const ratingPatterns = [
    // Score in text content: >4.8< or >4.8 out of
    />\s*([1-5]\.\d)\s*</,
    // aria-label pattern
    /aria-label="([1-5]\.\d)/,
    // Score followed by "out of 5" or "/ 5"
    /([1-5]\.\d)\s*(?:out of|\/)\s*5/,
    // Score in a data attribute
    /data-(?:rating|score)="([1-5]\.\d)"/,
  ];

  for (const pattern of ratingPatterns) {
    const match = vicinity.match(pattern);
    if (match) {
      const ratingValue = parseFloat(match[1]);
      if (ratingValue >= 1.0 && ratingValue <= 5.0) {
        return { ratingValue, ratingCount };
      }
    }
  }

  return null;
}

// ---- Title matching ----

function normalize(s) {
  return s.toLowerCase()
    .replace(/['\u2018\u2019\u201C\u201D!:,.;\-\u2013\u2014&+()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/g, '')
    .trim();
}

// Manual overrides: Broadway.com title → our show ID
const BROADWAY_COM_OVERRIDES = {
  'Sunset Blvd.': 'sunset-boulevard-2024',
  'BOOP! The Betty Boop Musical': 'boop-2025',
  'A Wonderful World': 'a-wonderful-world-the-louis-armstrong-musical-2024',
  'Buena Vista Social Club™': 'buena-vista-social-club-2025',
  'MJ': 'mj-2022',
  'SIX: The Musical': 'six-2021',
  'Joe Turner\'s Come and Gone': 'joe-turners-come-and-gone-2009',
  'Beaches': 'beaches-2026',
};

function matchBroadwayComToShows(bcShows, ourShows) {
  const matches = [];
  const today = new Date().toISOString().split('T')[0];

  // Build lookup by normalized title
  const ourByNorm = new Map();
  for (const show of ourShows) {
    const norm = normalize(show.title);
    if (!ourByNorm.has(norm)) ourByNorm.set(norm, []);
    ourByNorm.get(norm).push(show);
  }

  for (const bc of bcShows) {
    // Check manual override first
    if (BROADWAY_COM_OVERRIDES[bc.title]) {
      const overrideId = BROADWAY_COM_OVERRIDES[bc.title];
      const show = ourShows.find(s => s.id === overrideId);
      if (show) {
        matches.push({ bc, show, confidence: 'override' });
        continue;
      }
    }

    const bcNorm = normalize(bc.title);

    // Broadway.com only lists Broadway shows — treat all as Broadway category
    const isBroadway = true;

    // Exact normalized title match
    const candidates = ourByNorm.get(bcNorm);
    if (candidates && candidates.length > 0) {
      // Filter to productions that have started (date-only, no status shortcut)
      const started = candidates.filter(s => {
        const start = s.previewsStartDate || s.openingDate;
        return !start || start <= today;
      });
      // Prefer same-category matches, fall back to any non-London
      const sameCategory = started.filter(s => {
        if (isBroadway) return isBroadwayCategory(s);
        return s.category === 'off-broadway';
      });
      const eligible = sameCategory.length > 0 ? sameCategory : started.filter(s => !isLondonMarket(s.category));
      const best = eligible.sort((a, b) => (b.openingDate || '').localeCompare(a.openingDate || ''))[0];
      if (best) {
        matches.push({ bc, show: best, confidence: 'exact' });
        continue;
      }
    }

    // Prefix matching (handles subtitle differences)
    const prefixCandidates = [];
    for (const show of ourShows) {
      const showNorm = normalize(show.title);
      const shorter = bcNorm.length <= showNorm.length ? bcNorm : showNorm;
      const longer = bcNorm.length <= showNorm.length ? showNorm : bcNorm;

      if (shorter.length >= 8 && longer.startsWith(shorter + ' ')) {
        const ratio = shorter.length / longer.length;
        if (ratio >= 0.3) {
          const start = show.previewsStartDate || show.openingDate;
          if (!start || start <= today) {
            prefixCandidates.push(show);
          }
        }
      }
    }
    if (prefixCandidates.length > 0) {
      // Apply same category/recency filtering as exact matches
      const sameCategory = prefixCandidates.filter(s => {
        if (isBroadway) return isBroadwayCategory(s);
        return s.category === 'off-broadway';
      });
      const eligible = sameCategory.length > 0 ? sameCategory : prefixCandidates.filter(s => !isLondonMarket(s.category));
      const best = eligible.sort((a, b) => (b.openingDate || '').localeCompare(a.openingDate || ''))[0];
      if (best) {
        matches.push({ bc, show: best, confidence: 'prefix' });
      }
    }
  }

  return matches;
}

// ---- Score conversion ----

function starRatingToScore(ratingValue) {
  // Convert 0.5-5.0 star rating to 0-100 scale
  return Math.round((ratingValue / 5.0) * 100);
}

// ---- Audience buzz update ----

function updateAudienceBuzz(showId, title, score, reviewCount, starRating, url) {
  if (!audienceBuzz.shows[showId]) {
    audienceBuzz.shows[showId] = {
      title,
      designation: null,
      combinedScore: null,
      sources: {
        showScore: null,
        mezzanine: null,
        reddit: null,
        theatr: null,
        broadwayCom: null,
      }
    };
  }

  const show = audienceBuzz.shows[showId];
  if (!show.sources) show.sources = {};

  // Track previous score for drop detection
  const prevScore = show.sources.broadwayCom?.score;

  show.sources.broadwayCom = {
    score,
    reviewCount,
    starRating,
    ...(url ? { url } : {}),
  };

  // Score drop detection
  if (prevScore != null && score < prevScore - 10) {
    console.warn(`  \u26A0 Score drop for ${showId}: ${prevScore} \u2192 ${score} (-${prevScore - score})`);
  }

  // Recalculate combined score
  const sd = showMapById[showId];
  const showInfo = sd ? { closingDate: sd.closingDate, status: sd.status, category: sd.category } : undefined;
  const { score: combined, weights } = calculateCombinedScore(show.sources, showInfo);

  if (combined !== null) {
    show.combinedScore = combined;

    show.designation = getDesignation(combined);

    if (verbose) {
      console.log(`  Weights: SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%, Theatr ${weights.theatr}%, BC ${weights.broadwayCom}%`);
    }
  }
}

// ---- Main ----

async function main() {
  console.log('Broadway.com Audience Data Scraper');
  console.log('==================================\n');

  // Load data
  audienceBuzz = loadAudienceBuzz();
  showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  showMapById = {};
  for (const s of showsData.shows) showMapById[s.id] = s;

  // 1. Discover shows on Broadway.com (listing page = currently running)
  const bcShows = await discoverShows();

  // 2. Match to our shows
  console.log('\nMatching to shows.json...');
  const matches = matchBroadwayComToShows(bcShows, showsData.shows);
  console.log(`Matched ${matches.length} shows from listing page`);

  // 3. Discover closed shows from sitemap (slugs only, no titles)
  const matchedIds = new Set(matches.map(m => m.show.id));
  const sitemapSlugs = includeClosed ? await discoverFromSitemap() : [];

  // Match sitemap slugs to our shows that weren't already matched
  // Broadway.com slugs are typically the show title lowercased with hyphens
  if (sitemapSlugs.length > 0) {
    const sitemapNormMap = new Map(); // normalized slug → original slug
    for (const slug of sitemapSlugs) {
      sitemapNormMap.set(slug.toLowerCase(), slug);
    }

    let sitemapMatched = 0;
    for (const show of showsData.shows) {
      if (matchedIds.has(show.id)) continue; // Already matched via listing
      if (isLondonMarket(show.category)) continue; // Broadway.com is US only

      // Generate candidate slugs from show title
      const titleSlug = show.title.toLowerCase()
        .replace(/['']/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      // Also try without common suffixes
      const candidates = [titleSlug];
      // Try shorter versions (e.g., "a-wonderful-world" from "a-wonderful-world-the-louis-armstrong-musical")
      const parts = titleSlug.split('-');
      if (parts.length > 3) {
        candidates.push(parts.slice(0, 3).join('-'));
        candidates.push(parts.slice(0, 4).join('-'));
      }

      for (const candidate of candidates) {
        if (sitemapNormMap.has(candidate)) {
          const slug = sitemapNormMap.get(candidate);
          matches.push({
            bc: { title: show.title, slug, url: `https://www.broadway.com/shows/${slug}/` },
            show,
            confidence: 'sitemap',
          });
          matchedIds.add(show.id);
          sitemapMatched++;
          break;
        }
      }
    }
    console.log(`Matched ${sitemapMatched} additional shows from sitemap`);
  }

  console.log(`Total: ${matches.length} shows to process\n`);

  // Apply filters
  let toProcess = matches;
  if (showFilter) {
    toProcess = matches.filter(m => m.show.id === showFilter);
    // If show not found in matches, try constructing URL from title directly
    if (toProcess.length === 0) {
      const show = showsData.shows.find(s => s.id === showFilter || s.slug === showFilter);
      if (show) {
        const titleSlug = show.title.toLowerCase()
          .replace(/['']/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        toProcess = [{
          bc: { title: show.title, slug: titleSlug, url: `https://www.broadway.com/shows/${titleSlug}/` },
          show,
          confidence: 'constructed',
        }];
        console.log(`Show ${showFilter} not in listing/sitemap, trying constructed URL: /shows/${titleSlug}/`);
      }
    }
    console.log(`Filtered to show: ${showFilter} (${toProcess.length} matches)`);
  }
  if (showLimit) {
    toProcess = toProcess.slice(0, showLimit);
    console.log(`Limited to ${showLimit} shows`);
  }

  // 3. Fetch rating data for each matched show
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  let scrapingBeeUsed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { bc, show, confidence } = toProcess[i];

    try {
      let { status, data: html } = await httpsGet(bc.url);

      if (status >= 400) {
        console.error(`  HTTP_ERROR ${show.id}: ${status}`);
        errors++;
        continue;
      }
      if (status !== 200) {
        if (verbose) console.log(`  SKIP ${show.id}: HTTP ${status}`);
        skipped++;
        continue;
      }

      let rating = extractJsonLdRating(html) || extractHtmlRating(html);

      // If no rating found and page looks like a bot challenge, retry via shared scraper
      if (!rating && isBotChallenge(html)) {
        if (verbose) console.log(`  Bot challenge detected for ${show.id}, trying scraper fallback...`);
        try {
          const result = await fetchPageWithTimeout(bc.url, { renderJs: true });
          const scraperHtml = result?.content || '';
          if (scraperHtml && !isBotChallenge(scraperHtml)) {
            rating = extractJsonLdRating(scraperHtml) || extractHtmlRating(scraperHtml);
            scrapingBeeUsed++;
            if (!rating && verbose) {
              console.log(`  SKIP ${show.id}: no rating data found (even via scraper, ${scraperHtml.length} bytes)`);
            }
          } else if (verbose) {
            console.log(`  Scraper fallback failed for ${show.id} (${scraperHtml.length} bytes)`);
          }
        } catch (e) {
          if (verbose) console.log(`  Scraper fallback error for ${show.id}: ${e.message}`);
        }
      }

      if (!rating) {
        if (verbose) console.log(`  SKIP ${show.id}: no rating data found`);
        skipped++;
        continue;
      }

      const score = starRatingToScore(rating.ratingValue);

      if (!dryRun) {
        updateAudienceBuzz(show.id, show.title, score, rating.ratingCount, rating.ratingValue, bc.url);
        updated++;
      } else {
        updated++;
      }

      if ((i + 1) % 10 === 0 || verbose) {
        console.log(`  [${i + 1}/${toProcess.length}] ${show.title}: ${rating.ratingValue}/5 \u2192 ${score} (${rating.ratingCount} reviews, match=${confidence})`);
      }
    } catch (e) {
      console.error(`  ERROR ${show.id}: ${e.message}`);
      errors++;
    }

    // Rate limit
    if (i < toProcess.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  if (scrapingBeeUsed > 0) {
    console.log(`\nScrapingBee used for ${scrapingBeeUsed} bot-challenged pages`);
  }

  console.log(`\nResults: ${updated} updated, ${skipped} skipped, ${errors} errors`);

  // Success rate guard [CHANGED: fix 0/0 NaN bypass — Claude + Pre-mortem]
  const processed = updated + skipped + errors;
  if (processed === 0) {
    console.error('\u26A0 Guard: 0 shows processed — discovery may have failed. Aborting save.');
    process.exit(1);
  }
  const successRate = updated / processed;
  if (successRate < 0.5) {
    console.error(`\u26A0 Guard: Only ${updated}/${processed} shows returned scores (${(successRate * 100).toFixed(0)}% < 50%)`);
    console.error('Possible systemic failure. Check if Broadway.com is blocking requests.');
  }

  // Entry-count regression check [CHANGED: prevent truncated data push — Pre-mortem]
  const prevEntryCount = Object.keys(audienceBuzz.shows).length;

  // 4. Save
  if (!dryRun && updated > 0) {
    if (!audienceBuzz._meta.sources.includes('Broadway.com')) {
      audienceBuzz._meta.sources.push('Broadway.com');
    }
    // Verify entry count didn't regress
    const newEntryCount = Object.keys(audienceBuzz.shows).length;
    if (newEntryCount < prevEntryCount * 0.8) {
      console.error(`\u26A0 Guard: Entry count dropped from ${prevEntryCount} to ${newEntryCount}. Aborting save.`);
      process.exit(1);
    }

    saveAudienceBuzz(audienceBuzz);
    console.log(`Saved audience-buzz.json (${newEntryCount} entries)`);
  }

  // Summary: unmatched shows
  const unmatched = bcShows.filter(bc =>
    !matches.some(m => m.bc.slug === bc.slug)
  );
  if (unmatched.length > 0 && verbose) {
    console.log(`\nUnmatched Broadway.com shows (${unmatched.length}):`);
    for (const u of unmatched.slice(0, 20)) {
      console.log(`  ${u.title} (${u.slug})`);
    }
  }
}

main().then(() => {
  process.exit(0);
}).catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
