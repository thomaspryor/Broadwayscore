#!/usr/bin/env node
/**
 * Pre-deploy data integrity check.
 * Runs before every Vercel build to catch data problems that would cause
 * visible site issues. Focused and fast — only checks critical invariants.
 *
 * Exit codes:
 *   0 = pass (deploy proceeds)
 *   1 = fail (deploy aborted)
 */

const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const WATERMARK_PATH = path.join(__dirname, '..', 'data', 'audit', 'deploy-watermark.json');

// Max allowed drop from last successful deploy (percentage).
// 916 reviews / 18,239 = 5%. We want to catch losses smaller than that.
const MAX_REVIEW_DROP_PCT = 3;
const MAX_SHOW_DROP_PCT = 3;

let errors = 0;

function fail(msg) {
  errors++;
  console.error(`❌ ${msg}`);
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

// ─────────────────────────────────────────────
// Load watermark from last successful deploy
// ─────────────────────────────────────────────
let watermark = null;
try {
  watermark = JSON.parse(fs.readFileSync(WATERMARK_PATH, 'utf8'));
} catch (e) { /* first run or missing file — use absolute floors only */ }

// ─────────────────────────────────────────────
// 1. shows.json: status/date contradictions + count
// ─────────────────────────────────────────────
let showCount = 0;
try {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  let shows = showsData.shows || showsData;
  if (!Array.isArray(shows)) throw new Error('shows.json is not an array');
  showCount = shows.length;

  const today = new Date().toISOString().slice(0, 10);
  let statusIssues = 0;

  for (const show of shows) {
    // A show marked "closed" whose closing date hasn't passed = something is wrong.
    // This is the exact bug that caused Spelling Bee to disappear.
    if (show.status === 'closed' && show.closingDate && show.closingDate > today) {
      fail(`"${show.title}" (${show.id}) is marked closed but closingDate ${show.closingDate} is in the future`);
      statusIssues++;
    }
  }

  if (statusIssues === 0) {
    ok(`Show status/date integrity: ${showCount} shows checked, no contradictions`);
  }

  // Absolute floor (catastrophic data loss)
  if (showCount < 500) {
    fail(`Only ${showCount} shows (expected 700+). Data may be truncated.`);
  }
  // Regression check against watermark
  if (watermark?.showCount) {
    const lost = watermark.showCount - showCount;
    const pct = (lost / watermark.showCount * 100).toFixed(1);
    if (lost > 0 && parseFloat(pct) > MAX_SHOW_DROP_PCT) {
      fail(`Show count dropped ${lost} (${pct}%) from last deploy: ${watermark.showCount} → ${showCount}`);
    } else {
      ok(`Show count: ${showCount} (watermark: ${watermark.showCount})`);
    }
  } else {
    ok(`Show count: ${showCount} (no watermark yet)`);
  }

  // Orphan image auto-fix: shows with null image references but local files on disk.
  // This catches data/file mismatches from the dedup logic or private repo staleness.
  // Also upgrades .jpg → .webp when a .webp file exists on disk (legacy backfill cleanup).
  const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
  let orphansFixed = 0;
  let jpgUpgraded = 0;
  for (const show of shows) {
    if (!show || !show.id) continue;
    const dir = path.join(IMAGES_DIR, show.id);
    // Check for image files in any format (webp preferred, then jpg, png)
    const findImage = (name) => {
      for (const ext of ['webp', 'jpg', 'png']) {
        if (fs.existsSync(path.join(dir, `${name}.${ext}`))) return `${name}.${ext}`;
      }
      return null;
    };
    const heroFile = findImage('hero');
    const posterFile = findImage('poster');
    const thumbFile = findImage('thumbnail');
    if (!heroFile && !posterFile && !thumbFile) continue;

    if (!show.images) show.images = {};
    let fixed = false;

    // Fix null refs → file on disk
    if (!show.images.hero && heroFile) { show.images.hero = `/images/shows/${show.id}/${heroFile}`; fixed = true; }
    if (!show.images.poster && posterFile) { show.images.poster = `/images/shows/${show.id}/${posterFile}`; fixed = true; }
    if (!show.images.thumbnail && thumbFile) { show.images.thumbnail = `/images/shows/${show.id}/${thumbFile}`; fixed = true; }

    // Upgrade .jpg → .webp when .webp exists on disk
    for (const key of ['hero', 'poster', 'thumbnail']) {
      const val = show.images[key];
      if (val && typeof val === 'string' && val.endsWith('.jpg') && val.startsWith('/images/')) {
        const webpExists = fs.existsSync(path.join(dir, `${key}.webp`));
        if (webpExists) {
          show.images[key] = val.replace(/\.jpg$/, '.webp');
          jpgUpgraded++;
          fixed = true;
        }
      }
    }

    if (fixed) orphansFixed++;
  }
  if (orphansFixed > 0 || jpgUpgraded > 0) {
    if (orphansFixed > 0) ok(`Auto-fixed ${orphansFixed} shows with orphan/outdated image refs`);
    if (jpgUpgraded > 0) ok(`Upgraded ${jpgUpgraded} image paths from .jpg → .webp`);
  }

  // Venue-vs-category auto-fix: WE venues miscategorised as off-west-end (and vice versa).
  // CI rebuilds can revert manual category fixes, so this self-heals on every deploy.
  const { isWestEndVenue, isOffWestEndVenue, isLondonMarket } = require('./lib/venue-classification');
  let categoryFixed = 0;
  for (const show of shows) {
    if (!show.venue || show.venue === 'TBA' || !isLondonMarket(show.category)) continue;
    if (show.category === 'off-west-end' && isWestEndVenue(show.venue)) {
      show.category = 'west-end';
      categoryFixed++;
    } else if (show.category === 'west-end' && isOffWestEndVenue(show.venue)) {
      show.category = 'off-west-end';
      categoryFixed++;
    }
  }
  if (categoryFixed > 0) ok(`Auto-fixed ${categoryFixed} venue/category mismatches`);

  // Auto-dedup: remove exact-title duplicates within the same London market.
  // Runs AFTER venue-category fix so both entries have corrected categories.
  // Only dedup shows with 0 reviews (safe — no data loss).
  const titleKey = (s) => `${s.title}||${s.category}`;
  const statusPriority = { open: 3, previews: 2, upcoming: 1, closed: 0 };
  const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const reviewsByShow = {};
  for (const r of (reviewsData.reviews || reviewsData || [])) {
    reviewsByShow[r.showId] = (reviewsByShow[r.showId] || 0) + 1;
  }
  const seen = new Map();
  const toRemove = new Set();
  for (const show of shows) {
    if (show.category !== 'west-end' && show.category !== 'off-west-end') continue;
    const key = titleKey(show);
    if (seen.has(key)) {
      const prev = seen.get(key);
      const prevReviews = reviewsByShow[prev.id] || 0;
      const currReviews = reviewsByShow[show.id] || 0;
      if (prevReviews === 0 || currReviews === 0) {
        if (currReviews > prevReviews || (currReviews === prevReviews && (statusPriority[show.status] || 0) > (statusPriority[prev.status] || 0))) {
          toRemove.add(prev.id);
          seen.set(key, show);
        } else {
          toRemove.add(show.id);
        }
      }
    } else {
      seen.set(key, show);
    }
  }
  if (toRemove.size > 0) {
    showsData.shows = shows.filter(s => !toRemove.has(s.id));
    shows = showsData.shows;
    ok(`Auto-removed ${toRemove.size} duplicate London show(s): ${[...toRemove].join(', ')}`);
  }

  // Write shows.json if any fixes were applied
  if (orphansFixed > 0 || jpgUpgraded > 0 || categoryFixed > 0 || toRemove.size > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2));
  }

} catch (e) {
  fail(`Cannot read/parse shows.json: ${e.message}`);
}

// ─────────────────────────────────────────────
// 2. reviews.json: count regression check
// ─────────────────────────────────────────────
let reviewCount = 0;
try {
  const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const reviews = reviewsData.reviews || reviewsData;
  if (!Array.isArray(reviews)) throw new Error('reviews.json is not an array');
  reviewCount = reviews.length;

  // Absolute floor (catastrophic data loss)
  if (reviewCount < 10000) {
    fail(`Only ${reviewCount} reviews (expected 14,000+). Data may be truncated.`);
  }
  // Regression check against watermark
  if (watermark?.reviewCount) {
    const lost = watermark.reviewCount - reviewCount;
    const pct = (lost / watermark.reviewCount * 100).toFixed(1);
    if (lost > 0 && parseFloat(pct) > MAX_REVIEW_DROP_PCT) {
      fail(`Review count dropped ${lost} (${pct}%) from last deploy: ${watermark.reviewCount} → ${reviewCount}`);
      console.error(`   If drop is unexpected: check that review-texts checkout is complete.`);
      console.error(`   If drop is intentional: run rebuild to sync the watermark baseline, then re-deploy.`);
      console.error(`   Command: gh workflow run "Rebuild Reviews Data" -f reason="Post-cleanup sync" -f force_write=true`);
    } else {
      ok(`Review count: ${reviewCount} (watermark: ${watermark.reviewCount})`);
    }
  } else {
    ok(`Review count: ${reviewCount} (no watermark yet)`);
  }

} catch (e) {
  fail(`Cannot read/parse reviews.json: ${e.message}`);
}

// ─────────────────────────────────────────────
// 3. Guide content freshness (warning only — doesn't block deploy)
// ─────────────────────────────────────────────
try {
  const guidePath = path.join(__dirname, '..', 'src', 'app', 'guides', 'cheap-broadway-tickets', 'page.tsx');
  const guideContent = fs.readFileSync(guidePath, 'utf8');
  const match = guideContent.match(/lastVerified:\s*['"](\d{4}-\d{2}-\d{2})['"]/);
  if (match) {
    const verified = new Date(match[1]);
    const now = new Date();
    const monthsStale = (now - verified) / (1000 * 60 * 60 * 24 * 30);
    if (monthsStale > 6) {
      console.log(`⚠️  Cheap tickets guide GUIDE_DATA.lastVerified is ${Math.floor(monthsStale)} months old (${match[1]}). Review prices/hours at source.`);
    } else {
      ok(`Guide content freshness: verified ${match[1]} (${Math.floor(monthsStale)}mo ago)`);
    }
  }
} catch (e) {
  // Non-fatal
}

// ─────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────
console.log('');
if (errors > 0) {
  console.error(`🚨 PRE-DEPLOY CHECK FAILED: ${errors} critical issue(s) found. Deploy aborted.`);
  process.exit(1);
} else {
  // Update watermark on success — next deploy will check against these counts.
  const newWatermark = { showCount, reviewCount, updatedAt: new Date().toISOString() };
  try {
    const dir = path.dirname(WATERMARK_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WATERMARK_PATH, JSON.stringify(newWatermark, null, 2) + '\n');
  } catch (e) {
    // Non-fatal — watermark write failure shouldn't block deploy
    console.log(`⚠️  Could not update watermark: ${e.message}`);
  }
  console.log('✅ Pre-deploy check passed. Safe to build.');
  process.exit(0);
}
