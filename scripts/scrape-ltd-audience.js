#!/usr/bin/env node
/**
 * Scrape London Theatre Direct audience scores for West End shows
 *
 * LTD (londontheatredirect.com) is a UK theater ticket reseller with
 * 1K-14K verified audience reviews per show. Aggregate ratings are
 * server-rendered in JSON-LD (schema.org Product → aggregateRating).
 *
 * URL patterns:
 *   /musical/{slug}-tickets
 *   /play/{slug}-tickets
 *   /experience/{slug}-tickets
 * Rating scale: 1-5 stars → normalized to 0-100
 *
 * Fetch strategy: plain https.get first (free), BrightData fallback (cheap).
 * No ScrapingBee needed — static HTML with JSON-LD.
 *
 * Usage:
 *   node scripts/scrape-ltd-audience.js [--show=hamilton-west-end-2021] [--dry-run]
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
  'hamilton': { minScore: 88, maxScore: 100 },
  'wicked': { minScore: 85, maxScore: 100 },
};

// Manual slug overrides for shows whose LTD slug doesn't match titleToSlug()
const LTD_OVERRIDES = {
  'Hamilton': 'hamilton-west-end',
  'Cabaret': 'cabaret-london',
  'Six': 'six-london-vaudeville-theatre',
  'Oliver!': 'oliver-gielgud',
  "Disney's Hercules": 'hercules',
  'Come Alive! The Greatest Showman Circus Spectacular': 'come-alive-the-greatest-showman-circus-spectacular',
  'Burlesque The Musical': 'burlesque-musical',
  'Horrible Histories: Barmy Britain': 'horrible-histories-barmy-britain-the-best-bits',
  'One Flew Over the Cuckoo\'s Nest': 'one-flew-over-the-cuckoos-nest-play',
  'Romeo and Juliet': 'romeo-and-juliet-london',
  'A Midsummer Night\'s Dream': 'a-midsummer-nights-dream-london',
  'Shadowlands': 'shadowlands-the-play',
  'Cabaret at the Kit Kat Club': 'kit-kat-club',
  'Austentatious: An Improvised Jane Austen Novel': 'austentatious',
  'SIX the Musical': 'six',
  'Moulin Rouge! The Musical': 'moulin-rouge',
};

// LTD uses /musical/, /play/, and /experience/ prefixes
const LTD_CATEGORIES = ['musical', 'play', 'experience'];

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
      // Follow redirects (up to 3 hops)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirect = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.londontheatredirect.com${res.headers.location}`;
        res.resume();
        resolve(httpsGet(redirect));
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

// --- Slug building ---

function titleToSlug(title) {
  return title
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

/**
 * Generate URL variants to try for LTD.
 * Each slug is tried under /musical/, /play/, and /experience/ prefixes.
 */
function buildLtdUrls(title) {
  let slugs;
  if (LTD_OVERRIDES[title]) {
    slugs = [LTD_OVERRIDES[title]];
  } else {
    slugs = buildLondonSlugVariants(title, titleToSlug);
    // LTD-specific: for subtitles with "The Musical", try without
    const base = titleToSlug(title);
    if (base.endsWith('-the-musical')) {
      slugs.push(base.replace(/-the-musical$/, ''));
    }
  }
  // Generate all category × slug combinations
  const urls = [];
  for (const slug of [...new Set(slugs)]) {
    for (const cat of LTD_CATEGORIES) {
      urls.push(`https://www.londontheatredirect.com/${cat}/${slug}-tickets`);
    }
  }
  return urls;
}

// --- Data extraction ---

/**
 * Extract aggregate rating from JSON-LD Product schema.
 * LTD embeds schema.org Product with aggregateRating in <script type="application/ld+json">
 */
function extractReviewData(html) {
  // Find all JSON-LD blocks
  const jsonLdRegex = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      // JSON-LD can be a single object or an array of objects
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const data of items) {
        if (data['@type'] === 'Product' && data.aggregateRating) {
          const agg = data.aggregateRating;
          if (typeof agg.ratingValue === 'number' && typeof agg.reviewCount === 'number') {
            return {
              showName: data.name || null,
              ratingValue: agg.ratingValue,
              reviewCount: agg.reviewCount,
              bestRating: agg.bestRating || 5,
              worstRating: agg.worstRating || 1,
            };
          }
        }
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  return null;
}

async function fetchLtdPage(url) {
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
  if (BRIGHTDATA_TOKEN) {
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
  const showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const showsObj = showsRaw.shows || showsRaw;
  const allShows = Object.values(showsObj).filter(s => s && s.id);
  const weShows = allShows.filter(s => isLondonMarket(s.category));

  console.log(`📊 London Theatre Direct Audience Scraper`);
  console.log(`   West End shows: ${weShows.length}`);
  console.log(`   Dry run: ${dryRun}`);
  console.log('');

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

    const urlVariants = buildLtdUrls(title);
    let html = null;
    let usedUrl = null;

    // Try each URL variant — stop at first success
    for (const url of urlVariants) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          console.log(`  Retry ${attempt}/${MAX_RETRIES}...`);
          await sleep(RETRY_DELAY_MS * attempt);
        }
        try {
          html = await fetchLtdPage(url);
          break;
        } catch {
          // Retry
        }
      }
      if (html) {
        usedUrl = url;
        console.log(`  URL: ${url}`);
        break;
      }
    }

    if (!html) {
      console.log(`  ⏭️  Not found on LTD (all variants 404)`);
      stats.notFound++;
      missedShows.push({ id: show.id, title, reason: 'not-found' });
      if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Extract review data from JSON-LD
    const data = extractReviewData(html);
    if (!data) {
      console.log(`  ⚠️  No aggregateRating found in JSON-LD`);
      stats.errors++;
      missedShows.push({ id: show.id, title, reason: 'no-rating' });
      if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Validate: page title should match our show title
    if (data.showName) {
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

    // Convert to 0-100 scale (handle non-standard bestRating if needed)
    const range = data.bestRating - data.worstRating;
    const score = Math.round(((data.ratingValue - data.worstRating) / range) * 100);
    console.log(`  ✅ ${data.ratingValue}/${data.bestRating} (${data.reviewCount} reviews) → score: ${score}`);

    // Track anchor results for validation
    const titleLower = title.toLowerCase();
    if (ANCHOR_SHOWS[titleLower]) {
      anchorResults[titleLower] = score;
    }

    if (!dryRun) {
      // Re-read audience-buzz.json fresh before each write
      const buzzData = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
      if (!buzzData.shows) buzzData.shows = {};

      const showEntry = buzzData.shows[show.id] || { title: show.title, sources: {} };
      if (!showEntry.sources) showEntry.sources = {};

      showEntry.sources.ltd = {
        score,
        reviewCount: data.reviewCount,
        starRating: data.ratingValue,
        lastUpdated: new Date().toISOString(),
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

      buzzData._meta.lastUpdated = new Date().toISOString();
      if (!buzzData._meta.sources.includes('LTD')) {
        buzzData._meta.sources.push('LTD');
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
      const discovered = await batchDiscoverSlugs('londontheatredirect.com', notFound);
      if (discovered.size === 0) {
        console.log(`\nAdd to LTD_OVERRIDES if slug is known:`);
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
