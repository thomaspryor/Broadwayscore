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

const ANCHOR_SHOWS = {
  'hamilton': { minScore: 88, maxScore: 100 },
  'wicked': { minScore: 88, maxScore: 100 },
};

// Manual slug overrides for shows whose LBO slug is non-obvious
const LBO_OVERRIDES = {
  "I'm Sorry, Prime Minister": 'sorry-prime-minister',
  'Witness for the Prosecution': 'witness-for-the-prosecution-by-agatha-christie',
  'Cabaret at the Kit Kat Club': 'cabaret',
  'The Hunger Games On Stage': 'hunger-games',
  'Paddington The Musical': 'paddington',
  'Harry Potter And The Cursed Child: Both Parts': 'harry-potter',
  'Stranger Things: The First Shadow': 'stranger-things',
  'Death Note: The Musical': 'death-note',
  'Billy Elliot the Musical': 'billy-elliot',
};

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const showsPath = path.join(__dirname, '../data/shows.json');
const reviewsPath = path.join(__dirname, '../data/audience-reviews-lbo.json');

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
 * Uses shared buildLondonSlugVariants + LBO-specific long-slug logic.
 */
function buildLboUrlVariants(title) {
  if (LBO_OVERRIDES[title]) {
    return [`https://www.londonboxoffice.co.uk/${LBO_OVERRIDES[title]}-tickets`];
  }
  const variants = buildLondonSlugVariants(title, titleToSlug);
  // LBO-specific: for very long slugs, try first 2-3 words
  const baseSlug = titleToSlug(title);
  const parts = baseSlug.split('-');
  if (parts.length > 4) {
    variants.push(parts.slice(0, 2).join('-'));
    variants.push(parts.slice(0, 3).join('-'));
  }
  return [...new Set(variants)].map(s => `https://www.londonboxoffice.co.uk/${s}-tickets`);
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

/**
 * Extract individual reviews from LBO HTML.
 * Each review is a <div class="creview"> with schema.org markup.
 */
function extractIndividualReviews(html) {
  const reviews = [];
  // Decode common HTML entities
  const decode = s => s
    .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&[a-z]+;/g, '').trim();

  // Split on review containers
  const blocks = html.split(/<div class="creview"/);
  // Skip first block (before first review)
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    try {
      const ratingM = block.match(/itemprop="ratingValue"\s+content="(\d)"/);
      const dateM = block.match(/itemprop="datePublished"\s+content="([^"]+)"/);
      const titleM = block.match(/itemprop="name">([^<]+)<\/strong>/);
      const bodyM = block.match(/itemprop="reviewBody"[^>]*>([^<]+)</);
      const authorM = block.match(/itemprop="author"[^>]*>.*?itemprop="name">([^<]+)/s);
      const verified = /verified/.test(block.slice(0, 200));

      if (!titleM && !bodyM) continue; // Skip reviews with no text at all

      reviews.push({
        rating: ratingM ? parseInt(ratingM[1]) : null,
        date: dateM ? dateM[1] : null,
        title: titleM ? decode(titleM[1]) : null,
        body: bodyM ? decode(bodyM[1]) : null,
        author: authorM ? decode(authorM[1]) : null,
        verified,
      });
    } catch {
      // Skip malformed review blocks
    }
  }
  return reviews;
}

/**
 * Fetch ALL reviews from Feefo API (paginated, free, no auth).
 * Returns a map of product name → array of review objects.
 */
async function fetchAllFeefoReviews() {
  const FEEFO_BASE = 'https://api.feefo.com/api/10/reviews/all?merchant_identifier=london-box-office-uk&page_size=100';
  const allByProduct = {};
  let page = 1;
  let totalPages = 1;

  console.log('📡 Fetching Feefo reviews...');

  while (page <= totalPages) {
    try {
      const res = await httpsGet(`${FEEFO_BASE}&page=${page}`);
      const data = JSON.parse(res.body);
      const meta = data.summary?.meta || {};
      totalPages = meta.pages || 1;

      for (const r of data.reviews || []) {
        const products = r.products_purchased || [];
        const service = r.service || {};
        const review = {
          rating: service.rating?.rating || null,
          date: r.last_updated_date?.split('T')[0] || null,
          title: service.title || null,
          body: service.review || null,
          author: r.customer?.display_name || null,
          verified: true, // All Feefo reviews are verified
          source: 'feefo',
        };

        for (const product of products) {
          if (!allByProduct[product]) allByProduct[product] = [];
          allByProduct[product].push(review);
        }
      }

      page++;
      if (page <= totalPages) await sleep(1000); // gentle rate limit
    } catch (e) {
      console.log(`  ⚠️  Feefo page ${page} failed: ${e.message}`);
      break;
    }
  }

  const totalReviews = Object.values(allByProduct).reduce((s, arr) => s + arr.length, 0);
  console.log(`  ✅ ${totalReviews} Feefo reviews across ${Object.keys(allByProduct).length} products`);
  return allByProduct;
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
  const weShows = allShows.filter(s => isLondonMarket(s.category));

  console.log(`📊 London Box Office Audience Scraper`);
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

  // Fetch all Feefo reviews once (16 API calls, free)
  const feefoByProduct = dryRun ? {} : await fetchAllFeefoReviews();

  const stats = { processed: 0, found: 0, notFound: 0, errors: 0, skipped: 0 };
  const missedShows = [];
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
      missedShows.push({ id: show.id, title, reason: 'not-found' });
      if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Extract review data
    const data = extractReviewData(html);
    if (!data) {
      console.log(`  ⚠️  No review data found in HTML`);
      stats.errors++;
      missedShows.push({ id: show.id, title, reason: 'error' });
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
        missedShows.push({ id: show.id, title, reason: 'title-mismatch' });
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
        lastUpdated: new Date().toISOString(),
        ...(usedUrl ? { url: usedUrl } : {}),
      };

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
      if (!buzzData._meta.sources.includes('LBO')) {
        buzzData._meta.sources.push('LBO');
      }
      fs.writeFileSync(audienceBuzzPath, JSON.stringify(buzzData, null, 2) + '\n');

      if ((i + 1) % CHECKPOINT_EVERY === 0) {
        console.log(`  💾 Checkpoint saved (${i + 1} processed)`);
      }

      // Extract individual reviews from HTML + merge Feefo API reviews
      const htmlReviews = extractIndividualReviews(html);
      // Match Feefo reviews by normalized title
      const titleNorm = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      const feefoReviews = [];
      for (const [product, reviews] of Object.entries(feefoByProduct)) {
        const productNorm = product.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        if (productNorm === titleNorm || productNorm.includes(titleNorm) || titleNorm.includes(productNorm)) {
          feefoReviews.push(...reviews);
        }
      }

      // Merge: HTML reviews first (more complete), then Feefo reviews not already present
      // Dedup by date+author (same person, same day = same review)
      const seen = new Set(htmlReviews.map(r => `${r.date}|${r.author}`));
      const merged = [...htmlReviews.map(r => ({ ...r, source: 'html' }))];
      for (const fr of feefoReviews) {
        const key = `${fr.date}|${fr.author}`;
        if (!seen.has(key)) {
          merged.push(fr);
          seen.add(key);
        }
      }

      if (merged.length > 0) {
        let reviewsData = {};
        try { reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf8')); } catch { /* first run */ }
        reviewsData[show.id] = {
          title: show.title,
          totalReviews: data.reviewCount,
          fetchedReviews: merged.length,
          lastFetched: new Date().toISOString().slice(0, 10),
          reviews: merged,
        };
        fs.writeFileSync(reviewsPath, JSON.stringify(reviewsData, null, 2) + '\n');
        const feefoNew = merged.length - htmlReviews.length;
        console.log(`  📝 ${merged.length} reviews saved (${htmlReviews.length} HTML${feefoNew > 0 ? ` + ${feefoNew} Feefo` : ''})`);
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
      const discovered = await batchDiscoverSlugs('londonboxoffice.co.uk', notFound);
      if (discovered.size === 0) {
        console.log(`\nAdd to LBO_OVERRIDES if slug is known:`);
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
