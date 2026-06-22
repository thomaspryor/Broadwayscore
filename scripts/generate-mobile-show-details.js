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
const crypto = require('crypto');
const { computeCriticScore } = require('./lib/compute-critic-score');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');
const { getTier: getAuthoritativeTier } = require('./lib/outlet-tiers');
const { shouldHideReviews } = require('./lib/should-hide-reviews');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data/shows');

// Schema version — bump when per-show detail format changes
const DETAIL_SCHEMA_VERSION = 1;

// ===========================================
// HASH-GATE (two-layer, per-show)
// ===========================================
// Global Tier-2 hash-gate (one big hash, skip-everything-or-regen-everything)
// shipped 2026-05-23 (commit 521b63c567) but didn't deliver in practice: CI
// workflows commit data files between every deploy, so the global hash always
// mismatched and we always regenerated all 1,345 files.
//
// This per-show variant: every show gets its own fingerprint covering the
// specific slices of data that contribute to ITS output. CI commits that touch
// 1-50 shows of 1,345 invalidate just those — most files skip the regen path.
//
// Two-layer structure:
//   - globalHash: schema version, script source, scripts/lib/*.js, and global
//     data inputs that affect EVERY show (outlet-registry, outlet-tiers,
//     blog-reviews-for-scoring, curated-historical-shows). If globalHash
//     changes, every per-show hash is forced to mismatch (no stale entries
//     can survive).
//   - perShowHash: globalHash + that show's specific slices (its row in
//     shows.json, its reviews subset, its audience-buzz entry, etc.) +
//     its cast/<id>.json file.
//
// Cache file format:
//   { globalHash, schemaVersion, shows: { <show-id>: <hash>, ... },
//     fileCount, timestamp }
// Lives at data/cache/mobile-show-details/last-hash.json (gitignored;
// persisted across CI runs via the .github/workflows/vercel-deploy.yml
// "Cache Next.js build" step which includes data/cache/).
const HASH_CACHE_DIR = path.join(__dirname, '../data/cache/mobile-show-details');
const HASH_CACHE_FILE = path.join(HASH_CACHE_DIR, 'last-hash.json');

// Files that affect ALL shows (folded into globalHash, not per-show)
const GLOBAL_INPUT_FILES = [
  'data/outlet-registry.json',          // outlet display names + tier overrides → every review entry
  'data/blog-reviews-for-scoring.json', // unioned with reviews.json via loadReviewsWithBlog
  'data/curated-historical-shows.json', // affects shouldHideReviews for every show
  'src/config/outlet-tiers.json',       // authoritative tier resolution for every outlet
];

function hashFileIfExists(hash, relPath) {
  const full = path.join(__dirname, '..', relPath);
  if (fs.existsSync(full)) {
    hash.update(relPath);
    hash.update(fs.readFileSync(full));
  }
}

function computeGlobalHash() {
  const hash = crypto.createHash('sha256');
  // Schema version + script source: editing the script or bumping the schema
  // version invalidates every show (correct — output format / logic changed).
  hash.update(`schema=${DETAIL_SCHEMA_VERSION}`);
  hash.update(fs.readFileSync(__filename));
  // Global data files
  for (const rel of GLOBAL_INPUT_FILES) hashFileIfExists(hash, rel);
  // ALL scripts/lib/*.js — catches transitive logic changes
  // (compute-critic-score.js, outlet-tiers.js, etc.). Coarse but correct:
  // any lib edit could affect any show's output.
  const libDir = path.join(__dirname, 'lib');
  if (fs.existsSync(libDir)) {
    const libFiles = fs.readdirSync(libDir).filter(f => f.endsWith('.js')).sort();
    for (const f of libFiles) {
      hash.update(`lib/${f}`);
      hash.update(fs.readFileSync(path.join(libDir, f)));
    }
  }
  return hash.digest('hex');
}

// Per-show inputs: stable across runs because all sources come from
// JSON.parse of files (V8 preserves insertion order). Coerce undefined → null
// before stringify — `JSON.stringify(undefined)` returns the literal undefined,
// not a string, which would corrupt the hash chain on shows missing a slice.
function computePerShowHash(show, globalHash, ctx) {
  const hash = crypto.createHash('sha256');
  hash.update(globalHash);
  hash.update(JSON.stringify(show ?? null));
  hash.update(JSON.stringify(ctx.reviewsByShow[show.id] ?? null));
  hash.update(JSON.stringify(ctx.audienceBuzz[show.id] ?? null));
  hash.update(JSON.stringify(ctx.tonyByShow[show.id] ?? null));
  hash.update(JSON.stringify(ctx.criticConsensus[show.id] ?? null));
  hash.update(JSON.stringify(ctx.showSchedules[show.id] ?? null));
  hash.update(JSON.stringify(ctx.grossesData[show.slug] ?? null));
  hash.update(JSON.stringify(ctx.lotteryRush[show.id] ?? null));
  hash.update(JSON.stringify(ctx.theaterMeta[show.venue] ?? null));
  hash.update(JSON.stringify(ctx.videoReviewsByShow[show.id] ?? null));
  // Cast file: hash content if present, label if absent — keeps "no cast"
  // distinguishable from "empty cast file."
  const castFile = path.join(dataDir, 'cast', `${show.id}.json`);
  if (fs.existsSync(castFile)) {
    hash.update('cast=present');
    hash.update(fs.readFileSync(castFile));
  } else {
    hash.update('cast=absent');
  }
  return hash.digest('hex');
}

function readCachedHash() {
  try { return JSON.parse(fs.readFileSync(HASH_CACHE_FILE, 'utf-8')); }
  catch { return null; }
}

function writeCachedHash(globalHash, showHashes, fileCount) {
  fs.mkdirSync(HASH_CACHE_DIR, { recursive: true });
  fs.writeFileSync(HASH_CACHE_FILE, JSON.stringify({
    globalHash,
    schemaVersion: DETAIL_SCHEMA_VERSION,
    shows: showHashes,
    fileCount,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

const FORCE_REGEN = process.argv.includes('--force') || process.env.FORCE_REGENERATE === '1' || process.env.FORCE_REGENERATE === 'true';

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

// Uses shared loader so mobile/public show JSON scores exactly match the
// Next.js show page (src/lib/data-core.ts). See scripts/lib/load-reviews-with-blog.js.
reviews = loadReviewsWithBlog();
if (reviews.length === 0) {
  console.warn('⚠ reviews.json not found or empty');
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

// Tony Award nominations — keyed by showId
let tonyByShow = {};
try {
  const tonyData = JSON.parse(fs.readFileSync(path.join(dataDir, 'tony-nominations.json'), 'utf-8'));
  for (const nom of (tonyData.nominations || [])) {
    if (!nom.showId) continue;
    if (!tonyByShow[nom.showId]) tonyByShow[nom.showId] = [];
    tonyByShow[nom.showId].push({
      yr: nom.ceremony,
      cat: nom.category,
      n: nom.name === '(show-level)' ? null : nom.name,
      w: nom.won ? true : undefined,  // omit false to save bytes
    });
  }
  const tonyShows = Object.keys(tonyByShow).length;
  console.log(`✓ Tony nominations: ${tonyShows} shows`);
} catch (err) {
  console.warn('⚠ tony-nominations.json not found — Tony data will be skipped');
}

// Critic consensus — keyed by showId
let criticConsensus = {};
try {
  criticConsensus = JSON.parse(fs.readFileSync(path.join(dataDir, 'critic-consensus.json'), 'utf-8')).shows || {};
  console.log(`✓ Critic consensus: ${Object.keys(criticConsensus).length} shows`);
} catch (err) {
  console.warn('⚠ critic-consensus.json not found — Critics Take will be skipped');
}

// Show schedules — keyed by showId
let showSchedules = {};
try {
  showSchedules = JSON.parse(fs.readFileSync(path.join(dataDir, 'show-schedules.json'), 'utf-8')).shows || {};
  console.log(`✓ Show schedules: ${Object.keys(showSchedules).length} shows`);
} catch (err) {
  console.warn('⚠ show-schedules.json not found — Showtimes will be skipped');
}

// Box office grosses — keyed by show slug
let grossesData = {};
try {
  grossesData = JSON.parse(fs.readFileSync(path.join(dataDir, 'grosses.json'), 'utf-8')).shows || {};
  console.log(`✓ Grosses: ${Object.keys(grossesData).length} shows`);
} catch (err) {
  console.warn('⚠ grosses.json not found — Box Office will be skipped');
}

// Lottery / Rush — keyed by showId
let lotteryRush = {};
try {
  lotteryRush = JSON.parse(fs.readFileSync(path.join(dataDir, 'lottery-rush.json'), 'utf-8')).shows || {};
  console.log(`✓ Lottery/Rush: ${Object.keys(lotteryRush).length} shows`);
} catch (err) {
  console.warn('⚠ lottery-rush.json not found — Lottery/Rush will be skipped');
}

// Theater metadata: venue name → { seatingSections, venueScores }
let theaterMeta = {};
try {
  const rawMeta = JSON.parse(fs.readFileSync(path.join(dataDir, 'theater-metadata.json'), 'utf-8'));
  for (const [name, data] of Object.entries(rawMeta)) {
    theaterMeta[name] = data;
  }
  const withSeating = Object.values(theaterMeta).filter(t => t.structuredTips?.seating?.sections?.length > 0).length;
  const withScores = Object.values(theaterMeta).filter(t => t.venueScores).length;
  console.log(`✓ Theater metadata: ${Object.keys(theaterMeta).length} theaters (${withSeating} seating, ${withScores} scores)`);
} catch (err) {
  console.warn('⚠ theater-metadata.json not found — seating/venue data will be skipped');
}

// Video reviews: keyed by show ID → array (indexed 0,1,2...) of review objects
let videoReviewsByShow = {};
try {
  const vr = JSON.parse(fs.readFileSync(path.join(dataDir, 'video-reviews.json'), 'utf-8'));
  for (const [key, val] of Object.entries(vr)) {
    if (key === '_meta' || !Array.isArray(val) && typeof val !== 'object') continue;
    // Each show entry is an object with numeric keys (0,1,2...) acting as array
    const reviews = Object.values(val).filter(r => r && r.videoUrl);
    if (reviews.length > 0) videoReviewsByShow[key] = reviews;
  }
  console.log(`✓ Video reviews: ${Object.keys(videoReviewsByShow).length} shows`);
} catch (err) {
  console.warn('⚠ video-reviews.json not found — video reviews will be skipped');
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
  // Use authoritative tier from outlet-tiers.js (outlet-tiers.json overrides → outlet-registry.json fallback)
  return getAuthoritativeTier(outletId);
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

// Per-show hash gate setup. computePerShowHash() reads from these — bundle
// them into a context object so the helper doesn't depend on hoisted
// globals (and is unit-testable later if we want).
const HASH_CTX = {
  reviewsByShow, audienceBuzz, tonyByShow, criticConsensus,
  showSchedules, grossesData, lotteryRush, theaterMeta, videoReviewsByShow,
};

// Always compute globalHash — needed both for skip decisions AND for writing
// a fresh cache after --force runs (otherwise --force leaves a stale cache
// that would skip-incorrectly on the next non-force run).
const globalHash = computeGlobalHash();
const cachedHashes = FORCE_REGEN ? null : readCachedHash();
// If globalHash invalidated, ignore all per-show entries (treat as cold cache).
// This is the "global invalidation cascade" — every show forced to regen
// when scripts/lib, schema, or global data files change.
const usableCache = (!FORCE_REGEN && cachedHashes?.globalHash === globalHash)
  ? cachedHashes.shows || {}
  : null;
if (FORCE_REGEN) {
  console.log('✓ Force regen requested — bypassing per-show cache');
} else if (!cachedHashes) {
  console.log('✓ No cache file — cold run, every show will regenerate');
} else if (!usableCache) {
  console.log(`✓ Global hash changed (was=${cachedHashes.globalHash?.substring(0,8)}…, now=${globalHash.substring(0,8)}…) — every show will regenerate`);
}

let generated = 0;
let skipped = 0;
let totalSize = 0;
const newShowHashes = {}; // showId → perShowHash for ALL processed shows (skipped + regenerated)
const invariantChecks = new Map(); // showId → expected reviewEntries.length at write time

for (const show of visibleShows) {
  // Per-show hash gate. If usableCache exists and this show's cached hash
  // matches AND the output file is on disk, skip the heavy regen. Carry the
  // hash forward into newShowHashes so the NEXT run can also skip this show
  // (without this, skipped shows would silently drop out of cache after one
  // run and force-regen on the run after — the bug Claude reviewer flagged).
  if (usableCache) {
    const cachedHash = usableCache[show.id];
    if (cachedHash) {
      const perShowHash = computePerShowHash(show, globalHash, HASH_CTX);
      const filePath = path.join(outputDir, `${show.id}.json`);
      if (cachedHash === perShowHash && fs.existsSync(filePath)) {
        newShowHashes[show.id] = perShowHash; // carry forward
        skipped++;
        continue;
      }
    }
  }

  const allShowReviews = reviewsByShow[show.id] || [];

  // Critic-level dedup: keep one review per (outlet, critic) pair, most recent by
  // publishDate. Matches src/lib/engine.ts computeCriticScore() which keeps
  // distinct critics from the same outlet (NYSR, NYT, etc. publish multiple critics).
  // Previous outlet-level dedup was wrong — it dropped second critics (e.g. Sommers
  // when Finkle existed for NYSR on Titanique opening night 2026-04-12).
  const byCriticKey = new Map();
  for (const review of allShowReviews) {
    const outletKey = (review.outletId || review.outlet || 'unknown').toLowerCase();
    const criticKey = (review.criticName || 'unknown').toLowerCase();
    const key = `${outletKey}|${criticKey}`;
    const existing = byCriticKey.get(key);
    if (!existing || (review.publishDate || '') > (existing.publishDate || '')) {
      byCriticKey.set(key, review);
    }
  }
  const showReviews = Array.from(byCriticKey.values());
  const buzz = audienceBuzz[show.id];

  // Score breakdown — Positive = Recommended+ (75+), Mixed = Worth Seeing/Skippable (55-74), Negative = Critical Miss (<55)
  const breakdown = { positive: 0, mixed: 0, negative: 0 };
  for (const r of showReviews) {
    if (r.assignedScore >= 75) breakdown.positive++;
    else if (r.assignedScore >= 55) breakdown.mixed++;
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
      // Per-source minimum-volume gates (mirrors scripts/lib/audience-weighting.js).
      // Without these, sources with too little signal (e.g., Theatr with 1 vote)
      // render as misleading "100% / 1 vote" cards next to real data.
      const { MIN_THEATR_VOTES } = require('./lib/audience-weighting');
      const sources = {};
      for (const [key, data] of Object.entries(buzz.sources)) {
        if (!data || data.score == null) continue;
        if (key === 'theatr' && (data.reviewCount || 0) < MIN_THEATR_VOTES) continue;
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

  // Compute composite score using shared module (matches engine.ts).
  // shouldHideReviews mirrors src/config/scoring.ts → engine.ts:676. Pre-2005
  // closed shows (not in CURATED_HISTORICAL_SHOWS) get null criticScore so the
  // per-show JSON matches what the market list pages render. Announced shows
  // also suppressed — any reviews on file belong to a prior production.
  // Notion 362637c5-416f-8132 audited this asymmetry 2026-05-16.
  const hideReviews = shouldHideReviews(show) || show.status === 'announced';
  const scoreResult = hideReviews ? null : computeCriticScore(showReviews, outletRegistry, show.category, show.type);

  // Minimum review thresholds per market (matches src/config/score-buckets.ts)
  const MIN_REVIEWS = 5;
  const MIN_REVIEWS_OFF_BROADWAY = 3;
  const MIN_REVIEWS_WEST_END = 5;
  const MIN_REVIEWS_OFF_WEST_END = 3;
  const T3_ONLY_EXTRA = 2;
  let minReviews = show.category === 'off-broadway' ? MIN_REVIEWS_OFF_BROADWAY
    : show.category === 'off-west-end' ? MIN_REVIEWS_OFF_WEST_END
    : show.category === 'west-end' ? MIN_REVIEWS_WEST_END
    : show.category === 'regional' ? MIN_REVIEWS_OFF_BROADWAY
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

  // Tony Award nominations/wins — wins first, then noms, cap at 25
  const tonyNoms = tonyByShow[show.id];
  if (tonyNoms && tonyNoms.length > 0) {
    const sorted = [...tonyNoms].sort((a, b) => (b.w ? 1 : 0) - (a.w ? 1 : 0));
    detail.tn = sorted.slice(0, 25);
  }

  // Critics' Take consensus paragraph
  const consensus = criticConsensus[show.id];
  if (consensus && consensus.text) {
    detail.cn = { t: consensus.text, rc: consensus.reviewCount || 0 };
  }

  // Showtimes weekly grid (most-recent week only — keeps payload small)
  const schedule = showSchedules[show.id];
  if (schedule && schedule.weeks && Object.keys(schedule.weeks).length > 0) {
    const weekKeys = Object.keys(schedule.weeks).sort();
    const latest = weekKeys[weekKeys.length - 1];
    detail.sh = { wk: latest, days: schedule.weeks[latest] };
  }

  // Box Office grosses (keyed by slug, not id)
  const grosses = grossesData[show.slug];
  if (grosses) {
    const tw = grosses.thisWeek;
    detail.bo = {
      tw: tw ? {
        g: tw.gross ?? null,
        c: tw.capacity ?? null,
        a: tw.atp ?? null,
        gp: tw.grossPrevWeek ?? null,
        cp: tw.capacityPrevWeek ?? null,
        ap: tw.atpPrevWeek ?? null,
      } : null,
      at: grosses.allTime ? {
        g: grosses.allTime.gross ?? null,
        p: grosses.allTime.performances ?? null,
        a: grosses.allTime.attendance ?? null,
      } : null,
    };
  }

  // Lottery / Rush
  const lr = lotteryRush[show.id];
  if (lr) {
    const pick = (x) => x ? {
      p: x.price ?? null, t: x.time ?? null, loc: x.location ?? null,
      inst: x.instructions ?? null, url: x.url ?? null, pl: x.platform ?? null,
    } : undefined;
    const obj = {};
    if (lr.lottery) obj.lo = pick(lr.lottery);
    if (lr.rush) obj.ru = pick(lr.rush);
    if (lr.digitalRush) obj.dr = pick(lr.digitalRush);
    if (lr.studentRush) obj.sr = pick(lr.studentRush);
    if (lr.standingRoom) obj.so = pick(lr.standingRoom);
    if (Object.keys(obj).length > 0) detail.lr = obj;
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

  // Seating sections + venue scores — look up by venue name
  const theater = show.venue ? theaterMeta[show.venue] : null;
  if (theater) {
    const sections = theater.structuredTips?.seating?.sections;
    if (sections?.length > 0) {
      detail.sg = sections.map(s => ({
        n: s.name,
        v: s.verdict,
        vl: s.verdictLabel,
        iv: s.isValuePick || false,
        ra: s.rationale || null,
        dp: s.dataPoints || 0,
        rr: s.rowRange || null,
      }));
    }
    if (theater.venueScores) {
      const raw = theater.venueScores;
      detail.vs = {
        sl: raw.sightlines ?? null,
        so: raw.sound ?? null,
        co: raw.comfort ?? null,
        am: raw.ambiance ?? null,
        fa: raw.facilities ?? null,
      };
    }
  }

  // Video reviews
  const showVideoReviews = videoReviewsByShow[show.id];
  if (showVideoReviews?.length > 0) {
    detail.vr = showVideoReviews.slice(0, 8).map(r => ({
      ch: r.creatorName || null,       // channel/creator name
      hd: r.handle || null,            // @handle
      pl: r.platform || null,          // platform (tiktok/youtube/etc)
      u: r.videoUrl,                   // video URL
      s: r.score ?? null,              // score 0-100
      bk: r.bucket || null,            // Rave/Positive/Mixed/Negative
      q: r.keyQuote || null,           // pull quote
      th: r.thumbnail || null,         // thumbnail URL
      pd: r.publishedAt || null,       // publish date
    }));
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
  invariantChecks.set(show.id, reviewEntries.length);
  generated++;
  totalSize += json.length;
  // Record this show's hash so the next run can skip it if inputs unchanged.
  // Computed AFTER write so a write failure (which throws) doesn't leave a
  // stale "we already wrote this" entry in the cache.
  newShowHashes[show.id] = computePerShowHash(show, globalHash, HASH_CTX);
}

// Stage-2→3 invariant: verify each written file's review count matches the
// in-memory reviewEntries array at write time. Catches stale-variable bugs
// (wrong reviewsByShow, dedup logic error) before the data lands in public/.
let invariantErrors = 0;
for (const [showId, expectedCount] of invariantChecks) {
  try {
    const written = JSON.parse(fs.readFileSync(path.join(outputDir, `${showId}.json`), 'utf-8'));
    const actualCount = written.rv ? written.rv.length : 0;
    if (actualCount !== expectedCount) {
      console.error(`✗ Invariant: ${showId} — in-memory reviewEntries=${expectedCount}, written rv=${actualCount}`);
      invariantErrors++;
    }
  } catch (err) {
    console.error(`✗ Invariant: ${showId} — failed to read back: ${err.message}`);
    invariantErrors++;
  }
}
if (invariantErrors > 0) {
  console.error(`✗ Invariant check failed: ${invariantErrors} show(s) have stage-2→3 count mismatches. Aborting.`);
  process.exit(1);
}
console.log(`✓ Invariant: ${generated} written shows pass stage-2→3 counts (${skipped} skipped via hash cache).`);

const avgSize = generated > 0 ? (totalSize / generated / 1024).toFixed(1) : 0;
const totalKB = (totalSize / 1024).toFixed(0);

console.log(`✓ Generated ${generated} show detail files (${totalKB}KB total, ${avgSize}KB avg)`);
console.log(`  Output: ${outputDir}/`);

// Summary line for CI observability (parseable: `cache=… globalHash=… regenerated=N skipped=M total=T`)
const totalProcessed = generated + skipped;
const cacheStatus = FORCE_REGEN
  ? 'force'
  : !cachedHashes ? 'cold'
  : !usableCache ? 'global-invalidate'
  : (skipped === totalProcessed ? 'hit' : (skipped > 0 ? 'partial' : 'miss'));
console.log(`mobile-details: cache=${cacheStatus} globalHash=${(globalHash || '').substring(0, 8)} regenerated=${generated} skipped=${skipped} total=${totalProcessed}`);

// Write per-show hash cache for next run's skip gate. Only persist on
// successful regen (invariant check above process.exit(1)'s on failure, so
// reaching here means output is good). newShowHashes carries forward skipped
// shows' hashes too — without that, the next run would see them as missing
// and force-regen.
try {
  writeCachedHash(globalHash, newShowHashes, totalProcessed);
  console.log(`✓ Hash cache written (globalHash=${globalHash.substring(0, 8)}…, ${Object.keys(newShowHashes).length} shows)`);
} catch (err) {
  console.warn(`⚠ Failed to write hash cache (non-fatal): ${err.message}`);
}
