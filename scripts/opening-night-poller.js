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
    missing.push({ id: outletId, name: outlet.displayName || outletId, tier: outlet.tier, domain: outlet.domain });
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
          console.log(`  Show Score: ${ss.reviews.length} reviews (Playwright)`);
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

  // 1c. BWW Review Roundup (skip for off-Broadway)
  if (!isOffBroadway) {
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
      const tbSlug = show.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const tbYear = year;
      const tbConstructedUrl = `https://www.talkinbroadway.com/page/world/${tbSlug}${tbYear}.html`;
      const tbUrl = TB_REVIEW_URL || tbConstructedUrl;

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
        console.log(`  Checking Talkin' Broadway: ${tbUrl}`);
        // Try plain HTTPS first — TB serves HTML on direct article URLs
        const tbResult = await new Promise((resolve) => {
          const req = require('https').get(tbUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Broadway Scorecard/1.0)' }
          }, res => {
            if (res.statusCode === 200 || res.statusCode === 301) {
              resolve({ ok: true, status: res.statusCode });
            } else {
              resolve({ ok: false, status: res.statusCode });
            }
            res.resume();
          });
          req.on('error', () => resolve({ ok: false, status: 0 }));
          req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
        });

        if (tbResult.ok) {
          console.log(`  Talkin' Broadway: URL confirmed (${tbResult.status}) — creating stub`);
          results.push({
            showId: show.id,
            outletId: 'talkinbroadway',
            outlet: "Talkin' Broadway",
            criticName: 'Unknown',
            url: tbUrl,
            source: 'direct-url-construction',
          });
        } else if (TB_REVIEW_URL) {
          // User provided override URL — create stub even if check failed (may be behind Cloudflare)
          console.log(`  Talkin' Broadway: status ${tbResult.status} on override URL — creating stub anyway`);
          results.push({
            showId: show.id,
            outletId: 'talkinbroadway',
            outlet: "Talkin' Broadway",
            criticName: 'Unknown',
            url: TB_REVIEW_URL,
            source: 'direct-url-override',
          });
        } else {
          console.log(`  Talkin' Broadway: ${tbResult.status} on ${tbUrl} — will need manual URL or SERP`);
          console.log(`    Suggested URL to try: ${tbConstructedUrl}`);
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
          const https = require('https');
          lboHtml = await new Promise((resolve, reject) => {
            https.get(lboUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
              if (res.statusCode !== 200) { resolve(null); return; }
              let data = '';
              res.on('data', c => data += c);
              res.on('end', () => resolve(data));
            }).on('error', reject);
          });
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
          const sitemapXml = await new Promise((resolve) => {
            require('https').get('https://www.londonboxoffice.co.uk/news-sitemap.xml', {
              headers: { 'User-Agent': 'Mozilla/5.0' },
            }, res => {
              if (res.statusCode !== 200) { resolve(null); return; }
              let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
            }).on('error', () => resolve(null));
          });
          if (sitemapXml) {
            // Match show title words against roundup URL slugs
            const titleWords = show.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
            const roundupUrls = [...sitemapXml.matchAll(/<loc>(https:\/\/www\.londonboxoffice\.co\.uk\/news\/post\/[^<]*review-round-up[^<]*)<\/loc>/gi)]
              .map(m => m[1]);
            const match = roundupUrls.find(url => {
              const slug = url.split('/').pop().toLowerCase();
              return titleWords.filter(w => slug.includes(w)).length >= Math.min(titleWords.length, 2);
            });
            if (match) {
              console.log(`    Sitemap match: ${match}`);
              lboHtml = await new Promise((resolve) => {
                require('https').get(match, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                }, res => {
                  if (res.statusCode !== 200) { resolve(null); return; }
                  let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
                }).on('error', () => resolve(null));
              });
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
      for (const trUrl of trUrls) {
        try {
          const fetched = await new Promise((resolve, reject) => {
            const req = require('https').get(trUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
            }, res => {
              if (res.statusCode === 301 || res.statusCode === 302) {
                require('https').get(res.headers.location, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                }, res2 => {
                  if (res2.statusCode !== 200) { resolve(null); return; }
                  let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d));
                }).on('error', () => resolve(null));
                return;
              }
              if (res.statusCode !== 200) { resolve(null); return; }
              let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
            });
            req.on('error', () => resolve(null));
          });
          if (fetched && fetched.length > 1000) {
            trHtml = fetched;
            console.log(`    Found at: ${trUrl}`);
            break;
          }
        } catch (e) {}
      }

      // Fallback: WP API search when URL construction misses
      if (!trHtml) {
        try {
          const searchTitle = show.title.replace(/['"']/g, '');
          const wpApiUrl = `https://theatre.reviews/wp-json/wp/v2/posts?per_page=5&search=${encodeURIComponent(searchTitle)}`;
          const wpResult = await new Promise((resolve) => {
            require('https').get(wpApiUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Accept: 'application/json' },
            }, res => {
              if (res.statusCode !== 200) { resolve(null); return; }
              let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
            }).on('error', () => resolve(null));
          });
          if (wpResult) {
            const posts = JSON.parse(wpResult);
            const roundup = posts.find(p => p.link && p.link.includes('/reviews-roundup/'));
            if (roundup) {
              console.log(`    WP API found: ${roundup.link}`);
              const fetched = await new Promise((resolve) => {
                require('https').get(roundup.link, {
                  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
                }, res => {
                  if (res.statusCode !== 200) { resolve(null); return; }
                  let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
                }).on('error', () => resolve(null));
              });
              if (fetched && fetched.length > 1000) trHtml = fetched;
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
            score: r.stars ? Math.round((r.stars / (r.starsOutOf || 5)) * 100) : null,
            scoreSource: r.stars ? 'theatre-reviews-star-rating' : undefined,
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

  // 1g. WestEndTheatre.com roundups (WE/OWE only — WP API + page fetch fallback)
  if (isWestEnd) {
    try {
      console.log('  Checking WestEndTheatre.com (WP API)...');
      const { execSync } = require('child_process');
      const cheerioWet = require('cheerio');
      const searchTitle = show.title.replace(/['"]/g, '');
      const apiUrl = `https://www.westendtheatre.com/wp-json/wp/v2/posts?categories=10&per_page=20&search=${encodeURIComponent(searchTitle)}`;
      const apiResult = execSync(
        `curl -s "${apiUrl}" -H "Accept: application/json" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"`,
        { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const posts = JSON.parse(apiResult);
      if (Array.isArray(posts) && posts.length > 0) {
        for (const post of posts.slice(0, 3)) {
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
              wetReviews.push({ outlet: outletLine, stars, critic: 'Unknown' });
            }
          }

          // Fallback: fetch rendered page for section-format posts (CSS classes)
          if (wetReviews.length === 0 && post.link) {
            try {
              const pageHtml = execSync(
                `curl -s -L "${post.link}" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" -H "Accept: text/html" --compressed`,
                { timeout: 20000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
              );
              const $w = cheerioWet.load(pageHtml);
              $w('.reviewnewpubhead').each((_, el) => {
                const outlet = $w(el).text().trim();
                const stars = ($w(el).next('.reviewnewstars').text().match(/★/g) || []).length;
                const authorText = $w(el).nextAll('.reviewnewauthor').first().text().trim();
                const cm = authorText.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z'-]+)+)/);
                if (outlet && stars > 0) {
                  wetReviews.push({ outlet, stars, critic: cm ? cm[1] : 'Unknown' });
                }
              });
            } catch (e) { /* page fetch failed — skip */ }
          }

          if (wetReviews.length === 0) continue;

          console.log(`  WestEndTheatre: ${wetReviews.length} ratings found`);

          // Archive
          const wetArchiveDir = path.join(DATA_DIR, 'aggregator-archive', 'westendtheatre');
          if (!fs.existsSync(wetArchiveDir)) fs.mkdirSync(wetArchiveDir, { recursive: true });
          fs.writeFileSync(path.join(wetArchiveDir, `${show.id}.json`),
            JSON.stringify({ ourShowId: show.id, wpPostId: post.id, fetchedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');

          for (const r of wetReviews) {
            results.push({
              showId: show.id,
              outletId: normalizeOutlet(r.outlet),
              outlet: r.outlet,
              criticName: r.critic,
              url: post.link || '',
              excerpt: '',
              score: Math.round((r.stars / 5) * 100),
              scoreSource: 'westendtheatre-star-rating',
              source: 'westendtheatre',
            });
          }
          break;
        }
      } else {
        console.log('  WestEndTheatre: no matching roundup');
      }
    } catch (err) {
      console.log(`  WestEndTheatre error: ${err.message}`);
    }
  }

  // 1h. The Stage roundup archives (WE/OWE only — check archive, can't fetch live without Playwright)
  if (isWestEnd) {
    try {
      console.log('  Checking The Stage archive...');
      const tsArchivePath = path.join(DATA_DIR, 'aggregator-archive', 'thestage-roundups', `${show.id}.html`);
      if (fs.existsSync(tsArchivePath)) {
        const { extractReviews: extractStageReviews } = require('./scrape-thestage-roundups');
        const tsHtml = fs.readFileSync(tsArchivePath, 'utf8');
        const tsReviews = extractStageReviews(tsHtml, show.id);
        console.log(`  The Stage: ${tsReviews.length} reviews from archive`);
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
      } else {
        console.log('  The Stage: no archive found');
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
async function runRSSFeeds(showTitle, knownUrls, openingDate = null) {
  console.log('\n[Layer 2] RSS Feeds...');
  try {
    const results = await checkRSSFeeds(showTitle, {
      maxHoursAgo: 72,
      knownUrls,
      verbose: true,
      openingDate,
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
  const rssResults = await runRSSFeeds(show.title, knownUrls, show.openingDate || null);

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
    const missingOutlets = getMissingT1T2Outlets(SHOW_ID, market)
      .filter(o => !foundOutletIds.has(o.id.toLowerCase()));
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
  pollCycle().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { pollCycle, checkReadiness, getMissingT1T2Outlets };
