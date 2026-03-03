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

  // Score breakdown (counts by bucket)
  const breakdown = { positive: 0, mixed: 0, negative: 0 };
  for (const r of showReviews) {
    if (r.bucket === 'Positive' || r.bucket === 'Rave') breakdown.positive++;
    else if (r.bucket === 'Mixed') breakdown.mixed++;
    else if (r.bucket === 'Negative' || r.bucket === 'Pan') breakdown.negative++;
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

  // Audience detail
  let audienceDetail = null;
  if (buzz && buzz.combinedScore != null) {
    audienceDetail = {
      score: buzz.combinedScore,
      designation: buzz.designation || null,
    };

    if (buzz.sources) {
      const sources = {};
      if (buzz.sources.showScore) {
        sources.ss = {
          s: buzz.sources.showScore.score,
          c: buzz.sources.showScore.reviewCount,
        };
      }
      if (buzz.sources.mezzanine) {
        sources.mz = {
          s: buzz.sources.mezzanine.score,
          c: buzz.sources.mezzanine.reviewCount,
          sr: buzz.sources.mezzanine.starRating || null,
        };
      }
      if (buzz.sources.reddit) {
        sources.rd = {
          s: buzz.sources.reddit.score,
          c: buzz.sources.reddit.reviewCount,
          tp: buzz.sources.reddit.totalPosts || 0,
          sent: buzz.sources.reddit.sentiment || null,
        };
      }
      if (Object.keys(sources).length > 0) {
        audienceDetail.sources = sources;
      }
    }
  }

  // Build detail object
  const detail = {
    _v: DETAIL_SCHEMA_VERSION,
    id: show.id,
  };

  // Score breakdown
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
  if (show.images?.hero) {
    detail.hi = show.images.hero;
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
