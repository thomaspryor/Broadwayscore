#!/usr/bin/env node
/**
 * Scrape SeatPlan audience scores for West End shows
 *
 * SeatPlan (seatplan.com) is a UK theater ticketing/review platform with 1K-8K
 * verified audience reviews per West End show. Scores are server-rendered in
 * window.reviewsPanelData as inline JSON on each show page.
 *
 * URL pattern: seatplan.com/london/{slug}-tickets/
 * Rating scale: 1-5 stars → normalized to 0-100
 *
 * Fetch strategy: plain https.get first (free), BrightData fallback (cheap).
 * No ScrapingBee needed — static HTML.
 *
 * Usage:
 *   node scripts/scrape-seatplan-audience.js [--show=hamilton-2024] [--dry-run]
 *
 * Environment variables:
 *   BRIGHTDATA_TOKEN - BrightData API token (fallback, optional)
 *   BRIGHTDATA_ZONE  - BrightData zone (default: web_unlocker2)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { isLondonMarket } = require('./lib/venue-classification');
const { buildLondonSlugVariants } = require('./lib/show-matching');
const { batchDiscoverSlugs } = require('./lib/serp-slug-discovery');

const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE || 'web_unlocker2';

/**
 * Fetch page via BrightData Web Unlocker (inlined to avoid scraper.js Playwright dependency)
 */
function fetchWithBrightData(url) {
  if (!BRIGHTDATA_TOKEN) return Promise.resolve(null);
  const body = JSON.stringify({ zone: BRIGHTDATA_ZONE, url, format: 'raw' });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BRIGHTDATA_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve({ content: data });
        else reject(new Error(`BrightData HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('BrightData timeout')); });
    req.end(body);
  });
}

// --- CLI args ---
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');

const RATE_LIMIT_MS = 2000;
const CHECKPOINT_EVERY = 10;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

// Anchor shows with known scores for validation
const ANCHOR_SHOWS = {
  'hamilton': { minScore: 90, maxScore: 100 },
  'wicked': { minScore: 88, maxScore: 100 },
};

// Manual slug overrides for shows whose SeatPlan slug doesn't match titleToSlug()
const SEATPLAN_OVERRIDES = {
  'Paddington The Musical': 'paddington-musical',
  'Cabaret at the Kit Kat Club': 'cabaret',
};

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const showsPath = path.join(__dirname, '../data/shows.json');

// --- HTTP helpers ---

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve({ status: res.statusCode, body: '', redirect: res.headers.location });
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Data extraction ---

function extractReviewData(html) {
  // Match window.reviewsPanelData = {...}
  const match = html.match(/window\.reviewsPanelData\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;

  try {
    // reviewsPanelData uses unquoted keys — parse with Function (safe: no eval of user input)
    const data = new Function('return ' + match[1])();

    if (!data || typeof data.ratingAverage !== 'number' || typeof data.reviewsCount !== 'number') {
      return null;
    }

    return {
      showName: data.showName || null,
      venueName: data.venueName || null,
      ratingAverage: data.ratingAverage,
      reviewsCount: data.reviewsCount,
      productionId: data.productionId || null,
      ratings: data.ratings || null, // { "1": N, "2": N, "3": N, "4": N, "5": N }
    };
  } catch (e) {
    console.error(`  ⚠️  Failed to parse reviewsPanelData: ${e.message}`);
    return null;
  }
}

function titleToSlug(title) {
  return title
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // é→e, ü→u, etc.
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function buildSeatplanUrls(title) {
  if (SEATPLAN_OVERRIDES[title]) {
    return [`https://seatplan.com/london/${SEATPLAN_OVERRIDES[title]}-tickets/`];
  }
  return buildLondonSlugVariants(title, titleToSlug)
    .map(s => `https://seatplan.com/london/${s}-tickets/`);
}

async function fetchSeatplanPage(url) {
  // Try plain fetch first (free)
  try {
    const res = await httpsGet(url);
    if (res.status === 200 && res.body.length > 1000) {
      return res.body;
    }
    if (res.status === 404) return null;
  } catch (e) {
    console.log(`  ⚠️  Plain fetch failed: ${e.message}`);
  }

  // Fall back to BrightData
  if (process.env.BRIGHTDATA_TOKEN) {
    try {
      console.log('  → Trying BrightData fallback...');
      const result = await fetchWithBrightData(url);
      if (result && result.content && result.content.length > 1000) {
        return result.content;
      }
    } catch (e) {
      console.log(`  ⚠️  BrightData failed: ${e.message}`);
    }
  }

  return null;
}

// --- Main ---

async function main() {
  // Load shows.json (nested under .shows key with numeric IDs)
  const showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const showsObj = showsRaw.shows || showsRaw;
  const allShows = Object.values(showsObj).filter(s => s && s.id);
  const weShows = allShows.filter(s => isLondonMarket(s.category));

  console.log(`📊 SeatPlan Audience Scraper`);
  console.log(`   West End shows: ${weShows.length}`);
  console.log(`   Dry run: ${dryRun}`);
  console.log('');

  // Determine which shows to process
  let toProcess = weShows;
  if (showFilter) {
    toProcess = weShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (toProcess.length === 0) {
      console.log(`⚠️  Show not found in WE catalog: ${showFilter} (may be Broadway — skipping)`);
      process.exit(0);
    }
  }

  console.log(`   Processing: ${toProcess.length} shows\n`);

  const stats = { processed: 0, found: 0, notFound: 0, errors: 0, skipped: 0 };
  const missedShows = [];
  const anchorResults = {};

  for (let i = 0; i < toProcess.length; i++) {
    const show = toProcess[i];
    const title = show.title;
    stats.processed++;

    console.log(`[${i + 1}/${toProcess.length}] ${title} (${show.id})`);

    const urlVariants = buildSeatplanUrls(title);
    let html = null;
    let lastError = null;
    let usedUrl = null;

    for (const url of urlVariants) {
      console.log(`  URL: ${url}`);
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          console.log(`  Retry ${attempt}/${MAX_RETRIES}...`);
          await sleep(RETRY_DELAY_MS * attempt);
        }
        try {
          html = await fetchSeatplanPage(url);
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (html) { usedUrl = url; break; }
      if (urlVariants.indexOf(url) < urlVariants.length - 1) await sleep(RATE_LIMIT_MS);
    }

    if (!html) {
      if (lastError) {
        console.log(`  ❌ All attempts failed: ${lastError.message}`);
        stats.errors++;
        missedShows.push({ id: show.id, title, reason: 'error' });
      } else {
        console.log(`  ⏭️  Not found on SeatPlan (all variants 404)`);
        stats.notFound++;
        missedShows.push({ id: show.id, title, reason: 'not-found' });
      }

      if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Extract review data
    const data = extractReviewData(html);
    if (!data) {
      console.log(`  ⚠️  No reviewsPanelData found in HTML`);
      stats.errors++;
      if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Validate: page title should match our show title
    if (data.showName) {
      // Normalize both: strip accents, & → and, lowercase, strip punctuation
      const norm = s => s
        .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&[a-z]+;/g, '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9\s]/g, '').trim();
      const pageNorm = norm(data.showName.split(':')[0].split('(')[0]);
      const ourNorm = norm(title.split(':')[0].split('(')[0]);
      if (!pageNorm.includes(ourNorm) && !ourNorm.includes(pageNorm)) {
        console.log(`  ⚠️  Title mismatch! Page: "${data.showName}" vs Ours: "${title}" — SKIPPING`);
        stats.skipped++;
        missedShows.push({ id: show.id, title, reason: 'title-mismatch' });
        if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
        continue;
      }
    }

    // Convert to 0-100 scale
    const score = Math.round((data.ratingAverage / 5) * 100);
    console.log(`  ✅ ${data.ratingAverage}/5 (${data.reviewsCount} reviews) → score: ${score}`);

    // Track anchor results for validation
    const titleLower = title.toLowerCase();
    if (ANCHOR_SHOWS[titleLower]) {
      anchorResults[titleLower] = score;
    }

    if (!dryRun) {
      // Re-read audience-buzz.json fresh before each write (prevents stale data overwrites)
      const buzzData = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
      if (!buzzData.shows) buzzData.shows = {};

      const showEntry = buzzData.shows[show.id] || { title: show.title, sources: {} };
      if (!showEntry.sources) showEntry.sources = {};

      showEntry.sources.seatplan = {
        score,
        reviewCount: data.reviewsCount,
        starRating: data.ratingAverage,
        lastUpdated: new Date().toISOString(),
        ...(data.ratings ? { ratingDistribution: data.ratings } : {}),
        ...(usedUrl ? { url: usedUrl } : {}),
      };

      // Recalculate combined score
      const showInfo = { closingDate: show.closingDate, status: show.status };
      const combined = calculateCombinedScore(showEntry.sources, showInfo);
      if (combined.score != null) {
        showEntry.combinedScore = combined.score;
        showEntry.weights = combined.weights;
        showEntry.designation = getDesignation(combined.score);
      }

      showEntry.title = show.title;
      buzzData.shows[show.id] = showEntry;

      // Write back immediately (re-read + merge pattern)
      buzzData._meta.lastUpdated = new Date().toISOString();
      if (!buzzData._meta.sources.includes('SeatPlan')) {
        buzzData._meta.sources.push('SeatPlan');
      }
      fs.writeFileSync(audienceBuzzPath, JSON.stringify(buzzData, null, 2) + '\n');

      if ((i + 1) % CHECKPOINT_EVERY === 0) {
        console.log(`  💾 Checkpoint saved (${i + 1} processed)`);
      }
    }

    stats.found++;
    if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
  }

  // Anchor validation
  let anchorFailed = false;
  for (const [name, expected] of Object.entries(ANCHOR_SHOWS)) {
    if (anchorResults[name] != null) {
      const score = anchorResults[name];
      if (score < expected.minScore || score > expected.maxScore) {
        console.error(`\n❌ ANCHOR VALIDATION FAILED: ${name} score ${score} outside expected range [${expected.minScore}-${expected.maxScore}]`);
        anchorFailed = true;
      } else {
        console.log(`  ✅ Anchor OK: ${name} = ${score} (expected ${expected.minScore}-${expected.maxScore})`);
      }
    }
  }

  if (anchorFailed && !dryRun) {
    console.error('\n⚠️  Anchor validation failed — scores may be unreliable. Review before committing.');
    process.exit(1);
  }

  console.log('\n─── Summary ───');
  console.log(`  Processed: ${stats.processed}`);
  console.log(`  Found:     ${stats.found}`);
  console.log(`  Not found: ${stats.notFound}`);
  console.log(`  Skipped:   ${stats.skipped} (title mismatch)`);
  console.log(`  Errors:    ${stats.errors}`);

  if (stats.found === 0 && toProcess.length > 3) {
    console.error('\n❌ ZERO shows matched — possible URL pattern change. Aborting.');
    process.exit(1);
  }

  // Coverage report
  const openMissed = missedShows.filter(m => {
    const s = toProcess.find(s => s.id === m.id);
    return s && (s.status === 'open' || s.status === 'previews');
  });
  if (openMissed.length > 0 && !showFilter) {
    console.log('\n─── Coverage Gaps (open shows) ───');
    for (const m of openMissed) {
      console.log(`  ${m.reason.padEnd(15)} ${m.id}`);
    }
    // SERP slug discovery for not-found shows
    const notFound = openMissed.filter(s => s.reason === 'not-found');
    if (notFound.length > 0) {
      const discovered = await batchDiscoverSlugs('seatplan.com', notFound, 'london');
      if (discovered.size === 0) {
        console.log(`\nAdd to SEATPLAN_OVERRIDES if slug is known:`);
        for (const m of notFound) {
          console.log(`  '${m.title}': 'PLATFORM-SLUG-HERE',`);
        }
      }
    }
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
