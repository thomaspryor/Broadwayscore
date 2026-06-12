#!/usr/bin/env node
/**
 * Recover Missing Explicit Ratings
 *
 * Finds reviews from outlets with known rating systems that are missing
 * originalScore, then recovers ratings through multiple strategies:
 *
 * Phase 1: Local extraction from existing fullText/excerpts (free, instant)
 * Phase 2: Free API calls (Guardian API, Theater Life WP API)
 * Phase 3: URL scraping with score extraction from HTML
 *
 * Usage:
 *   node scripts/recover-explicit-ratings.js --dry-run          # Report only
 *   node scripts/recover-explicit-ratings.js --phase=1          # Local only
 *   node scripts/recover-explicit-ratings.js --phase=2          # APIs only
 *   node scripts/recover-explicit-ratings.js --phase=3          # Scrape URLs
 *   node scripts/recover-explicit-ratings.js --phase=0,1,2,3    # Full pipeline with URL discovery
 *   node scripts/recover-explicit-ratings.js --phase=0,3        # Discover URLs then scrape
 *   node scripts/recover-explicit-ratings.js --outlet=guardian   # Single outlet
 *   node scripts/recover-explicit-ratings.js --source=theatre-record # Filter by source
 *   node scripts/recover-explicit-ratings.js --limit=10          # Limit per outlet
 *
 * Environment Variables:
 *   GUARDIAN_API_KEY - For Guardian API (Phase 2)
 *   BRIGHTDATA_TOKEN - For URL scraping (Phase 3)
 *   SCRAPINGBEE_API_KEY - Fallback scraper (Phase 3)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { extractExplicitScore } = require('./lib/llm-score-extractor');
const { isScoreable } = require('./lib/is-scoreable');
const { extractScore: extractScoreRuleBased } = require('./lib/score-extractors');
const { buildCookieHeaderForUrl } = require('./lib/cookie-loader');
const { setExtractedScore } = require('./lib/score-routing');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

// Build showId → { title } map so isScoreable can activate the wrongShow
// stale-flag override (Notion 34e637c5-416f-8121).
function loadShowTitles() {
  const map = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
    for (const s of (j.shows || j)) {
      if (s.id && s.title) map.set(s.id, { title: s.title });
    }
  } catch { /* fall through — predicate fails safe to exclude wrongShow files */ }
  return map;
}
const SHOW_TITLES = loadShowTitles();
const showFor = (d) => (d.showId ? SHOW_TITLES.get(d.showId) : undefined);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PHASES = (() => {
  const p = args.find(a => a.startsWith('--phase='));
  return p ? p.split('=')[1].split(',').map(Number) : [1, 2, 3];
})();
const OUTLET_FILTER = args.find(a => a.startsWith('--outlet='))?.split('=')[1] || '';
const SOURCE_FILTER = args.find(a => a.startsWith('--source='))?.split('=')[1] || '';
const MARKET_FILTER = args.find(a => a.startsWith('--market='))?.split('=')[1] || '';
const SINCE_FILTER = args.find(a => a.startsWith('--since='))?.split('=')[1] || '';
const LIMIT = (() => {
  const l = args.find(a => a.startsWith('--limit='));
  return l ? parseInt(l.split('=')[1]) : 0;
})();
// Wall-clock budget — the backlog (~thousands of candidates × 2-3s sleeps) does
// not fit in one run. The script exits cleanly when the budget is reached; the
// attempt-rotation state below makes the next weekly run resume at the items
// this run didn't reach. 0 = unlimited.
const TIME_BUDGET_MIN = parseTimeBudgetMin(args);
const budget = createRunBudget(TIME_BUDGET_MIN);

// ---------------------------------------------------------------------------
// Known rated outlets and their rating systems
// ---------------------------------------------------------------------------
const RATED_OUTLETS = new Map([
  // US outlets
  ['nysr', { format: 'stars/5', api: 'wordpress' }],
  ['ny-stage-review', { format: 'stars/5', api: 'wordpress' }],
  ['nystagereview', { format: 'stars/5', api: 'wordpress' }],
  ['timeout', { format: 'stars/5', api: null }],
  ['time-out', { format: 'stars/5', api: null }],
  ['timeoutny', { format: 'stars/5', api: null }],
  ['ew', { format: 'letter-grade', api: null }],
  ['entertainment-weekly', { format: 'letter-grade', api: null }],
  ['usatoday', { format: 'numeric/100', api: null }],
  ['usa-today', { format: 'numeric/100', api: null }],
  // CultureSauce removed: text-only reviews, no consistent explicit ratings
  ['theater-life', { format: 'stars/5', api: 'wordpress' }],
  ['nypost', { format: 'mixed', api: null }],
  ['ny-post', { format: 'mixed', api: null }],

  // UK outlets (all use stars/5)
  ['guardian', { format: 'stars/5', api: 'guardian' }],
  ['the-guardian', { format: 'stars/5', api: 'guardian' }],
  ['the-guardian-uk', { format: 'stars/5', api: 'guardian' }],
  ['whatsonstage', { format: 'stars/5', api: null }],
  ['thestage', { format: 'stars/5', api: null }],
  ['the-stage', { format: 'stars/5', api: null }],
  ['the-stage-uk', { format: 'stars/5', api: null }],
  ['stage-uk', { format: 'stars/5', api: null }],
  ['telegraph', { format: 'stars/5', api: null }],
  ['the-telegraph', { format: 'stars/5', api: null }],
  ['the-telegraph-uk', { format: 'stars/5', api: null }],
  ['evening-standard', { format: 'stars/5', api: null }],
  ['the-independent', { format: 'stars/5', api: null }],
  ['the-independent-uk', { format: 'stars/5', api: null }],
  ['independent', { format: 'stars/5', api: null }],
  ['the-times', { format: 'stars/5', api: null }],
  ['the-times-uk', { format: 'stars/5', api: null }],
  ['times-uk', { format: 'stars/5', api: null }],
  ['the-times-clive-davis', { format: 'stars/5', api: null }],
  ['financial-times', { format: 'stars/5', api: null }],
  ['financial-times-uk', { format: 'stars/5', api: null }],
  ['financialtimes', { format: 'stars/5', api: null }],
  ['daily-mail', { format: 'stars/5', api: null }],
  ['dailymail', { format: 'stars/5', api: null }],
  ['the-arts-desk', { format: 'stars/5', api: null }],
  ['artsdesk', { format: 'stars/5', api: null }],
  ['musical-theatre-review', { format: 'stars/5', api: null }],
  // london-theatre (londontheatrereviews.co.uk): text-only reviews, no star ratings published.
  // Marked noScoreExtractor in score-extractors.js — do not attempt recovery.
  ['all-that-dazzles-uk', { format: 'stars/5', api: null }],
  ['everything-theatre', { format: 'stars/5', api: null }],
  ['everything-theatre-uk', { format: 'stars/5', api: null }],
  ['theatre-weekly', { format: 'stars/5', api: null }],
  ['theatre-bee-uk', { format: 'stars/5', api: null }],
  ['timeout-london', { format: 'stars/5', api: null }],
  ['i-newspaper', { format: 'stars/5', api: null }],
  ['cityam', { format: 'stars/5', api: null }],
  ['rollingstone', { format: 'stars/5', api: null }],
  ['digital-journal', { format: 'mixed', api: null }],
  ['jks-theatre-scene', { format: 'letter-grade', api: null }],

  // UK outlets added for Theatre Record coverage
  ['thereviewshub', { format: 'percentage', api: null }],
  // londontheatre1 (londontheatre1.com): text-only reviews, no star ratings published.
  // Marked noScoreExtractor in score-extractors.js — do not attempt recovery.
  ['broadwayworld', { format: 'stars/5', api: null }],
  ['sunday-times', { format: 'stars/5', api: null }],
  ['i-paper', { format: 'stars/5', api: null }],
  ['express-uk', { format: 'stars/5', api: null }],
  ['standard', { format: 'stars/5', api: null }],
  ['the-scotsman', { format: 'stars/5', api: null }],
  ['the-sun', { format: 'stars/5', api: null }],
]);

// ---------------------------------------------------------------------------
// Paths and config
// ---------------------------------------------------------------------------
const REVIEW_DIR = path.join(__dirname, '../data/review-texts');

// ---------------------------------------------------------------------------
// Stats tracking
// ---------------------------------------------------------------------------
const stats = {
  totalMissing: 0,
  phase0UrlsFound: 0,
  phase1Recovered: 0,
  phase2Recovered: 0,
  phase3Recovered: 0,
  phase3Scraped: 0,
  phase3ScrapeFailed: 0,
  byOutlet: {},
  errors: 0,
  timeBudgetMin: TIME_BUDGET_MIN,
  timeBudgetExhausted: false,
};

// Returns true (and logs once) when the run budget is spent. Phase loops break
// on this; main() skips any later phases.
function budgetSpent(phaseLabel, remainingCount) {
  if (!budget.exceeded()) return false;
  if (!stats.timeBudgetExhausted) {
    stats.timeBudgetExhausted = true;
    console.log(`\n  ⏱ Time budget (${TIME_BUDGET_MIN} min) reached in ${phaseLabel} — ${remainingCount} items deferred to next run`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Attempt rotation state — least-recently-attempted candidates run first.
// Without this, the deterministic show-directory order means permanently
// unrecoverable items at the head eat the whole budget every week and the
// tail never runs. Lives in data/audit/ so the workflow's existing
// "Commit audit data" step persists it between runs.
// ---------------------------------------------------------------------------
const ATTEMPT_STATE_PATH = path.join(__dirname, '../data/audit/recover-ratings-state.json');
const attemptState = (() => {
  try {
    const s = JSON.parse(fs.readFileSync(ATTEMPT_STATE_PATH, 'utf8'));
    return { attempts: s.attempts || {} };
  } catch { return { attempts: {} }; }
})();
const attemptKey = (r) => `${r.showId}/${r.file}`;
let attemptsSinceSave = 0;

function recordAttempt(review) {
  attemptState.attempts[attemptKey(review)] = new Date().toISOString();
  if (++attemptsSinceSave >= 25) saveAttemptState();
}

function saveAttemptState(validKeys = null) {
  if (DRY_RUN) return;
  // Prune only on unfiltered runs — a filtered run's candidate set is a
  // subset, and pruning against it would wipe rotation history for
  // everything outside the filter.
  if (validKeys) {
    for (const k of Object.keys(attemptState.attempts)) {
      if (!validKeys.has(k)) delete attemptState.attempts[k];
    }
  }
  try {
    fs.writeFileSync(ATTEMPT_STATE_PATH, JSON.stringify({
      updatedAt: new Date().toISOString(),
      attempts: attemptState.attempts,
    }, null, 2));
    attemptsSinceSave = 0;
  } catch (e) {
    console.log(`  ⚠️  Could not save attempt state: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 0: URL discovery for reviews without URLs (e.g., Theatre Record)
// ---------------------------------------------------------------------------
async function phase0DiscoverUrls(reviews) {
  const noUrl = reviews.filter(r => !r.data.url);
  if (noUrl.length === 0) return reviews;

  console.log(`\n═══ PHASE 0: URL Discovery (${noUrl.length} reviews without URLs) ═══\n`);

  let discoverCorrectUrl;
  try {
    ({ discoverCorrectUrl } = require('./lib/url-discovery'));
  } catch (err) {
    console.log('  URL discovery module not available:', err.message);
    return reviews;
  }

  // Lifecycle SERP gate — stops re-SERPing stuck wrong_content files on
  // closed-old shows. See sprint-plan-serp-cost-reduction.md S3-T4.
  const { shouldRetryUrlDiscovery, recordSerpAttempt } = require('./lib/review-guards');
  // Load shows.json once so the gate can look up lifecycle per review
  let _showsById = null;
  try {
    const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
    _showsById = {};
    for (const s of showsData.shows) _showsById[s.id] = s;
  } catch (e) { /* shows.json unavailable — gate will treat as 'unknown' */ }

  const sbKey = process.env.SCRAPINGBEE_API_KEY || '';
  const bdKey = process.env.BRIGHTDATA_TOKEN || '';
  if (!sbKey && !bdKey) {
    console.log('  No SERP keys available (SCRAPINGBEE_API_KEY / BRIGHTDATA_TOKEN). Skipping.');
    return reviews;
  }

  const toProcess = LIMIT > 0 ? noUrl.slice(0, LIMIT) : noUrl;
  let found = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const review = toProcess[i];
    if (budgetSpent('phase 0', toProcess.length - i)) break;
    recordAttempt(review);
    try {
      console.log(`  [${i + 1}/${toProcess.length}] ${review.showId}: ${review.data.outletId} / ${review.data.criticName || 'Unknown'}`);

      // Lifecycle gate — skip stuck wrong_content files on closed-old shows
      const showMeta = _showsById ? _showsById[review.showId] : null;
      const gate = shouldRetryUrlDiscovery(showMeta, { ...review.data, filePath: review.filePath });
      if (!gate.shouldRetry) {
        console.log(`    [serp-gate] Skipping: ${gate.reason}`);
        if (gate.updates && !DRY_RUN) {
          try {
            Object.assign(review.data, gate.updates);
            fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
          } catch (e) { /* non-fatal */ }
        }
        continue;
      }

      const result = await discoverCorrectUrl(review.data, sbKey, {
        brightDataKey: bdKey,
        log: (msg) => console.log(`    ${msg.trim()}`),
      });

      // Advance SERP attempt state even on failure
      if (!DRY_RUN) {
        try {
          const attemptUpdates = recordSerpAttempt(showMeta, review.data);
          if (Object.keys(attemptUpdates).length > 0) {
            Object.assign(review.data, attemptUpdates);
            fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
          }
        } catch (e) { /* non-fatal */ }
      }

      if (result && result !== '__SERP_UNAVAILABLE__') {
        found++;
        stats.phase0UrlsFound++;
        console.log(`    ✓ Found URL: ${result.substring(0, 80)}`);

        if (!DRY_RUN) {
          review.data.url = result;
          review.data.urlSource = 'serp-recovery';
          fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
        }
      } else {
        console.log(`    ✗ No URL found`);
      }
    } catch (err) {
      console.log(`    ✗ Error: ${err.message}`);
      stats.errors++;
    }

    // Rate limit between SERP queries
    if (i < toProcess.length - 1) await sleep(3000);
  }

  console.log(`\n  Phase 0 result: ${found} URLs discovered for ${toProcess.length} reviews`);
  return reviews;
}

// ---------------------------------------------------------------------------
// Phase 1: Local extraction
// ---------------------------------------------------------------------------
async function phase1ExtractLocal(reviews) {
  console.log('\n═══ PHASE 1: Local Extraction (existing fullText/excerpts) ═══\n');
  let recovered = 0;

  let idx = 0;
  for (const review of reviews) {
    // LLM-fallback extraction makes this loop slow at backlog scale
    if (budgetSpent('phase 1', reviews.length - idx)) break;
    idx++;
    const text = [
      review.data.fullText || '',
      review.data.dtliExcerpt || '',
      review.data.bwwExcerpt || '',
      review.data.showScoreExcerpt || '',
    ].filter(t => t.length > 0).join('\n\n');

    if (!text || text.length < 20) continue;

    // Try rule-based extraction first (free, no LLM)
    let result = extractScoreRuleBased('', text, review.data.outletId || '');
    // Fall back to LLM if rule-based didn't find anything
    if (!result) {
      result = await extractExplicitScore({
        text,
        outletId: review.data.outletId || ''
      });
    }
    if (result) {
      recovered++;
      stats.phase1Recovered++;
      trackOutlet(review.data.outletId, 'phase1');

      if (!DRY_RUN) {
        // Routes to originalScore unless EITHER the incoming source OR the
        // file's existing scoreSource is an aggregator. See lib/score-routing.js.
        const routed = setExtractedScore(review.data, {
          value: result.originalScore,
          normalizedValue: result.normalizedScore,
          source: result.source,
        });
        review.data.scoreExtractedFrom = 'local-text';
        review.data.scoreRecoveredAt = new Date().toISOString();
        console.log(`  ✓ ${review.showId}/${review.file}: ${result.originalScore} (${result.normalizedScore}/100) [${result.source}] → ${routed.field}`);
        fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
      } else {
        console.log(`  ✓ ${review.showId}/${review.file}: ${result.originalScore} (${result.normalizedScore}/100) [${result.source}]`);
      }

      // Remove from pending list
      review.recovered = true;
    }
  }

  console.log(`\n  Phase 1 result: ${recovered} ratings recovered from local text`);
  return reviews.filter(r => !r.recovered);
}

// ---------------------------------------------------------------------------
// Phase 2: Free API calls
// ---------------------------------------------------------------------------
async function phase2FreeAPIs(reviews) {
  console.log('\n═══ PHASE 2: Free API Calls ═══\n');

  // Guardian API
  const guardianReviews = reviews.filter(r => {
    const outletInfo = RATED_OUTLETS.get(r.data.outletId);
    return outletInfo?.api === 'guardian' && r.data.url?.includes('theguardian.com');
  });

  if (guardianReviews.length > 0 && process.env.GUARDIAN_API_KEY) {
    console.log(`  Guardian API: ${guardianReviews.length} reviews to check\n`);
    const recovered = await fetchGuardianRatings(guardianReviews);
    console.log(`\n  Guardian API: ${recovered} ratings recovered`);
  } else if (guardianReviews.length > 0) {
    console.log(`  Guardian API: ${guardianReviews.length} reviews could be recovered (set GUARDIAN_API_KEY)`);
  }

  // Theater Life WP API
  const theaterLifeReviews = reviews.filter(r =>
    r.data.outletId === 'theater-life' && r.data.url?.includes('theaterlife.com')
  );

  if (theaterLifeReviews.length > 0) {
    console.log(`\n  Theater Life WP API: ${theaterLifeReviews.length} reviews to check\n`);
    const recovered = await fetchTheaterLifeRatings(theaterLifeReviews);
    console.log(`\n  Theater Life WP: ${recovered} ratings recovered`);
  }

  // NYSR WP API
  const nysrReviews = reviews.filter(r =>
    ['nysr', 'ny-stage-review', 'nystagereview'].includes(r.data.outletId) &&
    r.data.url?.includes('nystagereview.com')
  );

  if (nysrReviews.length > 0) {
    console.log(`\n  NYSR WP API: ${nysrReviews.length} reviews to check\n`);
    const recovered = await fetchNYSRRatings(nysrReviews);
    console.log(`\n  NYSR WP: ${recovered} ratings recovered`);
  }

  return reviews.filter(r => !r.recovered);
}

// ---------------------------------------------------------------------------
// Guardian API helper
// ---------------------------------------------------------------------------
async function fetchGuardianRatings(reviews) {
  const apiKey = process.env.GUARDIAN_API_KEY;
  let recovered = 0;
  const toProcess = LIMIT > 0 ? reviews.slice(0, LIMIT) : reviews;

  for (let i = 0; i < toProcess.length; i++) {
    const review = toProcess[i];
    if (budgetSpent('phase 2 (Guardian)', toProcess.length - i)) break;
    try {
      const articleId = new URL(review.data.url).pathname.replace(/^\//, '');
      const params = new URLSearchParams({
        'api-key': apiKey,
        'show-fields': 'starRating',
      });

      const url = `https://content.guardianapis.com/${articleId}?${params}`;
      const result = await httpGet(url);

      if (result) {
        const json = JSON.parse(result);
        const starRating = json.response?.content?.fields?.starRating;

        if (starRating != null) {
          const rating = parseInt(starRating);
          if (rating >= 1 && rating <= 5) {
            recovered++;
            stats.phase2Recovered++;
            trackOutlet(review.data.outletId, 'phase2');

            console.log(`    [${i + 1}/${toProcess.length}] ★ ${review.showId}: ${rating}/5 stars`);

            if (!DRY_RUN) {
              setExtractedScore(review.data, {
                value: `${rating}/5 stars`,
                normalizedValue: Math.round((rating / 5) * 100),
                source: 'guardian-api',
              });
              review.data.scoreSource = 'guardian-api';
              review.data.scoreExtractedFrom = 'api-metadata';
              review.data.scoreRecoveredAt = new Date().toISOString();
              fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
            }
            review.recovered = true;
          }
        } else {
          console.log(`    [${i + 1}/${toProcess.length}] ✗ ${review.showId}: no starRating in API`);
        }
      }
    } catch (err) {
      console.log(`    [${i + 1}/${toProcess.length}] ✗ ${review.showId}: ${err.message}`);
      stats.errors++;
    }

    // Rate limit: 100ms between requests (12/sec limit)
    if (i < toProcess.length - 1) await sleep(100);
  }

  return recovered;
}

// ---------------------------------------------------------------------------
// Theater Life WP API helper
// ---------------------------------------------------------------------------
async function fetchTheaterLifeRatings(reviews) {
  let recovered = 0;
  const toProcess = LIMIT > 0 ? reviews.slice(0, LIMIT) : reviews;

  for (let i = 0; i < toProcess.length; i++) {
    const review = toProcess[i];
    if (budgetSpent('phase 2 (Theater Life)', toProcess.length - i)) break;
    try {
      // Extract slug from URL
      const slug = new URL(review.data.url).pathname.replace(/^\/|\/$/g, '');
      if (!slug) continue;

      // Try posts first, then pages (Theater Life uses WordPress pages, not posts)
      let posts = [];
      for (const type of ['posts', 'pages']) {
        const apiUrl = `https://theaterlife.com/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}`;
        const result = await httpGet(apiUrl);
        if (result) {
          try { posts = JSON.parse(result); } catch {}
          if (posts.length > 0) break;
        }
        await sleep(200);
      }

      if (posts.length > 0) {
        const title = posts[0].title?.rendered || '';
        // Check for star pattern in title
        const match = title.match(/\s+([*★]{1,5})\s*(1\/2)?\s*$/);
        if (match) {
          const stars = match[1].length;
          const halfStar = match[2] ? 0.5 : 0;
          const total = stars + halfStar;

          recovered++;
          stats.phase2Recovered++;
          trackOutlet('theater-life', 'phase2');

          console.log(`    [${i + 1}/${toProcess.length}] ★ ${review.showId}: ${total}/5 stars`);

          if (!DRY_RUN) {
            setExtractedScore(review.data, {
              value: `${total}/5 stars`,
              normalizedValue: Math.round((total / 5) * 100),
              source: 'wp-api-title',
            });
            review.data.scoreSource = 'wp-api-title';
            review.data.scoreExtractedFrom = 'api-metadata';
            review.data.scoreRecoveredAt = new Date().toISOString();
            fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
          }
          review.recovered = true;
        }
      }
    } catch (err) {
      console.log(`    [${i + 1}/${toProcess.length}] ✗ ${review.showId}: ${err.message}`);
      stats.errors++;
    }

    // Rate limit: 500ms (WP API is slower)
    if (i < toProcess.length - 1) await sleep(500);
  }

  return recovered;
}

// ---------------------------------------------------------------------------
// NYSR WP API helper
// ---------------------------------------------------------------------------
async function fetchNYSRRatings(reviews) {
  let recovered = 0;
  const toProcess = LIMIT > 0 ? reviews.slice(0, LIMIT) : reviews;

  for (let i = 0; i < toProcess.length; i++) {
    const review = toProcess[i];
    if (budgetSpent('phase 2 (NYSR)', toProcess.length - i)) break;
    try {
      const slug = new URL(review.data.url).pathname.replace(/^\/|\/$/g, '');
      if (!slug) continue;

      const url = `https://nystagereview.com/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}`;
      const result = await httpGet(url);

      if (result) {
        const posts = JSON.parse(result);
        if (posts.length > 0) {
          const excerpt = posts[0].excerpt?.rendered || '';
          // NYSR uses ★★★☆☆ in excerpt
          const starMatch = excerpt.match(/([★☆]{1,5})/);
          if (starMatch) {
            const filled = (starMatch[1].match(/★/g) || []).length;
            const total = starMatch[1].length;

            recovered++;
            stats.phase2Recovered++;
            trackOutlet(review.data.outletId, 'phase2');

            console.log(`    [${i + 1}/${toProcess.length}] ★ ${review.showId}: ${filled}/${total} stars`);

            if (!DRY_RUN) {
              setExtractedScore(review.data, {
                value: `${filled}/${total} stars`,
                normalizedValue: Math.round((filled / total) * 100),
                source: 'wp-api-excerpt',
              });
              review.data.scoreSource = 'wp-api-excerpt';
              review.data.scoreExtractedFrom = 'api-metadata';
              review.data.scoreRecoveredAt = new Date().toISOString();
              fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
            }
            review.recovered = true;
          }
        }
      }
    } catch (err) {
      console.log(`    [${i + 1}/${toProcess.length}] ✗ ${review.showId}: ${err.message}`);
      stats.errors++;
    }

    if (i < toProcess.length - 1) await sleep(500);
  }

  return recovered;
}

// Sites where archive.org should be tried first (paywalled/blocked)
const ARCHIVE_FIRST_DOMAINS = [
  'nytimes.com', 'vulture.com', 'nymag.com', 'washingtonpost.com',
  'wsj.com', 'newyorker.com', 'ew.com', 'latimes.com',
  'rollingstone.com', 'chicagotribune.com', 'nypost.com',
  'timeout.com', 'usatoday.com', 'ft.com', 'telegraph.co.uk',
  'thetimes.co.uk', 'thetimes.com', 'thestage.co.uk', 'standard.co.uk',
  // UK/niche paywalls — BD/SB can't crack anyway
  'independent.co.uk', 'nysun.com', 'spectator.co.uk', 'thejc.com',
  // Outlets that soft-paywall or block scrapers — matched to collect-review-texts.js list
  'nydailynews.com', 'bloomberg.com', 'northjersey.com', 'backstage.com',
  'talkinbroadway.com', 'huffpost.com', 'broadwaynews.com', 'theatrely.com',
  'amny.com', 'forward.com',
];

function isArchiveFirstSite(url) {
  const lower = (url || '').toLowerCase();
  return ARCHIVE_FIRST_DOMAINS.some(d => lower.includes(d));
}

/**
 * Fetch HTML from archive.org CDX API (no dependencies needed)
 */
async function fetchFromArchiveOrg(url) {
  try {
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=5&from=2008&to=2026`;
    const cdxData = await httpGet(cdxUrl);
    if (!cdxData) return null;

    let rows;
    try { rows = JSON.parse(cdxData); } catch { return null; }
    if (!Array.isArray(rows) || rows.length < 2) return null;

    // First row is header, rest are snapshots
    const snapshots = rows.slice(1)
      .filter(row => row[4] === '200' && (row[3] || '').includes('text/html'))
      .sort((a, b) => b[1].localeCompare(a[1])); // newest-first for score extraction

    for (let i = 0; i < Math.min(snapshots.length, 3); i++) {
      const [, timestamp, original] = snapshots[i];
      const archiveUrl = `https://web.archive.org/web/${timestamp}id_/${original}`;
      try {
        const html = await httpGet(archiveUrl);
        if (html && html.length > 1000) return html;
      } catch {}
      await sleep(1500); // respect archive.org rate limit
    }
    return null;
  } catch (err) {
    console.log(`    → Archive.org error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 3: URL scraping
// ---------------------------------------------------------------------------
async function phase3ScrapeURLs(reviews) {
  console.log('\n═══ PHASE 3: URL Scraping with Score Extraction ═══\n');

  // Only process reviews with absolute URLs (relative paths like "/article/..." are broken data
  // that cause API errors and count against rate limits — skip them here, fix at source)
  const relativeUrls = reviews.filter(r => r.data.url && !r.data.url.startsWith('http'));
  if (relativeUrls.length > 0) {
    console.log(`  ⚠️  Skipping ${relativeUrls.length} reviews with relative URLs (fix at source):`);
    relativeUrls.slice(0, 5).forEach(r => console.log(`    ${r.showId}: ${r.data.url}`));
    if (relativeUrls.length > 5) console.log(`    ... and ${relativeUrls.length - 5} more`);
  }
  const withUrls = reviews.filter(r => r.data.url && r.data.url.startsWith('http'));
  console.log(`  ${withUrls.length} reviews with absolute URLs remaining\n`);

  if (withUrls.length === 0) return reviews;

  let scraper;
  try {
    scraper = require('./lib/scraper');
  } catch (err) {
    console.log('  Scraper module not available (Playwright/APIs). Will use archive.org only.');
  }

  const toProcess = LIMIT > 0 ? withUrls.slice(0, LIMIT) : withUrls;
  let recovered = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const review = toProcess[i];
    const url = review.data.url;
    if (budgetSpent('phase 3', toProcess.length - i)) break;
    recordAttempt(review);
    try {
      console.log(`  [${i + 1}/${toProcess.length}] ${review.showId}: ${url}`);

      let html = null;

      // Try direct HTTP with subscriber cookies first (free, instant)
      html = await httpGetWithCookies(url);

      // For paywall/blocked sites without cookies, try archive.org
      if (!html && isArchiveFirstSite(url)) {
        console.log(`    → Trying archive.org (paywall site)...`);
        html = await fetchFromArchiveOrg(url);
        if (html) console.log(`    → Archive.org: ${html.length} chars`);
      }

      // Fall back to scraper for non-paywall or if archive/cookies failed
      if (!html && scraper) {
        const result = await scraper.fetchPage(url);
        if (result && result.content) {
          html = result.content;
          console.log(`    → ${result.source}: ${html.length} chars`);
        }
      }

      // If no scraper and not archive-first, try archive.org as last resort
      if (!html && !scraper) {
        console.log(`    → Trying archive.org (no scraper available)...`);
        html = await fetchFromArchiveOrg(url);
        if (html) console.log(`    → Archive.org: ${html.length} chars`);
      }

      stats.phase3Scraped++;

      if (html && html.length > 500) {
        // Try rule-based extractors first (free, handles SVG/CSS/image star patterns)
        let result = extractScoreRuleBased(html, review.data.fullText || '', review.data.outletId || '');
        // Fall back to LLM-based extraction if rule-based didn't find anything
        if (!result) {
          result = await extractExplicitScore({
            text: review.data.fullText || '',
            html: html || '',
            outletId: review.data.outletId || ''
          });
        }
        if (result) {
          recovered++;
          stats.phase3Recovered++;
          trackOutlet(review.data.outletId, 'phase3');

          if (!DRY_RUN) {
            // Routes to originalScore unless EITHER the incoming source OR the
            // file's existing scoreSource is an aggregator. See lib/score-routing.js.
            const routed = setExtractedScore(review.data, {
              value: result.originalScore,
              normalizedValue: result.normalizedScore,
              source: result.source,
            });
            review.data.scoreExtractedFrom = 'scraped-html';
            review.data.scoreRecoveredAt = new Date().toISOString();
            console.log(`    ★ ${review.showId}: ${result.originalScore} (${result.normalizedScore}/100) [${result.source}] → ${routed.field}`);
            fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
          } else {
            console.log(`    ★ ${review.showId}: ${result.originalScore} (${result.normalizedScore}/100) [${result.source}]`);
          }
          review.recovered = true;
        } else {
          console.log(`    ✗ No score found in HTML`);
        }
      } else {
        console.log(`    ✗ Fetch failed or insufficient content`);
        stats.phase3ScrapeFailed++;
      }
    } catch (err) {
      console.log(`    ✗ Error: ${err.message}`);
      stats.phase3ScrapeFailed++;
      stats.errors++;
    }

    // Rate limit between scrapes
    if (i < toProcess.length - 1) await sleep(2000);
  }

  if (scraper && scraper.cleanup) {
    try { await scraper.cleanup(); } catch {}
  }

  console.log(`\n  Phase 3 result: ${recovered} ratings recovered from ${stats.phase3Scraped} scraped pages`);
  return reviews.filter(r => !r.recovered);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpGet(url, maxRedirects = 5) {
  const lib = url.startsWith('https') ? https : require('http');
  return new Promise((resolve, reject) => {
    lib.get(url, { headers: { 'User-Agent': 'BroadwayScorecard/1.0' }, timeout: 30000 }, (res) => {
      // Follow redirects (with depth limit)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('too many redirects'));
        return httpGet(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else resolve(null);
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

/**
 * Fetch URL with subscriber cookies (free, no API credits).
 * Returns HTML string or null if cookies unavailable/fetch fails.
 */
async function httpGetWithCookies(url) {
  const cookieHeader = buildCookieHeaderForUrl(url);
  if (!cookieHeader) return null;

  try {
    const hostname = new URL(url).hostname;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': cookieHeader,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `https://${hostname}/`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (resp.status !== 200) return null;
    const html = await resp.text();
    if (html && html.length > 1000) {
      console.log(`    → Direct+cookies: ${html.length} chars`);
      return html;
    }
    return null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trackOutlet(outletId, phase) {
  if (!stats.byOutlet[outletId]) stats.byOutlet[outletId] = { phase1: 0, phase2: 0, phase3: 0 };
  stats.byOutlet[outletId][phase]++;
}

// ---------------------------------------------------------------------------
// Find all missing ratings
// ---------------------------------------------------------------------------
function findMissingRatings() {
  const reviews = [];

  let shows = fs.readdirSync(REVIEW_DIR).filter(d => {
    try { return fs.statSync(path.join(REVIEW_DIR, d)).isDirectory(); } catch { return false; }
  });

  // Market filter: restrict to shows matching a market keyword (e.g., 'west-end')
  if (MARKET_FILTER) {
    shows = shows.filter(d => d.includes(MARKET_FILTER));
  }

  // Since filter: restrict to shows opened on or after a date (e.g., '2024-07-01')
  // Also includes all currently open/previews shows regardless of date
  if (SINCE_FILTER) {
    const showsJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
    const recentIds = new Set(showsJson.shows
      .filter(s => s.status === 'open' || s.status === 'previews' || (s.openingDate && s.openingDate >= SINCE_FILTER))
      .map(s => s.id));
    shows = shows.filter(d => recentIds.has(d));
  }

  for (const showId of shows) {
    const showDir = path.join(REVIEW_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!isScoreable(data, showFor(data), filePath)) continue;
        if (data.originalScore) continue;

        const outletId = data.outletId || '';
        if (!RATED_OUTLETS.has(outletId)) continue;

        if (OUTLET_FILTER && outletId !== OUTLET_FILTER) continue;
        if (SOURCE_FILTER && data.source !== SOURCE_FILTER) continue;

        reviews.push({ showId, file, filePath, data });
      } catch {}
    }
  }

  return reviews;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  RECOVER MISSING EXPLICIT RATINGS                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('*** DRY RUN — no files will be modified ***');
  console.log(`Phases: ${PHASES.join(', ')}`);
  if (OUTLET_FILTER) console.log(`Outlet filter: ${OUTLET_FILTER}`);
  if (SOURCE_FILTER) console.log(`Source filter: ${SOURCE_FILTER}`);
  if (MARKET_FILTER) console.log(`Market filter: ${MARKET_FILTER}`);
  if (LIMIT) console.log(`Limit per phase: ${LIMIT}`);
  if (TIME_BUDGET_MIN) console.log(`Time budget: ${TIME_BUDGET_MIN} min`);

  // Find all reviews missing ratings
  let reviews = findMissingRatings();
  stats.totalMissing = reviews.length;

  // Rotate: least-recently-attempted first (never-attempted sorts to the
  // front). Stops the same unrecoverable head from eating every weekly run.
  reviews.sort((a, b) =>
    (attemptState.attempts[attemptKey(a)] || '').localeCompare(attemptState.attempts[attemptKey(b)] || '')
  );
  const isUnfilteredRun = !OUTLET_FILTER && !SOURCE_FILTER && !MARKET_FILTER && !SINCE_FILTER && LIMIT === 0;
  const allCandidateKeys = new Set(reviews.map(attemptKey));

  console.log(`\nFound ${reviews.length} reviews from rated outlets missing originalScore\n`);

  // Breakdown by outlet
  const byOutlet = {};
  for (const r of reviews) {
    byOutlet[r.data.outletId] = (byOutlet[r.data.outletId] || 0) + 1;
  }
  const sorted = Object.entries(byOutlet).sort((a, b) => b[1] - a[1]);
  console.log('Missing by outlet:');
  for (const [outlet, count] of sorted.slice(0, 20)) {
    const info = RATED_OUTLETS.get(outlet);
    console.log(`  ${outlet.padEnd(25)} ${String(count).padEnd(6)} (${info?.format || '?'}${info?.api ? `, API: ${info.api}` : ''})`);
  }
  if (sorted.length > 20) console.log(`  ... and ${sorted.length - 20} more outlets`);

  // Phase 0: URL discovery (for reviews without URLs, e.g. Theatre Record)
  if (PHASES.includes(0) && !stats.timeBudgetExhausted) {
    reviews = await phase0DiscoverUrls(reviews);
  }

  // Phase 1: Local extraction
  if (PHASES.includes(1) && !stats.timeBudgetExhausted) {
    reviews = await phase1ExtractLocal(reviews);
  }

  // Phase 2: Free APIs
  if (PHASES.includes(2) && !stats.timeBudgetExhausted) {
    reviews = await phase2FreeAPIs(reviews);
  }

  // Phase 3: URL scraping
  if (PHASES.includes(3) && !stats.timeBudgetExhausted) {
    reviews = await phase3ScrapeURLs(reviews);
  }

  // Persist rotation state (prune only when this run saw the full candidate set)
  saveAttemptState(isUnfilteredRun ? allCandidateKeys : null);

  // Final summary
  const totalRecovered = stats.phase1Recovered + stats.phase2Recovered + stats.phase3Recovered;
  console.log('\n' + '═'.repeat(60));
  console.log('RECOVERY SUMMARY');
  console.log('═'.repeat(60));
  console.log(`Total missing ratings found: ${stats.totalMissing}`);
  if (stats.phase0UrlsFound) console.log(`Phase 0 (URL discovery):     ${stats.phase0UrlsFound} URLs found`);
  console.log(`Phase 1 (local text):        ${stats.phase1Recovered}`);
  console.log(`Phase 2 (free APIs):         ${stats.phase2Recovered}`);
  console.log(`Phase 3 (URL scraping):      ${stats.phase3Recovered} (${stats.phase3Scraped} scraped, ${stats.phase3ScrapeFailed} failed)`);
  console.log(`Total recovered:             ${totalRecovered}`);
  console.log(`Still missing:               ${stats.totalMissing - totalRecovered}`);
  console.log(`Errors:                      ${stats.errors}`);
  if (TIME_BUDGET_MIN) {
    console.log(`Time budget:                 ${stats.timeBudgetExhausted ? `EXHAUSTED at ${TIME_BUDGET_MIN} min — backlog deferred to next run` : `ok (${budget.elapsedMin()}/${TIME_BUDGET_MIN} min used)`}`);
  }

  if (Object.keys(stats.byOutlet).length > 0) {
    console.log('\nRecoveries by outlet:');
    const outletStats = Object.entries(stats.byOutlet).sort((a, b) =>
      (b[1].phase1 + b[1].phase2 + b[1].phase3) - (a[1].phase1 + a[1].phase2 + a[1].phase3)
    );
    for (const [outlet, s] of outletStats) {
      const total = s.phase1 + s.phase2 + s.phase3;
      const parts = [];
      if (s.phase1) parts.push(`P1:${s.phase1}`);
      if (s.phase2) parts.push(`P2:${s.phase2}`);
      if (s.phase3) parts.push(`P3:${s.phase3}`);
      console.log(`  ${outlet.padEnd(25)} ${total} recovered (${parts.join(', ')})`);
    }
  }

  if (DRY_RUN) {
    console.log('\n*** DRY RUN — no files were modified ***');
  }

  // Write JSON report for CI consumption
  const reportPath = path.join(__dirname, '../data/audit/recover-ratings-report.json');
  try {
    fs.writeFileSync(reportPath, JSON.stringify(stats, null, 2));
    console.log(`\nReport written to: ${reportPath}`);
  } catch (err) {
    console.log(`\nCould not write report: ${err.message}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
