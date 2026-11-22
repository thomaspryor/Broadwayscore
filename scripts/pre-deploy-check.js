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
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { healShows } = require('./lib/heal-shows');

const USAGE = `pre-deploy-check.js — Pre-deploy data integrity check that runs before every Vercel build.

Usage:
  node scripts/pre-deploy-check.js [options]
  node scripts/pre-deploy-check.js --help, -h    print this usage and exit
`;
// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

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
  const showsData = loadShows();
  let shows = showsData.shows || showsData;
  if (!Array.isArray(shows)) throw new Error('shows.json is not an array');
  showCount = shows.length;

  // BRO-8056: the self-heals live in lib/heal-shows.js (pure: no fs, no clock)
  // so the show-refresh publisher heals a show exactly like this build does.
  const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  let imageSources = {};
  try { imageSources = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'image-sources.json'), 'utf8')); } catch {}
  const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const reviewsByShow = {};
  for (const r of (reviewsData.reviews || reviewsData || [])) {
    reviewsByShow[r.showId] = (reviewsByShow[r.showId] || 0) + 1;
  }
  const heal = healShows(showsData, {
    today: new Date().toISOString().slice(0, 10),
    // A checkout without the image tree must not read as "every file missing".
    imagesPresent: fs.existsSync(IMAGES_DIR),
    imageExists: (p) => fs.existsSync(path.join(PUBLIC_DIR, p)),
    imageSources,
    reviewCountByShow: reviewsByShow,
  });
  shows = showsData.shows;
  for (const m of heal.messages) {
    if (m.level === 'ok') ok(m.text); else console.log(m.text);
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

  // Write shows.json if any fixes were applied
  if (heal.changed) {
    saveShows(showsData);
  }

  // Dead vercel.json show-redirect self-heal: a hardcoded /show/<a> → /show/<b>
  // redirect runs before the middleware slug map, so a renamed/retired <b>
  // turns <a> into a 404. Drop those rules for this build (the middleware map
  // then resolves <a> if it can). See lib/dead-show-redirects.js (BRO-275).
  try {
    const { findDeadShowRedirects } = require('./lib/dead-show-redirects');
    const vercelPath = path.join(__dirname, '..', 'vercel.json');
    const slugMapPath = path.join(__dirname, '..', 'data', 'slug-redirects-compact.json');
    const vercelRaw = fs.readFileSync(vercelPath, 'utf8');
    const vercelCfg = JSON.parse(vercelRaw);
    // Regenerate the map from the shows.json written above, so a rename since
    // the last committed map can't make a working redirect look dead (prebuild
    // regenerates it again later; this run is idempotent).
    try {
      require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-slug-redirects.js')], { stdio: 'ignore' });
    } catch (e) {
      console.warn(`⚠️  build-slug-redirects.js failed (${e.message}) — dead-redirect check uses the committed map`);
    }
    const slugMap = fs.existsSync(slugMapPath) ? JSON.parse(fs.readFileSync(slugMapPath, 'utf8')) : {};
    const dead = findDeadShowRedirects(vercelCfg.redirects, new Set(shows.map(s => s.slug)), slugMap, new Set(shows.map(s => s.id)));
    if (dead.length > 0) {
      const deadSet = new Set(dead);
      vercelCfg.redirects = vercelCfg.redirects.filter(r => !deadSet.has(r));
      fs.writeFileSync(vercelPath, JSON.stringify(vercelCfg, null, 2) + (vercelRaw.endsWith('\n') ? '\n' : ''));
      ok(`Dropped ${dead.length} vercel.json show redirect(s) to missing slugs: ${dead.map(r => `${r.source} → ${r.destination}`).join(', ')}`);
    }
  } catch (e) {
    console.warn(`⚠️  Dead show-redirect check skipped: ${e.message}`);
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
  // Task #653: same CI gate as rebuild-all-reviews.js. This is the SECOND writer of
  // the shared baseline; a local `node scripts/pre-deploy-check.js` run against this
  // machine's core-data clone would otherwise stamp a count the published corpus
  // never had (observed 19626 vs the real 19368 on 2026-08-02T17:54Z).
  const { evaluateWatermarkWrite } = require('./lib/corpus-determinism.js');
  // BRO-3581: a deploy that passes the 3% check must not also ratchet the
  // baseline down by a catastrophic amount.
  const watermarkGate = evaluateWatermarkWrite({
    env: process.env,
    existingWatermarkCount: watermark?.reviewCount,
    newCount: reviewCount,
  });
  if (watermarkGate.advisory) console.log(`📌 Deploy watermark advisory — ${watermarkGate.advisory}`);
  const newWatermark = { showCount, reviewCount, updatedAt: new Date().toISOString() };
  if (!watermarkGate.write) {
    console.log(`📌 Deploy watermark NOT written — ${watermarkGate.reason}`);
  } else try {
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
