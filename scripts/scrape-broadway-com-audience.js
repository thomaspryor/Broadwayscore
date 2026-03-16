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
const https = require('https');
const { calculateCombinedScore } = require('./lib/audience-weighting');
const { isLondonMarket } = require('./lib/venue-classification');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

const REQUEST_DELAY_MS = 2000; // 2s between requests — be polite
const USER_AGENT = 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)';

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const showsPath = path.join(__dirname, '../data/shows.json');

let audienceBuzz, showsData, showMapById;

// ---- HTTP helpers ----

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'user-agent': USER_AGENT,
      },
    };

    const req = https.request(reqOptions, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
        return httpsGet(redirectUrl).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Discovery: Parse /shows/ listing page ----

/**
 * Fetch the Broadway.com /shows/ listing page and extract all show slugs + titles.
 * Returns array of { title, slug, url }.
 */
async function discoverShows() {
  console.log('Fetching Broadway.com /shows/ listing...');
  const { status, data: html } = await httpsGet('https://www.broadway.com/shows/');

  if (status !== 200) {
    throw new Error(`Broadway.com /shows/ returned ${status}`);
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

    // Exact normalized title match
    const candidates = ourByNorm.get(bcNorm);
    if (candidates && candidates.length > 0) {
      // Prefer most recent Broadway production that has started or is in previews
      const started = candidates.filter(s => {
        if (s.status === 'open' || s.status === 'previews') return true;
        const start = s.previewsStartDate || s.openingDate;
        return !start || start <= today;
      });
      // Prefer Broadway category
      const broadway = started.filter(s => !s.category || s.category === 'broadway');
      const eligible = broadway.length > 0 ? broadway : started.filter(s => !isLondonMarket(s.category));
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
          if (show.status === 'open' || show.status === 'previews') {
            prefixCandidates.push(show);
          } else {
            const start = show.previewsStartDate || show.openingDate;
            if (!start || start <= today) {
              prefixCandidates.push(show);
            }
          }
        }
      }
    }
    if (prefixCandidates.length > 0) {
      const broadway = prefixCandidates.filter(s => !s.category || s.category === 'broadway');
      const eligible = broadway.length > 0 ? broadway : prefixCandidates.filter(s => !isLondonMarket(s.category));
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

function updateAudienceBuzz(showId, title, score, reviewCount, starRating) {
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

    if (combined >= 88) show.designation = 'Loving';
    else if (combined >= 78) show.designation = 'Liking';
    else if (combined >= 68) show.designation = 'Shrugging';
    else if (combined >= 53) show.designation = 'Disliking';
    else show.designation = 'Loathing';

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
  audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
  showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  showMapById = {};
  for (const s of showsData.shows) showMapById[s.id] = s;

  // 1. Discover shows on Broadway.com
  const bcShows = await discoverShows();

  // 2. Match to our shows
  console.log('\nMatching to shows.json...');
  const matches = matchBroadwayComToShows(bcShows, showsData.shows);
  console.log(`Matched ${matches.length} shows\n`);

  // Apply filters
  let toProcess = matches;
  if (showFilter) {
    toProcess = matches.filter(m => m.show.id === showFilter);
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

  for (let i = 0; i < toProcess.length; i++) {
    const { bc, show, confidence } = toProcess[i];

    try {
      const { status, data: html } = await httpsGet(bc.url);

      if (status >= 400) {
        // Hard error: 4xx/5xx means site is blocking or broken — don't treat as "no data"
        console.error(`  HTTP_ERROR ${show.id}: ${status}`);
        errors++;
        continue;
      }
      if (status !== 200) {
        if (verbose) console.log(`  SKIP ${show.id}: HTTP ${status}`);
        skipped++;
        continue;
      }

      const rating = extractJsonLdRating(html);
      if (!rating) {
        if (verbose) console.log(`  SKIP ${show.id}: no JSON-LD aggregateRating found`);
        skipped++;
        continue;
      }

      const score = starRatingToScore(rating.ratingValue);

      if (!dryRun) {
        updateAudienceBuzz(show.id, show.title, score, rating.ratingCount, rating.ratingValue);
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
    audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
    if (!audienceBuzz._meta.sources.includes('Broadway.com')) {
      audienceBuzz._meta.sources.push('Broadway.com');
    }
    // Verify entry count didn't regress
    const newEntryCount = Object.keys(audienceBuzz.shows).length;
    if (newEntryCount < prevEntryCount * 0.8) {
      console.error(`\u26A0 Guard: Entry count dropped from ${prevEntryCount} to ${newEntryCount}. Aborting save.`);
      process.exit(1);
    }

    fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
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

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
