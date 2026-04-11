#!/usr/bin/env node
/**
 * Verify and Replace Show Score Star Ratings
 *
 * Show Score assigns its own star ratings to ALL reviews, even outlets that
 * don't have native star ratings. For outlets that DO have native stars,
 * SS usually mirrors them but is wrong ~11% of the time (reads CSS --rating
 * float instead of displayed integer stars).
 *
 * This script finds WE reviews currently scored via "originalScore-showscore-downgraded"
 * in reviews.json, then:
 *   Phase 1: Extracts scores from existing fullText/HTML using rule-based extractors
 *   Phase 2: Uses free APIs (Guardian) to get verified scores
 *   Phase 3: Scrapes the actual outlet page and extracts the real star rating
 *
 * When a verified score is found, it replaces the SS-assigned originalScore and
 * sets scoreSource to the verified source — promoting the review from P3b to P0.5
 * in the scoring priority hierarchy.
 *
 * Usage:
 *   node scripts/verify-showscore-stars.js --dry-run     # Report only
 *   node scripts/verify-showscore-stars.js               # Fix mismatches
 *   node scripts/verify-showscore-stars.js --phase=1     # Local only
 *   node scripts/verify-showscore-stars.js --phase=1,3   # Local + scrape
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { extractScore: extractScoreRuleBased } = require('./lib/score-extractors');
const { setExtractedScore } = require('./lib/score-routing');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PHASES = (() => {
  const p = args.find(a => a.startsWith('--phase='));
  return p ? p.split('=')[1].split(',').map(Number) : [1, 2, 3];
})();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const REVIEW_DIR = path.join(__dirname, '../data/review-texts');
const REVIEWS_JSON = path.join(__dirname, '../data/reviews.json');

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
const stats = {
  total: 0,
  phase1: 0,
  phase2: 0,
  phase3: 0,
  mismatches: 0,
  confirmed: 0,
  noScore: 0,
  errors: 0,
};

// ---------------------------------------------------------------------------
// Find SS-downgraded reviews from reviews.json
// ---------------------------------------------------------------------------
function findSSDowngradedReviews() {
  const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_JSON, 'utf8'));
  const ssReviews = reviewsData.reviews.filter(
    r => r.scoreSource === 'originalScore-showscore-downgraded'
  );

  const results = [];
  for (const r of ssReviews) {
    const showDir = path.join(REVIEW_DIR, r.showId);
    if (!fs.existsSync(showDir)) continue;

    // Find source files for this outlet
    const files = fs.readdirSync(showDir).filter(f =>
      f.startsWith(r.outletId + '--') && f.endsWith('.json')
    );

    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Only process files sourced from Show Score
        if (data.source !== 'show-score' && data.source !== 'show-score-playwright') continue;
        results.push({
          showId: r.showId,
          outlet: r.outlet,
          outletId: r.outletId,
          ssScore: r.assignedScore,
          ssOriginal: data.originalScore,
          url: data.url || r.url,
          file,
          filePath,
          data,
        });
      } catch {}
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase 1: Extract from existing fullText using rule-based extractors
// ---------------------------------------------------------------------------
function phase1LocalExtract(reviews) {
  console.log('\n═══ PHASE 1: Local Extraction (existing fullText) ═══\n');
  let found = 0;

  for (const review of reviews) {
    if (review.verified) continue;

    const text = review.data.fullText || '';
    const html = ''; // No HTML stored locally, use text only

    if (text.length < 50) continue;

    const result = extractScoreRuleBased(html, text, review.outletId);
    if (result && result.normalizedScore) {
      found++;
      stats.phase1++;
      applyResult(review, result, 'local-text');
    }
  }

  console.log(`  Phase 1 result: ${found} ratings extracted from local text\n`);
}

// ---------------------------------------------------------------------------
// Phase 2: Free APIs (Guardian)
// ---------------------------------------------------------------------------
async function phase2APIs(reviews) {
  console.log('\n═══ PHASE 2: Free API Calls ═══\n');

  const guardianReviews = reviews.filter(r =>
    !r.verified && r.outletId === 'guardian' && r.url?.includes('theguardian.com')
  );

  if (guardianReviews.length > 0 && process.env.GUARDIAN_API_KEY) {
    console.log(`  Guardian API: ${guardianReviews.length} reviews\n`);
    for (const review of guardianReviews) {
      try {
        const articleId = new URL(review.url).pathname.replace(/^\//, '');
        const params = new URLSearchParams({
          'api-key': process.env.GUARDIAN_API_KEY,
          'show-fields': 'starRating',
        });
        const url = `https://content.guardianapis.com/${articleId}?${params}`;
        const body = await httpGet(url);
        if (body) {
          const json = JSON.parse(body);
          const starRating = json.response?.content?.fields?.starRating;
          if (starRating != null) {
            const rating = parseInt(starRating);
            if (rating >= 1 && rating <= 5) {
              stats.phase2++;
              applyResult(review, {
                originalScore: `${rating}/5 stars`,
                normalizedScore: Math.round((rating / 5) * 100),
                source: 'guardian-api',
              }, 'api-metadata');
            }
          }
        }
        await sleep(100);
      } catch (err) {
        console.log(`    ✗ Guardian API error for ${review.showId}: ${err.message}`);
        stats.errors++;
      }
    }
  } else if (guardianReviews.length > 0) {
    console.log(`  Guardian API: ${guardianReviews.length} reviews (GUARDIAN_API_KEY not set)\n`);
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Scrape outlet pages and extract scores from HTML
// ---------------------------------------------------------------------------
async function phase3Scrape(reviews) {
  console.log('\n═══ PHASE 3: Scrape Outlet Pages ═══\n');

  const pending = reviews.filter(r => !r.verified && r.url);
  console.log(`  ${pending.length} reviews to scrape\n`);

  if (pending.length === 0) return;

  let scraper;
  try {
    scraper = require('./lib/scraper');
  } catch (err) {
    console.log('  Scraper not available. Trying archive.org only.\n');
  }

  for (let i = 0; i < pending.length; i++) {
    const review = pending[i];
    const url = review.url;
    console.log(`  [${i + 1}/${pending.length}] ${review.showId} | ${review.outlet} | ${url}`);

    let html = null;

    // Try archive.org first for paywalled sites
    if (isPaywalled(url)) {
      console.log(`    → Trying archive.org (paywall site)...`);
      html = await fetchFromArchiveOrg(url);
      if (html) console.log(`    → Archive.org: ${html.length} chars`);
    }

    // Fall back to scraper
    if (!html && scraper) {
      try {
        const result = await scraper.fetchPage(url);
        if (result) {
          html = typeof result === 'string' ? result : result.content || result.html || result.body || '';
          if (html.length > 500) {
            console.log(`    → Scraper: ${html.length} chars`);
          } else {
            html = null;
          }
        }
      } catch (err) {
        console.log(`    → Scraper error: ${err.message}`);
      }
    }

    // Last resort: archive.org (for any site where scraper failed or returned empty)
    if (!html) {
      if (!isPaywalled(url)) {
        // Non-paywalled sites: try archive.org as fallback
        console.log(`    → Trying archive.org (fallback)...`);
      } else {
        // Paywalled sites: archive.org was already tried, skip
      }
      if (!isPaywalled(url)) {
        html = await fetchFromArchiveOrg(url);
        if (html) console.log(`    → Archive.org: ${html.length} chars`);
      }
    }

    if (html && html.length > 500) {
      const result = extractScoreRuleBased(html, review.data.fullText || '', review.outletId);
      if (result && result.normalizedScore) {
        stats.phase3++;
        applyResult(review, result, 'scraped-html');
      } else {
        console.log(`    ✗ No score found in HTML`);
        stats.noScore++;
      }
    } else {
      console.log(`    ✗ Fetch failed`);
      stats.noScore++;
    }

    // Rate limit
    if (i < pending.length - 1) await sleep(1500);
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Playwright — visit pages and extract from rendered DOM
// ---------------------------------------------------------------------------
async function phase4Playwright(reviews) {
  console.log('\n═══ PHASE 4: Playwright (JS-rendered pages) ═══\n');

  const pending = reviews.filter(r => !r.verified && r.url);
  console.log(`  ${pending.length} reviews to check via Playwright\n`);
  if (pending.length === 0) return;

  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.log(`  Playwright not available: ${err.message}\n`);
    return;
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  for (let i = 0; i < pending.length; i++) {
    const review = pending[i];
    const url = review.url;
    console.log(`  [${i + 1}/${pending.length}] ${review.showId} | ${review.outlet} | ${url}`);

    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const rating = await page.evaluate(() => {
        const h1 = document.querySelector('h1');

        // Strategy 1: The Stage — SVG star images (19stageStar.svg / 19stageNoStar.svg)
        if (h1) {
          const parent = h1.parentElement;
          const imgs = parent ? parent.querySelectorAll('img') : [];
          const starImgs = Array.from(imgs).filter(img => {
            const src = (img.src || '').toLowerCase();
            return src.includes('star') && img.width < 40;
          });
          if (starImgs.length === 5) {
            const filled = starImgs.filter(img => !img.src.toLowerCase().includes('nostar')).length;
            return { stars: filled, max: 5, source: 'stage-star-svg' };
          }
        }

        // Strategy 2: JSON-LD ratingValue
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const data = JSON.parse(s.textContent);
            const findRating = (obj) => {
              if (!obj || typeof obj !== 'object') return null;
              if (obj.ratingValue) return parseFloat(obj.ratingValue);
              if (obj.reviewRating && obj.reviewRating.ratingValue) return parseFloat(obj.reviewRating.ratingValue);
              if (Array.isArray(obj['@graph'])) {
                for (const item of obj['@graph']) {
                  const r = findRating(item);
                  if (r) return r;
                }
              }
              return null;
            };
            const rv = findRating(data);
            if (rv && rv >= 1 && rv <= 5) return { stars: rv, max: 5, source: 'json-ld' };
          } catch (e) { /* ignore parse errors */ }
        }

        // Strategy 3: Meta itemprop ratingValue
        const meta = document.querySelector('meta[itemprop="ratingValue"], meta[property="og:rating"]');
        if (meta) {
          const v = parseFloat(meta.content);
          if (v >= 1 && v <= 5) return { stars: v, max: 5, source: 'meta-itemprop' };
        }

        // Strategy 4: Star images (WhatsOnStage yellow.png/star-grey.png)
        const starContainers = document.querySelectorAll('[class*="star"], [class*="rating"]');
        for (const container of starContainers) {
          const imgs = container.querySelectorAll('img');
          if (imgs.length >= 3 && imgs.length <= 5) {
            const srcs = Array.from(imgs).map(i => i.src.toLowerCase());
            const filled = srcs.filter(s =>
              s.includes('yellow') || s.includes('filled') || s.includes('full') ||
              (s.includes('star') && !s.includes('grey') && !s.includes('gray') && !s.includes('empty') && !s.includes('no'))
            ).length;
            if (filled > 0) return { stars: filled, max: imgs.length, source: 'wos-star-images' };
          }
        }

        // Strategy 5: Unicode stars (★☆)
        const body = document.body.innerText;
        const unicodeMatch = body.match(/([★☆]{3,5})/);
        if (unicodeMatch) {
          const filled = (unicodeMatch[1].match(/★/g) || []).length;
          const total = unicodeMatch[1].length;
          if (total >= 3 && total <= 5) return { stars: filled, max: total, source: 'unicode-stars' };
        }

        // Strategy 6: "X/5" near rating context
        const ratingMatch = body.match(/\b(\d)\/5\s*(?:stars?|★)/i);
        if (ratingMatch) {
          return { stars: parseInt(ratingMatch[1]), max: 5, source: 'explicit-rating' };
        }

        // Strategy 7: SVG-based stars near h1 (Guardian, etc.)
        if (h1) {
          const ratingParent = h1.closest('[class*="content"]') || h1.parentElement && h1.parentElement.parentElement;
          if (ratingParent) {
            const svgs = ratingParent.querySelectorAll('svg[viewBox]');
            const starSvgs = Array.from(svgs).filter(function(svg) {
              var vb = svg.getAttribute('viewBox') || '';
              return vb.includes('24') || vb.includes('30');
            });
            if (starSvgs.length === 5) {
              var classCounts = {};
              starSvgs.forEach(function(svg) {
                var pcls = (svg.parentElement && svg.parentElement.className) || 'unknown';
                classCounts[pcls] = (classCounts[pcls] || 0) + 1;
              });
              var classKeys = Object.keys(classCounts);
              if (classKeys.length === 2) {
                var firstClass = (starSvgs[0].parentElement && starSvgs[0].parentElement.className) || '';
                var filled = classCounts[firstClass] || 0;
                if (filled >= 1 && filled <= 5) {
                  return { stars: filled, max: 5, source: 'stage-star-svg' };
                }
              } else if (classKeys.length === 1) {
                return { stars: 5, max: 5, source: 'stage-star-svg' };
              }
            }
          }
        }

        // Strategy 8: Drupal fivestar widget (Arts Desk)
        var fivestarEl = document.querySelector('.fivestar-widget, .field-name-field-rating, [class*="fivestar"]');
        if (fivestarEl) {
          var fivestarStars = fivestarEl.querySelectorAll('.star, [class*="star"]');
          if (fivestarStars.length >= 3) {
            var filledStars = Array.from(fivestarStars).filter(function(el) {
              var cls = (el.className || '').toLowerCase();
              return cls.includes('on') || cls.includes('filled') || cls.includes('hover');
            }).length;
            if (filledStars > 0) return { stars: filledStars, max: fivestarStars.length, source: 'fivestar-widget' };
          }
        }

        return null;
      });

      await page.close();

      if (rating && rating.stars && rating.max) {
        const normalizedScore = Math.round((rating.stars / rating.max) * 100);
        stats.phase4 = (stats.phase4 || 0) + 1;
        applyResult(review, {
          originalScore: rating.stars + '/' + rating.max + ' stars',
          normalizedScore: normalizedScore,
          source: rating.source,
        }, 'playwright-rendered');
      } else {
        console.log('    ✗ No star rating found in rendered page');
        stats.noScore++;
      }
    } catch (err) {
      console.log('    ✗ Playwright error: ' + err.message);
      stats.errors++;
    }

    if (i < pending.length - 1) await sleep(2000);
  }

  await browser.close();
}

// ---------------------------------------------------------------------------
// Apply a verified result and compare with SS
// ---------------------------------------------------------------------------
function applyResult(review, result, extractedFrom) {
  const ssNorm = review.ssScore;
  const verifiedNorm = result.normalizedScore;
  const match = ssNorm === verifiedNorm;

  if (match) {
    stats.confirmed++;
    console.log(`    ✓ CONFIRMED: SS=${ssNorm} matches verified=${verifiedNorm} (${result.originalScore}) [${result.source}]`);
  } else {
    stats.mismatches++;
    console.log(`    ★ MISMATCH: SS=${ssNorm} → verified=${verifiedNorm} (${result.originalScore}) [${result.source}]`);
  }

  review.verified = true;
  review.verifiedScore = result.originalScore;
  review.verifiedNorm = verifiedNorm;
  review.verifiedSource = result.source;

  if (!DRY_RUN) {
    // Routes to originalScore unless EITHER the incoming source OR the
    // file's existing scoreSource is an aggregator. See lib/score-routing.js.
    const routed = setExtractedScore(review.data, {
      value: result.originalScore,
      normalizedValue: result.normalizedScore,
      source: result.source,
    });
    if (!routed.wasAggregator) {
      review.data.scoreSource = result.source;
    }
    review.data.scoreExtractedFrom = extractedFrom;
    review.data.scoreVerifiedAt = new Date().toISOString();
    review.data.previousShowScoreRating = review.ssOriginal;
    fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PAYWALL_DOMAINS = [
  'ft.com', 'telegraph.co.uk', 'thetimes.co.uk', 'thetimes.com',
  'standard.co.uk', 'thestage.co.uk', 'independent.co.uk',
];

function isPaywalled(url) {
  const lower = (url || '').toLowerCase();
  return PAYWALL_DOMAINS.some(d => lower.includes(d));
}

async function fetchFromArchiveOrg(url) {
  try {
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=5&from=2008&to=2026`;
    const cdxData = await httpGet(cdxUrl);
    if (!cdxData) return null;

    let rows;
    try { rows = JSON.parse(cdxData); } catch { return null; }
    if (!Array.isArray(rows) || rows.length < 2) return null;

    const snapshots = rows.slice(1)
      .filter(row => row[4] === '200' && (row[3] || '').includes('text/html'))
      .sort((a, b) => b[1].localeCompare(a[1]));

    for (let i = 0; i < Math.min(snapshots.length, 3); i++) {
      const [, timestamp, original] = snapshots[i];
      const archiveUrl = `https://web.archive.org/web/${timestamp}id_/${original}`;
      try {
        const html = await httpGet(archiveUrl);
        if (html && html.length > 1000) return html;
      } catch {}
      await sleep(1500);
    }
    return null;
  } catch (err) {
    console.log(`    → Archive.org error: ${err.message}`);
    return null;
  }
}

function httpGet(url, maxRedirects = 5) {
  const lib = url.startsWith('https') ? https : require('http');
  return new Promise((resolve, reject) => {
    lib.get(url, { headers: { 'User-Agent': 'BroadwayScorecard/1.0' }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('too many redirects'));
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return httpGet(next, maxRedirects - 1).then(resolve).catch(reject);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  VERIFY SHOW SCORE STAR RATINGS                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('*** DRY RUN — no files will be modified ***\n');
  console.log(`Phases: ${PHASES.join(', ')}\n`);

  const reviews = findSSDowngradedReviews();
  stats.total = reviews.length;

  console.log(`Found ${reviews.length} reviews using SS-downgraded star ratings:\n`);
  for (const r of reviews) {
    console.log(`  ${r.showId} | ${r.outlet} (${r.outletId}) | SS: ${r.ssOriginal} → ${r.ssScore} | URL: ${r.url || 'none'}`);
  }

  if (PHASES.includes(1)) phase1LocalExtract(reviews);
  if (PHASES.includes(2)) await phase2APIs(reviews);
  if (PHASES.includes(3)) await phase3Scrape(reviews);
  if (PHASES.includes(4)) await phase4Playwright(reviews);

  // Summary
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  SUMMARY                                                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`  Total SS-downgraded reviews: ${stats.total}`);
  console.log(`  Phase 1 (local text):        ${stats.phase1} verified`);
  console.log(`  Phase 2 (API):               ${stats.phase2} verified`);
  console.log(`  Phase 3 (scrape):            ${stats.phase3} verified`);
  console.log(`  Phase 4 (Playwright):        ${stats.phase4 || 0} verified`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Confirmed (SS was correct):  ${stats.confirmed}`);
  console.log(`  Mismatches (SS was WRONG):   ${stats.mismatches}`);
  console.log(`  Could not verify:            ${stats.noScore}`);
  console.log(`  Errors:                      ${stats.errors}`);

  const unverified = reviews.filter(r => !r.verified);
  if (unverified.length > 0) {
    console.log(`\n  Unverified reviews (${unverified.length}):`);
    for (const r of unverified) {
      console.log(`    ${r.showId} | ${r.outlet} | ${r.url || 'no URL'}`);
    }
  }

  if (!DRY_RUN && (stats.phase1 + stats.phase2 + stats.phase3) > 0) {
    console.log(`\n  ✓ ${stats.phase1 + stats.phase2 + stats.phase3} review files updated.`);
    console.log(`  → Run "node scripts/rebuild-all-reviews.js" to regenerate reviews.json`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
