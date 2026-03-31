#!/usr/bin/env node
/**
 * Generate per-show detail JSON files for the mobile app.
 *
 * Each file contains the full review list, score breakdown,
 * audience detail, and metadata that the mobile app loads
 * on-demand when a user taps into a show detail page.
 *
 * Generates: public/data/shows/{show-id}.json
 * Run: node scripts/generate-mobile-show-details.js
 *
 * Pairs with generate-mobile-data.js which produces the
 * browse-level mobile-shows.json. This script adds the
 * detail-level data that's too large for the browse file.
 */

const fs = require('fs');
const path = require('path');
const { computeCriticScore } = require('./lib/compute-critic-score');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data/shows');

// Schema version — bump when per-show detail format changes
const DETAIL_SCHEMA_VERSION = 1;

// ===========================================
// LOAD DATA
// ===========================================
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

let shows = [];
let reviews = [];
let outletRegistry = {};
let audienceBuzz = {};

try {
  shows = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf-8')).shows || [];
} catch (err) {
  console.warn('⚠ shows.json not found');
  process.exit(1);
}

try {
  reviews = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf-8')).reviews || [];
} catch (err) {
  console.warn('⚠ reviews.json not found');
}

try {
  outletRegistry = JSON.parse(fs.readFileSync(path.join(dataDir, 'outlet-registry.json'), 'utf-8')).outlets || {};
} catch (err) {
  console.warn('⚠ outlet-registry.json not found');
}

try {
  audienceBuzz = JSON.parse(fs.readFileSync(path.join(dataDir, 'audience-buzz.json'), 'utf-8')).shows || {};
} catch (err) {
  console.warn('⚠ audience-buzz.json not found');
}

// ===========================================
// INDEX DATA
// ===========================================
const reviewsByShow = {};
for (const review of reviews) {
  if (!reviewsByShow[review.showId]) reviewsByShow[review.showId] = [];
  reviewsByShow[review.showId].push(review);
}

const TOP_CRITICS = new Set([
  'Jesse Green', 'Ben Brantley', 'Charles Isherwood', 'David Rooney',
  'Hilton Als', 'Helen Shaw', 'Peter Marks', 'Elisabeth Vincentelli',
  'Adam Feldman', 'Linda Winer', 'Alexis Soloski', 'Sara Holdren',
  'Johnny Oleksinski', 'Chris Jones',
]);

function getOutletTier(outletId) {
  if (!outletId) return 3;
  const entry = outletRegistry[outletId.toLowerCase().trim()];
  return entry?.tier || 3;
}

function getOutletDisplayName(outletId, fallback) {
  if (!outletId) return fallback || 'Unknown';
  const entry = outletRegistry[outletId.toLowerCase().trim()];
  return entry?.displayName || fallback || outletId;
}

// ===========================================
// GENERATE PER-SHOW DETAIL FILES
// ===========================================

// Use the same visibility filter as generate-mobile-data.js
const showsWithScores = new Set();
for (const review of reviews) {
  if (review.assignedScore != null) showsWithScores.add(review.showId);
}
const visibleShows = shows.filter(show =>
  showsWithScores.has(show.id) || show.status !== 'closed'
);

let generated = 0;
let totalSize = 0;

for (const show of visibleShows) {
  const showReviews = reviewsByShow[show.id] || [];
  const buzz = audienceBuzz[show.id];

  // Score breakdown — use score thresholds to match badge colors on the site
  // 65+ = Positive (blue/green/gold badge), 40-64 = Mixed (orange badge), <40 = Negative (red badge)
  const breakdown = { positive: 0, mixed: 0, negative: 0 };
  for (const r of showReviews) {
    if (r.assignedScore >= 65) breakdown.positive++;
    else if (r.assignedScore >= 40) breakdown.mixed++;
    else breakdown.negative++;
  }

  // Individual reviews — sorted by tier (T1 first), then score descending
  const reviewEntries = showReviews
    .filter(r => r.assignedScore != null)
    .map(r => {
      const isTopCritic = !!(r.criticName && TOP_CRITICS.has(r.criticName));
      const tier = isTopCritic ? 1 : getOutletTier(r.outletId);

      const entry = {
        cn: r.criticName || null,           // criticName
        o: getOutletDisplayName(r.outletId, r.outlet), // outlet display name
        s: r.assignedScore,                 // score (0-100)
        b: r.bucket,                        // bucket (Positive/Mixed/Negative)
        t: tier,                            // tier (1/2/3)
      };

      // Optional fields — omit if null/empty to save bytes
      if (r.url) entry.u = r.url;
      if (r.publishDate) entry.d = r.publishDate;
      if (r.pullQuote) entry.q = r.pullQuote;
      if (r.designation) entry.dg = r.designation;

      return entry;
    })
    .sort((a, b) => {
      // Sort: T1 first, then by score descending
      if (a.t !== b.t) return a.t - b.t;
      return b.s - a.s;
    });

  // PullQuote dedup: if two reviews share the same quote text, null out the duplicate.
  // First occurrence wins (higher-tier, higher-score due to sort order above).
  const seenQuotes = new Set();
  for (const entry of reviewEntries) {
    if (entry.q) {
      if (seenQuotes.has(entry.q)) {
        delete entry.q;
      } else {
        seenQuotes.add(entry.q);
      }
    }
  }

  // Audience detail
  let audienceDetail = null;
  if (buzz && buzz.combinedScore != null) {
    audienceDetail = {
      score: buzz.combinedScore,
      designation: buzz.designation || null,
    };

    if (buzz.sources) {
      // Minified key map for mobile app payload
      const KEY_MAP = { showScore: 'ss', mezzanine: 'mz', reddit: 'rd', theatr: 'th', broadwayCom: 'bc', seatplan: 'sp', lbo: 'lb' };
      const sources = {};
      for (const [key, data] of Object.entries(buzz.sources)) {
        if (!data || data.score == null) continue;
        const minKey = KEY_MAP[key] || key;
        const entry = { s: data.score, c: data.reviewCount };
        if (data.starRating) entry.sr = data.starRating;
        if (data.totalPosts) entry.tp = data.totalPosts;
        if (data.sentiment) entry.sent = data.sentiment;
        sources[minKey] = entry;
      }
      if (Object.keys(sources).length > 0) {
        audienceDetail.sources = sources;
      }
    }
  }

  // Compute composite score using shared module (matches engine.ts)
  const scoreResult = computeCriticScore(showReviews, outletRegistry);

  // Minimum review thresholds per market (matches src/config/score-buckets.ts)
  const MIN_REVIEWS = 5;
  const MIN_REVIEWS_OFF_BROADWAY = 3;
  const MIN_REVIEWS_WEST_END = 5;
  const MIN_REVIEWS_OFF_WEST_END = 3;
  const T3_ONLY_EXTRA = 2;
  let minReviews = show.category === 'off-broadway' ? MIN_REVIEWS_OFF_BROADWAY
    : show.category === 'off-west-end' ? MIN_REVIEWS_OFF_WEST_END
    : show.category === 'west-end' ? MIN_REVIEWS_WEST_END
    : MIN_REVIEWS;
  // T3-only shows need extra reviews
  if (scoreResult && scoreResult.t1 === 0) {
    // Check if there are any T2 reviews
    const t2Count = reviewEntries.filter(r => r.t === 2).length;
    if (t2Count === 0) minReviews += T3_ONLY_EXTRA;
  }
  const hasEnough = scoreResult && scoreResult.rc >= minReviews;

  // Build detail object
  const detail = {
    _v: DETAIL_SCHEMA_VERSION,
    id: show.id,
  };

  // Category (for market-aware display)
  if (show.category) {
    detail.cat = show.category;
  }

  // Composite score + review count (only if meets minimum threshold)
  if (scoreResult && hasEnough) {
    detail.cs = scoreResult.s;
    detail.rc = scoreResult.rc;
  }

  // Score breakdown (always include if reviews exist — shows review sentiment even pre-score)
  if (showReviews.length > 0) {
    detail.bd = breakdown;
  }

  // Reviews list
  if (reviewEntries.length > 0) {
    detail.rv = reviewEntries;
  }

  // Audience detail
  if (audienceDetail) {
    detail.au = audienceDetail;
  }

  // Hero image (not in mobile-shows.json)
  // Reconcile: if shows.json says hero is null but hero.webp exists on disk, use it.
  // This prevents fetch-show-images-auto.js re-runs from wiping local hero paths.
  let heroPath = show.images?.hero;
  if (!heroPath && show.id) {
    const showDir = path.join(__dirname, '..', 'public', 'images', 'shows', show.id);
    for (const ext of ['webp', 'jpg', 'png']) {
      const diskHero = path.join(showDir, `hero.${ext}`);
      if (fs.existsSync(diskHero)) {
        heroPath = `/images/shows/${show.id}/hero.${ext}`;
        break;
      }
    }
  }
  if (heroPath) {
    detail.hi = heroPath;
  }

  // Theater address
  if (show.theaterAddress) {
    detail.ta = show.theaterAddress;
  }

  // Previews start date
  if (show.previewsStartDate) {
    detail.pd = show.previewsStartDate;
  }

  // Cast — read from data/cast/{show-id}.json if available
  const castFile = path.join(dataDir, 'cast', `${show.id}.json`);
  try {
    if (fs.existsSync(castFile)) {
      const castData = JSON.parse(fs.readFileSync(castFile, 'utf-8'));
      const castList = castData.openingNightCast || [];
      if (castList.length > 0) {
        detail.ca = castList.map(c => ({ n: c.name, r: c.role }));
      }
    }
  } catch { /* skip if cast file is malformed */ }

  // Write file
  const filePath = path.join(outputDir, `${show.id}.json`);
  const json = JSON.stringify(detail);
  fs.writeFileSync(filePath, json);
  generated++;
  totalSize += json.length;
}

const avgSize = generated > 0 ? (totalSize / generated / 1024).toFixed(1) : 0;
const totalKB = (totalSize / 1024).toFixed(0);

console.log(`✓ Generated ${generated} show detail files (${totalKB}KB total, ${avgSize}KB avg)`);
console.log(`  Output: ${outputDir}/`);
