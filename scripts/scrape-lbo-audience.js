#!/usr/bin/env node
/**
 * Scrape London Box Office audience scores for West End shows
 *
 * LBO (londonboxoffice.co.uk) is a TodayTix Group ticketing platform with
 * verified purchase reviews powered by Feefo. Reviews range from ~200 to 7,800+.
 *
 * Data is server-rendered in HTML — rating in <strong> tag near review count.
 * URL pattern: londonboxoffice.co.uk/{slug}-tickets/
 * Rating scale: 1-5 stars → normalized to 0-100
 *
 * Fetch strategy: plain https.get first (free), BrightData fallback (cheap).
 *
 * Usage:
 *   node scripts/scrape-lbo-audience.js [--show=hamilton-west-end-2021] [--dry-run]
 *
 * Environment variables:
 *   BRIGHTDATA_TOKEN - BrightData API token (fallback, optional)
 *   BRIGHTDATA_ZONE  - BrightData zone (default: mcp_unlocker)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { calculateCombinedScore } = require('./lib/audience-weighting');

const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE || 'mcp_unlocker';

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

const ANCHOR_SHOWS = {
  'hamilton': { minScore: 88, maxScore: 100 },
  'wicked': { minScore: 88, maxScore: 100 },
};

// Manual slug overrides for shows whose LBO slug is non-obvious
const LBO_OVERRIDES = {
  // 'Show Title': 'lbo-slug-without-tickets-suffix'
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
 * Generate slug variants to try for LBO.
 * LBO drops "The" from some slugs and "The Musical" from some.
 */
function buildLboUrlVariants(title) {
  if (LBO_OVERRIDES[title]) {
    return [`https://www.londonboxoffice.co.uk/${LBO_OVERRIDES[title]}-tickets`];
  }

  const variants = [];
  const baseSlug = titleToSlug(title);
  variants.push(baseSlug);

  // Drop leading "the-" (The Lion King → lion-king)
  if (baseSlug.startsWith('the-')) {
    variants.push(baseSlug.replace(/^the-/, ''));
  }

  // Drop trailing "-the-musical" (SIX the Musical → six)
  if (baseSlug.endsWith('-the-musical')) {
    variants.push(baseSlug.replace(/-the-musical$/, ''));
    if (baseSlug.startsWith('the-')) {
      variants.push(baseSlug.replace(/^the-/, '').replace(/-the-musical$/, ''));
    }
  }

  // Drop trailing "-musical" (Kinky Boots The Musical → kinky-boots)
  if (baseSlug.endsWith('-musical') && !baseSlug.endsWith('-the-musical')) {
    variants.push(baseSlug.replace(/-(?:a-)?musical$/, ''));
  }

  // Drop subtitle after "both-parts" or long subtitles
  const colonIdx = baseSlug.indexOf('-both-parts');
  if (colonIdx > 0) variants.push(baseSlug.slice(0, colonIdx));

  // For very long slugs, try just the first significant words
  // (e.g., "stranger-things-the-first-shadow" → "stranger-things")
  const parts = baseSlug.split('-');
  if (parts.length > 4) {
    // Try first 2-3 words
    variants.push(parts.slice(0, 2).join('-'));
    variants.push(parts.slice(0, 3).join('-'));
  }

  // Deduplicate
  const unique = [...new Set(variants)];
  return unique.map(s => `https://www.londonboxoffice.co.uk/${s}-tickets`);
}

// --- Data extraction ---

function extractReviewData(html) {
  // LBO HTML structure (verified):
  //   <strong class="purple rndrtg">4.7</strong>
  //   ... <span>1183</span> reviews ...
  // The rating <strong> has class "rndrtg" — unique identifier
  const ratingMatch = html.match(/<strong[^>]*rndrtg[^>]*>(\d+\.?\d*)<\/strong>/i);
  if (!ratingMatch) return null;

  // Find review count: <span>NNNN</span> reviews (within the rev section)
  const countMatch = html.match(/<span>(\d[\d,]*)<\/span>\s*(?:verified\s+)?reviews/i);
  if (!countMatch) return null;

  const rating = parseFloat(ratingMatch[1]);
  const reviewCount = parseInt(countMatch[1].replace(/,/g, ''), 10);

  // Validate: rating should be 1-5, count should be > 0
  if (rating < 1 || rating > 5 || reviewCount < 1) return null;

  // Extract page title for validation — strip " Tickets", " - London Box Office", etc.
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const pageTitle = titleMatch
    ? titleMatch[1].replace(/\s*[-|–].*$/, '').replace(/\s+tickets$/i, '').trim()
    : null;

  return { rating, reviewCount, pageTitle };
}

async function fetchLboPage(url) {
  try {
    const res = await httpsGet(url);
    if (res.status === 200 && res.body.length > 1000) {
      return res.body;
    }
    if (res.status === 404 || res.status === 301 || res.status === 302) return null;
  } catch (e) {
    console.log(`  ⚠️  Plain fetch failed: ${e.message}`);
  }

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
  const weShows = allShows.filter(s => s.category === 'west-end');

  console.log(`📊 London Box Office Audience Scraper`);
  console.log(`   West End shows: ${weShows.length}`);
  console.log(`   Dry run: ${dryRun}`);
  console.log('');

  let toProcess = weShows;
  if (showFilter) {
    toProcess = weShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (toProcess.length === 0) {
      console.error(`❌ Show not found: ${showFilter}`);
      process.exit(1);
    }
  }

  console.log(`   Processing: ${toProcess.length} shows\n`);

  const stats = { processed: 0, found: 0, notFound: 0, errors: 0, skipped: 0 };
  const anchorResults = {};

  for (let i = 0; i < toProcess.length; i++) {
    const show = toProcess[i];
    const title = show.title;
    stats.processed++;

    console.log(`[${i + 1}/${toProcess.length}] ${title} (${show.id})`);

    const urlVariants = buildLboUrlVariants(title);
    let html = null;
    let usedUrl = null;

    // Try each slug variant
    for (const url of urlVariants) {
      console.log(`  URL: ${url}`);
      let lastError = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          console.log(`  Retry ${attempt}/${MAX_RETRIES}...`);
          await sleep(RETRY_DELAY_MS * attempt);
        }
        try {
          html = await fetchLboPage(url);
          break;
        } catch (e) {
          lastError = e;
        }
      }

      if (html) {
        usedUrl = url;
        break;
      }

      // Rate limit between variant attempts
      if (urlVariants.indexOf(url) < urlVariants.length - 1) {
        await sleep(RATE_LIMIT_MS);
      }
    }

    if (!html) {
      console.log(`  ⏭️  Not found on LBO (all variants 404)`);
      stats.notFound++;
      if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Extract review data
    const data = extractReviewData(html);
    if (!data) {
      console.log(`  ⚠️  No review data found in HTML`);
      stats.errors++;
      if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Validate: page title should match our show title
    if (data.pageTitle) {
      const norm = s => s
        .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&[a-z]+;/g, '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9\s]/g, '').trim();
      const pageNorm = norm(data.pageTitle.split(':')[0].split('(')[0]);
      const ourNorm = norm(title.split(':')[0].split('(')[0]);
      if (!pageNorm.includes(ourNorm) && !ourNorm.includes(pageNorm)) {
        console.log(`  ⚠️  Title mismatch! Page: "${data.pageTitle}" vs Ours: "${title}" — SKIPPING`);
        stats.skipped++;
        if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
        continue;
      }
    }

    const score = Math.round((data.rating / 5) * 100);
    console.log(`  ✅ ${data.rating}/5 (${data.reviewCount} reviews) → score: ${score}`);

    const titleLower = title.toLowerCase();
    if (ANCHOR_SHOWS[titleLower]) {
      anchorResults[titleLower] = score;
    }

    if (!dryRun) {
      const buzzData = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
      if (!buzzData.shows) buzzData.shows = {};

      const showEntry = buzzData.shows[show.id] || { title: show.title, sources: {} };
      if (!showEntry.sources) showEntry.sources = {};

      showEntry.sources.lbo = {
        score,
        reviewCount: data.reviewCount,
        starRating: data.rating,
        lastUpdated: new Date().toISOString().slice(0, 10),
      };

      const showInfo = { closingDate: show.closingDate, status: show.status };
      const combined = calculateCombinedScore(showEntry.sources, showInfo);
      if (combined.score != null) {
        showEntry.combinedScore = combined.score;
        showEntry.weights = combined.weights;
        if (combined.score >= 88) showEntry.designation = 'Loving';
        else if (combined.score >= 78) showEntry.designation = 'Liking';
        else if (combined.score >= 68) showEntry.designation = 'Shrugging';
        else if (combined.score >= 53) showEntry.designation = 'Disliking';
        else showEntry.designation = 'Loathing';
      }

      showEntry.title = show.title;
      buzzData.shows[show.id] = showEntry;

      buzzData._meta.lastUpdated = new Date().toISOString().slice(0, 10);
      if (!buzzData._meta.sources.includes('LBO')) {
        buzzData._meta.sources.push('LBO');
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
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
