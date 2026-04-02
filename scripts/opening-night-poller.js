#!/usr/bin/env node
/**
 * Opening Night Review Poller
 *
 * Discovers reviews faster than SERP using 4 layers:
 *   1. Aggregators (BWW RR, Show Score, DTLI) — fastest, update within minutes
 *   2. RSS feeds (Variety, NYT, Guardian) — free, no API cost
 *   3. Direct site search (outlet search endpoints) — instant on publish
 *   4. SERP backup (Google via ScrapingBee/BrightData) — catches the rest
 *
 * Each poll cycle discovers new URLs, creates review files, and reports progress.
 * Designed to be called repeatedly by a CI workflow every 15 min on opening night.
 *
 * Usage:
 *   node scripts/opening-night-poller.js --show=show-id-2026
 *   node scripts/opening-night-poller.js --show=show-id-2026 --dry-run
 *   node scripts/opening-night-poller.js --show=show-id-2026 --skip-serp
 *   node scripts/opening-night-poller.js --show=show-id-2026 --skip-site-search
 *   node scripts/opening-night-poller.js --show=show-id-2026 --bww-roundup-url=https://www.broadwayworld.com/article/Review-Roundup-...
 *   node scripts/opening-night-poller.js --show=show-id-2026 --tb-review-url=https://www.talkinbroadway.com/page/world/giant2026.html
 *
 * Environment Variables:
 *   SCRAPINGBEE_API_KEY - For SERP + JS-rendered site search
 *   BRIGHTDATA_TOKEN    - SERP fallback
 */

const fs = require('fs');
const path = require('path');

// Reuse existing infrastructure
const {
  searchDTLI,
  searchShowScore,
  searchBWWRoundup,
  extractDTLIReviews,
  extractShowScoreReviews,
  extractBWWRoundupReviews,
  createReviewFile,
  loadShowData,
  gatherReviewsForShow,
} = require('./gather-reviews');

const { checkRSSFeeds } = require('./lib/rss-discovery');
const { searchOutletSites, SITE_SEARCH_ENDPOINTS } = require('./lib/site-search-discovery');
const { discoverCorrectUrl, OUTLET_DOMAINS } = require('./lib/url-discovery');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { isLondonMarket } = require('./lib/venue-classification');
const { normalizeOutlet } = require('./lib/review-normalization');
const { extractReviewsFromLBO } = require('./scrape-london-box-office-roundups');
const { extractReviews: extractTheatreReviews } = require('./scrape-theatre-reviews');
const { matchTitleToShow } = require('./lib/show-matching');
const { fetchPage, fetchJSON } = require('./lib/scraper');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');

// CLI args
const SHOW_ID = (process.argv.find(a => a.startsWith('--show=')) || '').replace('--show=', '');
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_SERP = process.argv.includes('--skip-serp');
const SKIP_SITE_SEARCH = process.argv.includes('--skip-site-search');
const VERBOSE = process.argv.includes('--verbose') || true; // Always verbose for CI logs
// Escape hatches: bypass SERP discovery when discovery fails (wrong Google result, unindexed page)
const BWW_ROUNDUP_URL = (process.argv.find(a => a.startsWith('--bww-roundup-url=')) || '').replace('--bww-roundup-url=', '') || '';
const TB_REVIEW_URL = (process.argv.find(a => a.startsWith('--tb-review-url=')) || '').replace('--tb-review-url=', '') || '';

// Readiness thresholds — market-aware (must match send-opening-night-broadcast.js)
function getThresholds(market) {
  const isWE = market === 'west-end' || market === 'off-west-end';
  return {
    MIN_REVIEWS: isWE ? 8 : 12,
    MIN_T1_REVIEWS: 3,
    MIN_T2_REVIEWS: isWE ? 2 : 3,
    MIN_HIGH_CONFIDENCE: isWE ? 6 : 8,
  };
}

/**
 * Get all known URLs for a show (from existing review-text files on disk)
 */
function getKnownUrls(showId) {
  const urls = new Set();
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return urls;

  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      if (data.url) urls.add(data.url);
      if (data.reviewUrl) urls.add(data.reviewUrl);
    } catch {}
  }
  return urls;
}

/**
 * Get found outlet IDs for a show (from existing review-text files)
 */
function getFoundOutletIds(showId) {
  const outletIds = new Set();
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return outletIds;

  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      // Skip wrongProduction/wrongShow files — they shouldn't block re-discovery
      if (data.wrongProduction || data.wrongShow) continue;
      if (data.outletId) outletIds.add(data.outletId.toLowerCase());
    } catch {}
  }
  return outletIds;
}

/**
 * Get T1/T2 outlets that haven't been found yet for a show
 */
function getMissingT1T2Outlets(showId, market) {
  const registry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;
  const foundIds = getFoundOutletIds(showId);

  const missing = [];
  for (const [outletId, outlet] of Object.entries(outlets)) {
    if (outlet.tier > 2) continue;
    if (foundIds.has(outletId.toLowerCase())) continue;
    // Market filter
    if (isLondonMarket(market) && !outlet.isDualMarket && outlet.region !== 'uk') continue;
    if (market === 'broadway' && outlet.region === 'uk' && !outlet.isDualMarket) continue;
    missing.push({ id: outletId, name: outlet.displayName || outletId, tier: outlet.tier, domain: outlet.domain, isDualMarket: !!outlet.isDualMarket });
  }

  return missing.sort((a, b) => a.tier - b.tier); // T1 first
}

/**
 * Check readiness for broadcast
 */
function checkReadiness(showId, market = 'broadway') {
  const { MIN_REVIEWS, MIN_T1_REVIEWS, MIN_T2_REVIEWS, MIN_HIGH_CONFIDENCE } = getThresholds(market);
  const reviews = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;
  const arr = Array.isArray(reviews.reviews || reviews) ? (reviews.reviews || reviews) : Object.values(reviews.reviews || reviews);

  const showRevs = arr.filter(r => r.showId === showId && r.assignedScore > 0);
  const t1 = showRevs.filter(r => { const o = outlets[r.outletId]; return o && o.tier === 1; }).length;
  const t2 = showRevs.filter(r => { const o = outlets[r.outletId]; return o && o.tier === 2; }).length;
  const hiConf = showRevs.filter(r => r.scoreConfidence === 'high' || r.scoreConfidence === 'medium').length;

  return {
    total: showRevs.length,
    t1,
    t2,
    highConfidence: hiConf,
    ready: showRevs.length >= MIN_REVIEWS && t1 >= MIN_T1_REVIEWS && t2 >= MIN_T2_REVIEWS && hiConf >= MIN_HIGH_CONFIDENCE,
    reasons: [
      showRevs.length < MIN_REVIEWS ? `${showRevs.length}/${MIN_REVIEWS} total` : null,
      t1 < MIN_T1_REVIEWS ? `T1:${t1}/${MIN_T1_REVIEWS}` : null,
      t2 < MIN_T2_REVIEWS ? `T2:${t2}/${MIN_T2_REVIEWS}` : null,
      hiConf < MIN_HIGH_CONFIDENCE ? `hi-conf:${hiConf}/${MIN_HIGH_CONFIDENCE}` : null,
    ].filter(Boolean),
  };
}

/**
 * Run Layer 1: Aggregators
 * Calls the existing aggregator functions from gather-reviews.js
 */
async function runAggregators(show) {
  console.log('\n[Layer 1] Aggregators...');
  const results = [];
  const year = new Date(show.openingDate).getFullYear();
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);

  // 1a. DTLI (Broadway/OB only — DTLI doesn't cover London)
  if (!isWestEnd) {
    try {
      console.log('  Checking DTLI...');
      const dtli = await searchDTLI(show);
      if (dtli && dtli.html) {
        const validation = await validatePageMatchesShow(dtli.html, show.title, {
          openingYear: year,
        });
        if (validation.valid) {
          const reviews = extractDTLIReviews(dtli.html, show.id, dtli.url);
          console.log(`  DTLI: ${reviews.length} reviews found`);
          results.push(...reviews);
        } else {
          console.log(`  DTLI: page mismatch — ${validation.reason}`);
        }
      } else {
        console.log('  DTLI: not found');
      }
    } catch (err) {
      console.log(`  DTLI error: ${err.message}`);
    }
  } else {
    console.log('  DTLI: skipped (London market — DTLI is US-only)');
  }

  // 1b. Show Score
  try {
    console.log('  Checking Show Score...');
    const ss = await searchShowScore(show);
    if (ss && ss.html) {
      const validation = await validatePageMatchesShow(ss.html, show.title, {
        openingYear: year,
      });
      if (validation.valid) {
        // Playwright-extracted reviews take priority
        if (ss.reviews && ss.reviews.length > 0) {
          console.log(`  Show Score: ${ss.reviews.length} reviews (Playwright): ${ss.reviews.map(r => r.outlet || 'unknown').join(', ')}`);
          for (const r of ss.reviews) {
            results.push({
              showId: show.id,
              outletId: r.outlet ? r.outlet.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'unknown',
              outlet: r.outlet || 'Unknown',
              criticName: r.critic || 'Unknown',
              url: r.url,
              excerpt: r.excerpt,
              publishDate: r.date,
              source: 'show-score',
            });
          }
        } else {
          const reviews = extractShowScoreReviews(ss.html, show.id);
          console.log(`  Show Score: ${reviews.length} reviews (HTML)`);
          results.push(...reviews);
        }
      } else {
        console.log(`  Show Score: page mismatch — ${validation.reason}`);
      }
    } else {
      console.log('  Show Score: not found');
    }
  } catch (err) {
    console.log(`  Show Score error: ${err.message}`);
  }

  // 1c. BWW Review Roundup (skip for off-Broadway; skip URL guessing for WE — BWW RR rare for WE)
  // For WE: only check if a manual --bww-roundup-url is provided (bypass discovery entirely)
  if (!isOffBroadway && (!isWestEnd || BWW_ROUNDUP_URL)) {
    try {
      console.log('  Checking BWW Review Roundup...');
      // Pass runtime override when SERP discovery fails (unindexed page, wrong Google result).
      // On opening night: use --bww-roundup-url=<url> to bypass discovery entirely.
      const bwwOptions = BWW_ROUNDUP_URL ? { overrideUrl: BWW_ROUNDUP_URL } : {};
      const bww = await searchBWWRoundup(show, year, bwwOptions);
      if (bww && bww.html) {
        const reviews = extractBWWRoundupReviews(bww.html, show.id, bww.url);
        console.log(`  BWW RR: ${reviews.length} reviews found`);
        results.push(...reviews);
      } else {
        console.log('  BWW RR: not found');
      }
    } catch (err) {
      console.log(`  BWW RR error: ${err.message}`);
    }
  }

  // 1c2. Talkin' Broadway direct URL (Broadway only, not off-Broadway)
  // SERP returns forum posts (All That Chat) for TB instead of the actual review.
  // TB URL pattern: https://www.talkinbroadway.com/page/world/{titleslug}{year}.html
  // Use --tb-review-url=<url> to override if constructed URL fails.
  if (!isOffBroadway && !isWestEnd) {
    try {
      // TB uses CamelCase slugs: "MeteorShower2017", "ADollsHouse", "OnceUponaOneMoreTime"
      // Articles (a, an, the) are lowercase in the middle but capitalized at start.
      // Year format varies: 4-digit (2017), 2-digit (24), or omitted entirely.
      const tbCamelSlug = show.title
        .replace(/[^a-zA-Z0-9\s]/g, '')  // strip punctuation
        .split(/\s+/)
        .map((w, i) => {
          const lower = w.toLowerCase();
          // Preserve Roman numerals (II, III, IV, V, VI, etc.) — strict pattern avoids
          // false matches on English words like "Did", "Ill", "Mid", "Mix", "Dim"
          if (/^(?:I{1,3}|IV|VI{0,3}|IX|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX)$/i.test(w)) return w.toUpperCase();
          // Lowercase articles/prepositions in middle position
          if (i > 0 && ['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for'].includes(lower)) {
            return lower;
          }
          return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        })
        .join('');
      const tbLowerSlug = show.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const tbYear2 = String(year).slice(-2);

      // Try multiple URL variants — TB is inconsistent about year format
      const tbUrls = TB_REVIEW_URL ? [TB_REVIEW_URL] : [
        `https://www.talkinbroadway.com/page/world/${tbCamelSlug}${year}.html`,
        `https://www.talkinbroadway.com/page/world/${tbCamelSlug}${tbYear2}.html`,
        `https://www.talkinbroadway.com/page/world/${tbCamelSlug}.html`,
        `https://www.talkinbroadway.com/page/world/${tbLowerSlug}${year}.html`,
      ];

      // Check if we already have a TB review file for this show
      const showReviewDir = path.join(REVIEW_TEXTS_DIR, show.id);
      let hasTbReview = false;
      if (fs.existsSync(showReviewDir)) {
        const files = fs.readdirSync(showReviewDir);
        hasTbReview = files.some(f => f.startsWith('talkinbroadway--'));
      }

      if (hasTbReview) {
        console.log('  Talkin\' Broadway: already have review file, skipping');
      } else {
        let tbFound = false;
        for (const tbUrl of tbUrls) {
          console.log(`  Checking Talkin' Broadway: ${tbUrl}`);
          try {
            const tbPage = await fetchPage(tbUrl, { renderJs: false });
            if (tbPage && tbPage.content && tbPage.content.length > 500) {
              console.log(`  Talkin' Broadway: URL confirmed — creating stub`);
              results.push({
                showId: show.id,
                outletId: 'talkinbroadway',
                outlet: "Talkin' Broadway",
                criticName: 'Unknown',
                url: tbUrl,
                source: TB_REVIEW_URL ? 'direct-url-override' : 'direct-url-construction',
              });
              tbFound = true;
              break;
            }
          } catch (e) {
            // Try next URL variant
          }
        }
        if (!tbFound) {
          console.log(`  Talkin' Broadway: all ${tbUrls.length} URL variants failed — review may not be published yet`);
        }
      }
    } catch (err) {
      console.log(`  Talkin' Broadway error: ${err.message}`);
    }
  }

  // 1d. London Box Office roundups (WE/OWE only)
  if (isWestEnd) {
    try {
      console.log('  Checking London Box Office roundup...');
      // Check curated URL map first
      const lboMapPath = path.join(DATA_DIR, 'lbo-roundup-urls.json');
      let lboUrl = null;
      try {
        const lboMap = JSON.parse(fs.readFileSync(lboMapPath, 'utf8'));
        lboUrl = (lboMap.shows || {})[show.id];
      } catch (e) {}

      // Also check archive
      const lboArchivePath = path.join(DATA_DIR, 'aggregator-archive', 'lbo-roundups', `${show.id}.html`);

      let lboHtml = null;
      if (lboUrl) {
        console.log(`    Curated URL: ${lboUrl}`);
        try {
          const lboResult = await fetchPage(lboUrl, { renderJs: false });
          lboHtml = lboResult?.content || null;
        } catch (e) {
          console.log(`    LBO fetch error: ${e.message}`);
        }
      } else if (fs.existsSync(lboArchivePath)) {
        console.log('    Using archived LBO page');
        lboHtml = fs.readFileSync(lboArchivePath, 'utf8');
      }

      // Fallback: live sitemap discovery (free, ~16 entries)
      if (!lboHtml) {
        try {
          let sitemapXml = null;
          try {
            const smResult = await fetchPage('https://www.londonboxoffice.co.uk/news-sitemap.xml', { renderJs: false });
            sitemapXml = smResult?.content || null;
          } catch (e) { /* sitemap fetch failed, continue */ }
          if (sitemapXml) {
            // Match show title words against review URL slugs
            // LBO uses both "review-round-up-{show}" and "{show}-review-{venue}" patterns
            const titleWords = show.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
            const reviewUrls = [...sitemapXml.matchAll(/<loc>(https:\/\/www\.londonboxoffice\.co\.uk\/news\/post\/[^<]*review[^<]*)<\/loc>/gi)]
              .map(m => m[1])
              .filter(url => {
                const slug = url.split('/').pop().toLowerCase();
                // Exclude non-review pages (photos, cast announcements, etc.)
                return slug.includes('review') && !slug.includes('photo') && !slug.includes('cast-announced') && !slug.includes('announces');
              });
            const match = reviewUrls.find(url => {
              const slug = url.split('/').pop().toLowerCase();
              return titleWords.filter(w => slug.includes(w)).length >= Math.min(titleWords.length, 2);
            });
            if (match) {
              console.log(`    Sitemap match: ${match}`);
              try {
                const matchResult = await fetchPage(match, { renderJs: false });
                lboHtml = matchResult?.content || null;
              } catch (e) { /* page fetch failed */ }
              // Cache to archive
              if (lboHtml) {
                const archDir = path.dirname(lboArchivePath);
                if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
                fs.writeFileSync(lboArchivePath, lboHtml);
              }
            }
          }
        } catch (e) {
          console.log(`    LBO sitemap fallback error: ${(e.message || '').substring(0, 60)}`);
        }
      }

      if (lboHtml) {
        const lboReviews = extractReviewsFromLBO(lboHtml, show.id);
        console.log(`  LBO: ${lboReviews.length} reviews found`);
        for (const r of lboReviews) {
          results.push({
            showId: show.id,
            outletId: r.outletId || r.outlet?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown',
            outlet: r.outlet || 'Unknown',
            criticName: r.critic || 'Unknown',
            url: r.url || '',
            excerpt: r.excerpt || '',
            score: r.score,
            scoreSource: r.score !== null ? 'lbo-star-rating' : undefined,
            source: 'lbo-roundup',
          });
        }
      } else {
        console.log('  LBO: no roundup found');
      }
    } catch (err) {
      console.log(`  LBO error: ${err.message}`);
    }
  }

  // 1e. theatre.reviews roundups (WE/OWE only — best structured WE aggregator)
  if (isWestEnd) {
    try {
      console.log('  Checking theatre.reviews...');
      // Try direct URL construction: reviews-roundup/{title-slug}-reviews
      const titleSlug = show.title.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      const trUrls = [
        `https://theatre.reviews/reviews-roundup/${titleSlug}-reviews/`,
      ];
      // Also try with venue suffix if we have venue info
      if (show.venue) {
        const venueSlug = show.venue.toLowerCase()
          .replace(/\s*theatre\s*/gi, '').replace(/\s*theater\s*/gi, '')
          .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
        if (venueSlug) {
          trUrls.unshift(`https://theatre.reviews/reviews-roundup/${titleSlug}-${venueSlug}-reviews/`);
        }
      }

      let trHtml = null;
      // Try direct URL construction via proxy (avoids TLS fingerprint blocking in CI)
      for (const trUrl of trUrls) {
        try {
          const result = await fetchPage(trUrl, { renderJs: false });
          // Check content is the actual roundup page — must contain ⭑ star ratings
          // AND a key word from the show title (not just generic site chrome)
          const titleWord = show.title.split(/\s+/).filter(w => w.length > 3)[0] || show.title;
          if (result && result.content && result.content.length > 1000 &&
              result.content.includes('⭑') &&
              result.content.toLowerCase().includes(titleWord.toLowerCase())) {
            trHtml = result.content;
            console.log(`    Found at: ${trUrl} (via ${result.source})`);
            break;
          }
        } catch (e) {
          // 404/403 are expected for guessed URLs — continue to next variation
        }
      }

      // Fallback: WP API search when URL construction misses
      if (!trHtml) {
        try {
          const searchTitle = show.title.replace(/['"']/g, '');
          const wpApiUrl = `https://theatre.reviews/wp-json/wp/v2/posts?per_page=5&search=${encodeURIComponent(searchTitle)}`;
          const posts = await fetchJSON(wpApiUrl);
          if (posts && Array.isArray(posts)) {
            const roundup = posts.find(p => p.link && p.link.includes('/reviews-roundup/'));
            if (roundup) {
              console.log(`    WP API found: ${roundup.link}`);
              const pageResult = await fetchPage(roundup.link, { renderJs: false });
              if (pageResult && pageResult.content && pageResult.content.length > 1000) {
                trHtml = pageResult.content;
              }
            }
          }
        } catch (e) {
          console.log(`    TR WP API fallback error: ${(e.message || '').substring(0, 60)}`);
        }
      }

      if (trHtml) {
        // Cache to archive for future runs
        const archivePath = path.join(DATA_DIR, 'aggregator-archive', 'theatre-reviews', `${show.id}.html`);
        if (!fs.existsSync(path.dirname(archivePath))) fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.writeFileSync(archivePath, trHtml);

        const trReviews = extractTheatreReviews(trHtml, show.id);
        console.log(`  theatre.reviews: ${trReviews.length} reviews found`);
        for (const r of trReviews) {
          results.push({
            showId: show.id,
            outletId: r.outletId || 'unknown',
            outlet: r.outlet || 'Unknown',
            criticName: r.critic || 'Unknown',
            url: r.url || '',
            excerpt: r.excerpt || '',
            // TR rates shows independently — don't use as outlet's score
            theatreReviewsStars: r.stars ? `${r.stars}/${r.starsOutOf || 5}` : undefined,
            source: 'theatre-reviews',
          });
        }
      } else {
        console.log('  theatre.reviews: no roundup found');
      }
    } catch (err) {
      console.log(`  theatre.reviews error: ${err.message}`);
    }
  }

  // 1f. Stagedoor critic reviews (WE/OWE only — needs archive, can't fetch live due to Cloudflare)
  if (isWestEnd) {
    try {
      console.log('  Checking Stagedoor archive...');
      const sdArchivePath = path.join(DATA_DIR, 'aggregator-archive', 'stagedoor', `${show.id}.json`);
      if (fs.existsSync(sdArchivePath)) {
        const sdData = JSON.parse(fs.readFileSync(sdArchivePath, 'utf8'));
        const sdReviews = sdData.criticReviews || [];
        console.log(`  Stagedoor: ${sdReviews.length} reviews from archive`);
        for (const r of sdReviews) {
          results.push({
            showId: show.id,
            outletId: normalizeOutlet(r.outlet || ''),
            outlet: r.outlet || 'Unknown',
            criticName: 'Unknown', // Stagedoor doesn't provide critic names
            url: '',
            excerpt: r.excerpt || '',
            score: r.stars ? Math.round((r.stars / 5) * 100) : null,
            scoreSource: r.stars ? 'stagedoor-star-rating' : undefined,
            source: 'stagedoor',
          });
        }
      } else {
        console.log('  Stagedoor: no archive found');
      }
    } catch (err) {
      console.log(`  Stagedoor error: ${err.message}`);
    }
  }

  // 1g. WestEndTheatre.com roundups (WE/OWE only — WP API + rendered page fallback)
  if (isWestEnd) {
    try {
      console.log('  Checking WestEndTheatre.com (WP API)...');
      const cheerioWet = require('cheerio');
      const searchTitle = show.title.replace(/['"'\u2018\u2019]/g, '');
      const apiUrl = `https://www.westendtheatre.com/wp-json/wp/v2/posts?categories=10&per_page=20&search=${encodeURIComponent(searchTitle)}`;

      // Use fetchJSON for proxy-routed WP API call (avoids TLS blocking in CI)
      let posts = [];
      try {
        posts = await fetchJSON(apiUrl);
        if (!Array.isArray(posts)) posts = [];
      } catch (e) {
        console.log(`    WET API error: ${(e.message || '').substring(0, 60)}`);
      }

      if (Array.isArray(posts) && posts.length > 0) {
        for (const post of posts.slice(0, 3)) {
          // Validate post title matches our show (WP search can return wrong shows)
          const wpTitle = (post.title?.rendered || '').replace(/&#8217;/g, "'").replace(/&#8211;/g, '\u2013').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '');
          const normalizeForMatch = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
          const wpNorm = normalizeForMatch(wpTitle);
          const showNorm = normalizeForMatch(searchTitle);
          const showWords = showNorm.split(' ').filter(w => w.length > 2);
          const matchedWords = showWords.filter(w => wpNorm.includes(w));
          const minMatch = showWords.length <= 2 ? showWords.length : Math.ceil(showWords.length * 0.6);
          if (matchedWords.length < minMatch) {
            console.log(`    ✗ WET title mismatch: "${wpTitle.slice(0, 60)}" doesn't match "${searchTitle}"`);
            continue;
          }

          const htmlContent = post.content?.rendered || '';
          let wetReviews = [];

          // Try table format first (API content)
          if (htmlContent.includes('★') || htmlContent.includes('<table')) {
            const text = htmlContent.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ');
            const starRegex = /(★{1,5})/g;
            let sMatch;
            while ((sMatch = starRegex.exec(text)) !== null) {
              const stars = sMatch[1].length;
              const before = text.substring(Math.max(0, sMatch.index - 200), sMatch.index).trim();
              const outletLine = before.split('\n').filter(l => l.trim()).pop()?.trim() || '';
              if (!outletLine || outletLine.length < 2 || outletLine.length > 50) continue;
              if (outletLine.startsWith('"') || outletLine.startsWith('\u201c')) continue;
              // Skip table headers parsed as outlet names
              if (/publication|rating|critic/i.test(outletLine)) continue;
              wetReviews.push({ outlet: outletLine, stars, critic: 'Unknown' });
            }
          }

          // Fallback: fetch rendered page for section-format posts (CSS classes)
          if (wetReviews.length === 0 && post.link) {
            try {
              console.log(`    Fetching rendered page: ${post.link}`);
              const pageResult = await fetchPage(post.link, { renderJs: false });
              const pageHtml = pageResult?.content || null;
              if (pageHtml) {
                const $w = cheerioWet.load(pageHtml);
                $w('.reviewnewpubhead').each((_, el) => {
                  const outlet = $w(el).text().trim();
                  const stars = ($w(el).next('.reviewnewstars').text().match(/★/g) || []).length;
                  const authorText = $w(el).nextAll('.reviewnewauthor').first().text().trim();
                  const cm = authorText.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z'-]+)+)/);
                  // Extract individual review URL from the <a> after this review block
                  let reviewUrl = '';
                  $w(el).nextAll('a').each((_, a) => {
                    const href = $w(a).attr('href') || '';
                    if (!reviewUrl && href.startsWith('http') && !href.includes('westendtheatre.com')) {
                      reviewUrl = href;
                    }
                  });
                  if (outlet && stars > 0) {
                    wetReviews.push({ outlet, stars, critic: cm ? cm[1] : 'Unknown', url: reviewUrl });
                  }
                });
              }
            } catch (e) {
              console.log(`    WET page fetch error: ${(e.message || '').substring(0, 60)}`);
            }
          }

          if (wetReviews.length === 0) continue;

          console.log(`  WestEndTheatre: ${wetReviews.length} ratings found`);

          // Archive
          const wetArchiveDir = path.join(DATA_DIR, 'aggregator-archive', 'westendtheatre');
          if (!fs.existsSync(wetArchiveDir)) fs.mkdirSync(wetArchiveDir, { recursive: true });
          fs.writeFileSync(path.join(wetArchiveDir, `${show.id}.json`),
            JSON.stringify({ ourShowId: show.id, wpPostId: post.id, fetchedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');

          for (const r of wetReviews) {
            // Validate URL date: extract date from URL slug and reject if >60 days before opening
            let urlDate = null;
            if (r.url) {
              // Common UK URL date patterns: /2026/mar/26/ or /2026-03-26/ or /2026/03/26/
              const dateMatch = r.url.match(/\/(\d{4})\/(\w{3}|\d{2})\/(\d{1,2})\//);
              if (dateMatch) {
                const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
                const y = parseInt(dateMatch[1]);
                const m = months[dateMatch[2].toLowerCase()] ?? (parseInt(dateMatch[2]) - 1);
                const d = parseInt(dateMatch[3]);
                if (!isNaN(y) && !isNaN(m) && !isNaN(d)) urlDate = new Date(y, m, d);
              }
            }
            const openingMs = show.openingDate ? new Date(show.openingDate).getTime() : null;
            if (urlDate && openingMs && (openingMs - urlDate.getTime()) > 60 * 86400000) {
              console.log(`    ✗ Rejecting ${r.outlet} URL: date ${urlDate.toISOString().slice(0,10)} is >60 days before opening ${show.openingDate}`);
              // Clear the bad URL so it falls back to the roundup post link
              r.url = '';
            }
            results.push({
              showId: show.id,
              outletId: normalizeOutlet(r.outlet),
              outlet: r.outlet,
              criticName: r.critic,
              url: r.url || post.link || '',
              excerpt: '',
              // WET rates shows independently — don't use as outlet's score
              wetStars: r.stars ? `${r.stars}/5` : undefined,
              source: 'westendtheatre',
              // Pass roundup post date so createReviewFile can validate against opening date
              publishDate: post.date ? post.date.slice(0, 10) : undefined,
            });
          }
          break;
        }
      } else {
        console.log(`  WestEndTheatre: no matching roundup (API returned ${Array.isArray(posts) ? posts.length + ' posts' : typeof posts})`);
      }
    } catch (err) {
      console.log(`  WestEndTheatre error: ${err.message}`);
    }
  }

  // 1h. The Stage roundups (WE/OWE only — archive first, live fetch via BrowserBase if available)
  if (isWestEnd) {
    try {
      console.log('  Checking The Stage...');
      const { extractReviews: extractStageReviews } = require('./scrape-thestage-roundups');
      const tsArchiveDir = path.join(DATA_DIR, 'aggregator-archive', 'thestage-roundups');
      const tsArchivePath = path.join(tsArchiveDir, `${show.id}.html`);
      let tsHtml = null;

      // Try archive first
      if (fs.existsSync(tsArchivePath)) {
        tsHtml = fs.readFileSync(tsArchivePath, 'utf8');
        console.log('  The Stage: found archive');
      }

      // Live fetch via BrowserBase if no archive and cookies are present
      const { loadCookiesForDomain: loadStageCookies } = require('./lib/cookie-loader');
      const stageCookies = loadStageCookies('thestage.co.uk');
      if (!tsHtml && process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID
          && stageCookies) {
        console.log('  The Stage: no archive — attempting live fetch via BrowserBase (cookie auth)...');
        try {
          const { chromium } = require('playwright');
          const https = require('https');

          // Create BrowserBase session
          const bbApiKey = process.env.BROWSERBASE_API_KEY;
          const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;
          const sessionBody = JSON.stringify({
            projectId: bbProjectId,
            browserSettings: { solveCaptchas: true },
          });
          const session = await new Promise((resolve, reject) => {
            const req = https.request('https://www.browserbase.com/v1/sessions', {
              method: 'POST',
              headers: { 'x-bb-api-key': bbApiKey, 'Content-Type': 'application/json' },
            }, (res) => {
              let d = '';
              res.on('data', c => d += c);
              res.on('end', () => {
                try { resolve(JSON.parse(d)); }
                catch (e) { reject(new Error(`BrowserBase API returned non-JSON: ${d.slice(0, 200)}`)); }
              });
            });
            req.on('error', reject);
            req.end(sessionBody);
          });

          if (!session || !session.id) {
            throw new Error(`BrowserBase session creation failed: ${JSON.stringify(session).slice(0, 200)}`);
          }

          const connectUrl = `wss://connect.browserbase.com?apiKey=${bbApiKey}&sessionId=${session.id}`;
          const browser = await chromium.connectOverCDP(connectUrl);
          try {
            const context = browser.contexts()[0] || await browser.newContext();
            const page = context.pages()[0] || await context.newPage();

            // Inject cookies instead of logging in (avoids creating new sessions)
            const pwCookies = stageCookies.map(c => ({
              name: c.name, value: c.value,
              domain: c.domain || '.thestage.co.uk',
              path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
              ...(c.sameSite ? { sameSite: c.sameSite } : {}),
            }));
            await context.addCookies(pwCookies);
            console.log('  The Stage: cookies injected');

            // Navigate to listing and discover the roundup URL for this show
            // Stage URLs are unpredictable (include venue, creative team) — must discover, not construct
            await page.goto('https://www.thestage.co.uk/review-round-ups/review-round-ups', {
              waitUntil: 'networkidle', timeout: 30000,
            });
            await page.waitForTimeout(3000);

            // Extract all roundup links and find one matching our show title
            // Uses matchTitleToShow (same fuzzy matching as weekly scraper) for robustness
            const allLinks = await page.$$eval('a[href*="/review-round-ups/"]', (anchors) => {
              return anchors.map(a => ({
                href: a.href,
                text: a.textContent.trim(),
              })).filter(l =>
                l.href.includes('-review-round-up') &&
                !l.href.endsWith('/review-round-ups') &&
                !l.href.includes('/review-round-ups/review-round-ups')
              );
            });

            let roundupUrl = null;
            for (const link of allLinks) {
              // Try matching link text against our show
              const textMatch = matchTitleToShow(link.text, [show], { market: 'west-end' });
              if (textMatch && textMatch.show) {
                roundupUrl = link.href;
                break;
              }
              // Also try extracting title from URL slug (strips venue info like the weekly scraper)
              const slug = link.href.match(/review-round-ups\/(.+?)(?:-review-round-up)?\/?$/)?.[1] || '';
              const slugTitle = slug
                .replace(/-review-round-up$/, '')
                .replace(/-at-the-.*$/, '').replace(/-at-.*$/, '')
                .split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              if (slugTitle) {
                const slugMatch = matchTitleToShow(slugTitle, [show], { market: 'west-end' });
                if (slugMatch && slugMatch.show) {
                  roundupUrl = link.href;
                  break;
                }
              }
            }

            if (!roundupUrl) {
              console.log(`  The Stage: no matching roundup found on listing page (${allLinks.length} links checked)`);
            } else {
              console.log(`  The Stage: found roundup → ${roundupUrl}`);

              // Step 3: Fetch the roundup page
              await page.goto(roundupUrl, { waitUntil: 'networkidle', timeout: 30000 });
              await page.waitForTimeout(3000);

              tsHtml = await page.content();

              // Guard: don't archive paywalled/truncated content
              // Real roundups have star ratings (★ or *) in the content
              const hasStars = tsHtml && (tsHtml.includes('★') || /\*{2,5}/.test(tsHtml));
              const hasPaywall = tsHtml && (tsHtml.includes('create a free account') || tsHtml.includes('Subscribe to continue'));

              if (tsHtml && hasStars && !hasPaywall && tsHtml.length > 2000) {
                if (!fs.existsSync(tsArchiveDir)) fs.mkdirSync(tsArchiveDir, { recursive: true });
                fs.writeFileSync(tsArchivePath, tsHtml);
                console.log('  The Stage: live fetch successful, archived');
              } else if (hasPaywall) {
                console.log('  The Stage: page is paywalled (login may have failed), skipping archive');
                tsHtml = null;
              } else {
                console.log(`  The Stage: content looks incomplete (stars=${!!hasStars}, len=${tsHtml?.length || 0}), skipping archive`);
                tsHtml = null;
              }
            }
          } finally {
            await browser.close().catch(() => {});
          }
        } catch (fetchErr) {
          console.log(`  The Stage live fetch error: ${fetchErr.message}`);
        }
      } else if (!tsHtml) {
        const missing = [];
        if (!process.env.BROWSERBASE_API_KEY) missing.push('BROWSERBASE_API_KEY');
        if (!process.env.BROWSERBASE_PROJECT_ID) missing.push('BROWSERBASE_PROJECT_ID');
        if (!stageCookies) missing.push('THESTAGE_COOKIES (no cookies in bundle/env/file)');
        console.log(`  The Stage: no archive, live fetch skipped (missing: ${missing.join(', ')})`);
      }

      // Extract reviews from HTML (archive or live-fetched)
      if (tsHtml) {
        const tsReviews = extractStageReviews(tsHtml, show.id);
        console.log(`  The Stage: ${tsReviews.length} reviews extracted`);
        for (const r of tsReviews) {
          results.push({
            showId: show.id,
            outletId: r.outletId || normalizeOutlet(r.outlet || ''),
            outlet: r.outlet || 'Unknown',
            criticName: r.critic || 'Unknown',
            url: r.url || '',
            excerpt: r.excerpt || '',
            score: r.stars ? Math.round((r.stars / 5) * 100) : null,
            scoreSource: r.stars ? 'thestage-roundup-star-rating' : undefined,
            source: 'thestage-roundup',
          });
        }
      }
    } catch (err) {
      console.log(`  The Stage error: ${err.message}`);
    }
  }

  console.log(`  [Layer 1 Total] ${results.length} reviews from aggregators`);
  return results;
}

/**
 * Run Layer 2: RSS Feeds
 * @param {string} showTitle
 * @param {Set} knownUrls
 * @param {string} [openingDate] - Show's opening date (YYYY-MM-DD). Enables date-window
 *   filtering on narrow theater feeds instead of title matching.
 */
async function runRSSFeeds(showTitle, knownUrls, openingDate = null, market = 'broadway') {
  console.log('\n[Layer 2] RSS Feeds...');
  try {
    const results = await checkRSSFeeds(showTitle, {
      maxHoursAgo: 72,
      knownUrls,
      verbose: true,
      openingDate,
      market,
    });
    console.log(`  [Layer 2 Total] ${results.length} reviews from RSS`);
    return results;
  } catch (err) {
    console.log(`  RSS error: ${err.message}`);
    return [];
  }
}

/**
 * Run Layer 3: Direct Site Search
 * @param {string} showTitle
 * @param {string[]} missingOutletIds
 * @param {Set} knownUrls
 * @param {string} [market]
 * @param {string} [openingDate] - Show's opening date. Passed to date-aware endpoints (e.g. TheaterMania).
 */
async function runSiteSearch(showTitle, missingOutletIds, knownUrls, market = 'broadway', openingDate = null) {
  console.log('\n[Layer 3] Site Search...');

  // Only search outlets that have site-search configs AND are missing
  const searchable = missingOutletIds.filter(id => SITE_SEARCH_ENDPOINTS[id]);
  if (searchable.length === 0) {
    console.log('  No searchable outlets missing');
    return [];
  }

  console.log(`  Searching ${searchable.length} outlets: ${searchable.join(', ')}`);

  try {
    const results = await searchOutletSites(showTitle, searchable, {
      knownUrls,
      verbose: true,
      skipJs: !process.env.SCRAPINGBEE_API_KEY, // Skip JS-rendered if no API key
      market,
      openingDate,
    });
    console.log(`  [Layer 3 Total] ${results.length} reviews from site search`);
    return results;
  } catch (err) {
    console.log(`  Site search error: ${err.message}`);
    return [];
  }
}

/**
 * Run Layer 4: SERP Backup
 */
async function runSERPBackup(show, missingOutlets, knownUrls) {
  console.log('\n[Layer 4] SERP Backup...');

  if (!process.env.SCRAPINGBEE_API_KEY && !process.env.BRIGHTDATA_TOKEN) {
    console.log('  Skipped: no SERP API keys');
    return [];
  }

  const results = [];
  const SERP_BUDGET = 30; // Conservative per-cycle budget
  let calls = 0;

  for (const outlet of missingOutlets) {
    if (calls >= SERP_BUDGET) {
      console.log(`  SERP budget exhausted (${SERP_BUDGET} calls)`);
      break;
    }
    if (!outlet.domain) continue;

    try {
      process.stdout.write(`  ${outlet.name}... `);
      calls++;

      const reviewObj = {
        showId: show.id,
        outletId: outlet.id,
        outlet: outlet.name,
        criticName: 'Unknown',
        url: '',
      };
      const result = await discoverCorrectUrl(
        reviewObj,
        process.env.SCRAPINGBEE_API_KEY || '',
        {
          brightDataKey: process.env.BRIGHTDATA_TOKEN || '',
          preferSpeed: true, // Opening night — latency matters
        }
      );

      const url = (result && result !== '__SERP_UNAVAILABLE__') ? result : null;
      if (url && !knownUrls.has(url)) {
        console.log('found');
        results.push({
          showId: show.id,
          outletId: outlet.id,
          outlet: outlet.name,
          criticName: 'Unknown',
          url,
          source: 'serp-discovery',
        });
      } else {
        console.log(url ? 'already known' : 'not found');
      }
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
  }

  console.log(`  [Layer 4 Total] ${results.length} reviews from SERP (${calls} calls)`);
  return results;
}

/**
 * Create review files for newly discovered reviews.
 * Handles dedup against existing files.
 */
function processDiscoveredReviews(showId, reviews, knownUrls, options = {}) {
  const { allowOffBroadway = false, allowWestEnd = false } = options;
  let created = 0;
  let skipped = 0;
  let rejected = 0;

  for (const review of reviews) {
    // Skip if URL already known
    if (review.url && knownUrls.has(review.url)) {
      skipped++;
      continue;
    }

    // Skip BWW excerpt-only reviews (no URL) — they need special handling
    if (!review.url && review.bwwExcerpt) {
      continue; // BWW excerpt merge is handled by gatherReviewsForShow
    }

    if (!review.url) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would create: ${review.outletId || review.outlet} — ${review.url}`);
      created++;
      continue;
    }

    const result = createReviewFile(showId, review, { allowOffBroadway, allowWestEnd });
    if (result === true) {
      created++;
      knownUrls.add(review.url);
    } else if (typeof result === 'string') {
      rejected++;
    } else {
      skipped++; // Already exists
    }
  }

  return { created, skipped, rejected };
}

/**
 * Main poll cycle
 */
async function pollCycle() {
  if (!SHOW_ID) {
    console.error('Usage: node scripts/opening-night-poller.js --show=SHOW_ID');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     Opening Night Review Poller              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Show: ${SHOW_ID}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  // Load show data
  const show = loadShowData(SHOW_ID);
  if (!show) {
    console.error(`Show not found: ${SHOW_ID}`);
    process.exit(1);
  }

  const market = isLondonMarket(show.category) ? 'west-end' : 'broadway';
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);
  console.log(`Title: ${show.title}`);
  console.log(`Market: ${market}`);

  // Pre-poll state
  const knownUrls = getKnownUrls(SHOW_ID);
  const preStatus = checkReadiness(SHOW_ID, market);
  console.log(`\nPre-poll: ${preStatus.total} scored reviews (T1:${preStatus.t1} T2:${preStatus.t2} hi-conf:${preStatus.highConfidence})`);
  if (preStatus.ready) {
    console.log('Show is ALREADY broadcast-ready!');
  }

  // ── Layer 1: Aggregators ──
  const aggResults = await runAggregators(show);

  // ── Layer 2: RSS ──
  const rssResults = await runRSSFeeds(show.title, knownUrls, show.openingDate || null, market);

  // ── Layer 3: Site Search ──
  let siteSearchResults = [];
  if (!SKIP_SITE_SEARCH) {
    const foundOutletIds = getFoundOutletIds(SHOW_ID);
    // Add outlets found in layers 1-2
    for (const r of [...aggResults, ...rssResults]) {
      if (r.outletId) foundOutletIds.add(r.outletId.toLowerCase());
    }
    const missingIds = getMissingT1T2Outlets(SHOW_ID, market)
      .map(o => o.id)
      .filter(id => !foundOutletIds.has(id.toLowerCase()));
    siteSearchResults = await runSiteSearch(show.title, missingIds, knownUrls, market, show.openingDate || null);
  } else {
    console.log('\n[Layer 3] Site Search... SKIPPED (--skip-site-search)');
  }

  // ── Layer 4: SERP ──
  let serpResults = [];
  if (!SKIP_SERP) {
    const foundOutletIds = getFoundOutletIds(SHOW_ID);
    for (const r of [...aggResults, ...rssResults, ...siteSearchResults]) {
      if (r.outletId) foundOutletIds.add(r.outletId.toLowerCase());
    }
    let missingOutlets = getMissingT1T2Outlets(SHOW_ID, market)
      .filter(o => !foundOutletIds.has(o.id.toLowerCase()));
    // For WE shows on day 1+: also search notable T3 WE outlets
    // Skip first 24h (opening night) — T3 outlets haven't published yet and SERP adds ~90s
    const daysSinceOpening = show.openingDate
      ? (Date.now() - new Date(show.openingDate).getTime()) / 86400000
      : 999;
    if (isLondonMarket(market) && daysSinceOpening < 1) {
      console.log(`  [T3 SERP skipped: opening night (${daysSinceOpening.toFixed(1)} days). T3 outlets added after 24h]`);
    }
    if (isLondonMarket(market) && daysSinceOpening >= 1) {
      // Notable T3 WE outlets that regularly review shows and have searchable domains
      // ~18 outlets × 5s each = ~90s extra SERP time per show, acceptable for day 2+ polls
      const WE_T3_SERP_OUTLETS = [
        'new-statesman', 'afridiziak-theatre-news', 'theatreandtonic',
        'west-end-best-friend', 'all-that-dazzles-uk',
        'london-box-office', 'artsdesk', 'theatre-weekly', 'theupcoming',
        'musical-theatre-review', 'british-theatre', 'everything-theatre',
        'londonist', 'thereviewshub', 'city-am', 'a-younger-theatre',
        'west-end-wilma', 'digital-spy', 'monstagigz',
        'radio-times', 'attitude', 'metro-uk', 'lost-in-theatreland',
        'the-spectator-uk', 'shy-strange-manic',
      ];
      const reg = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
      const allOutlets = reg.outlets || reg;
      for (const t3Id of WE_T3_SERP_OUTLETS) {
        if (foundOutletIds.has(t3Id.toLowerCase())) continue;
        const outlet = allOutlets[t3Id];
        if (outlet) {
          missingOutlets.push({ id: t3Id, name: outlet.displayName || t3Id, tier: outlet.tier, domain: outlet.domain });
        }
      }
      // Sort: UK T1/T2 first, then UK T3, then dual-market US
      const ukOutlets = missingOutlets.filter(o => {
        const outlet = allOutlets[o.id];
        return outlet && (outlet.region === 'london' || outlet.region === 'uk');
      });
      const rest = missingOutlets.filter(o => !ukOutlets.find(u => u.id === o.id));
      missingOutlets = [...ukOutlets, ...rest];
    }
    if (missingOutlets.length > 0) {
      serpResults = await runSERPBackup(show, missingOutlets, knownUrls);
    } else {
      console.log('\n[Layer 4] SERP Backup... all T1/T2 outlets found');
    }
  } else {
    console.log('\n[Layer 4] SERP Backup... SKIPPED (--skip-serp)');
  }

  // ── Process discovered reviews ──
  const allDiscovered = [...aggResults, ...rssResults, ...siteSearchResults, ...serpResults];
  console.log(`\n━━━ Processing ${allDiscovered.length} discovered reviews ━━━`);

  const { created, skipped, rejected } = processDiscoveredReviews(
    SHOW_ID,
    allDiscovered,
    knownUrls,
    { allowOffBroadway: isOffBroadway, allowWestEnd: isWestEnd }
  );

  // ── Post-poll status ──
  const postStatus = checkReadiness(SHOW_ID, market);
  const newReviews = postStatus.total - preStatus.total;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  POLL CYCLE RESULTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Discovered: ${allDiscovered.length} (agg:${aggResults.length} rss:${rssResults.length} site:${siteSearchResults.length} serp:${serpResults.length})`);
  console.log(`  Files created: ${created} | Skipped: ${skipped} | Rejected: ${rejected}`);
  console.log(`  Scored reviews: ${preStatus.total} → ${postStatus.total} (+${newReviews})`);
  console.log(`  T1: ${postStatus.t1} | T2: ${postStatus.t2} | Hi-conf: ${postStatus.highConfidence}`);

  if (postStatus.ready) {
    console.log('  Status: BROADCAST READY ✅');
  } else {
    console.log(`  Status: NOT READY — ${postStatus.reasons.join(', ')}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Zero-review alert: warn if show has been open >24h with very few reviews
  if (show.openingDate) {
    const hoursSinceOpening = (Date.now() - new Date(show.openingDate).getTime()) / 3600000;
    if (hoursSinceOpening > 24 && postStatus.total < 3) {
      const msg = `⚠️ LOW COVERAGE: ${show.title} opened ${Math.round(hoursSinceOpening)}h ago but only has ${postStatus.total} scored reviews. Expected 8+ by now.`;
      console.log(`\n${msg}`);
      // Emit as GitHub Actions warning annotation
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::warning::${msg}`);
      }
    }
  }

  // GitHub Actions outputs
  console.log(`\n::set-output name=ready::${postStatus.ready}`);
  console.log(`::set-output name=new_reviews::${newReviews}`);
  console.log(`::set-output name=total_scored::${postStatus.total}`);
  console.log(`::set-output name=t1_count::${postStatus.t1}`);
  console.log(`::set-output name=t2_count::${postStatus.t2}`);
  console.log(`::set-output name=files_created::${created}`);

  // Also write to GITHUB_OUTPUT if available
  if (process.env.GITHUB_OUTPUT) {
    const outputLines = [
      `ready=${postStatus.ready}`,
      `new_reviews=${newReviews}`,
      `total_scored=${postStatus.total}`,
      `t1_count=${postStatus.t1}`,
      `t2_count=${postStatus.t2}`,
      `files_created=${created}`,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, outputLines + '\n');
  }
}

if (require.main === module) {
  pollCycle().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { pollCycle, checkReadiness, getMissingT1T2Outlets, getThresholds };
