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
const { writeClosingDate, canWriteClosingDate } = require('./lib/closing-date-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { mayServeDiskImage } = require('./lib/image-source-match');
const { isPhantomImagePath } = require('./lib/show-images');

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

  const today = new Date().toISOString().slice(0, 10);
  let statusIssues = 0;
  let statusDateHealed = 0;

  // BRO-4099: a show marked "closed" whose closing date hasn't passed (the
  // exact bug that caused Spelling Bee to disappear) used to hard-fail(),
  // which aborts EVERY deploy over one bad row — slam-frank-off-broadway-2026
  // sat closed with a stale future closingDate for 12+ hours on 2026-09-23
  // and blocked opening-night reviews for The Last Ship and Cosi fan tutte
  // from ever reaching prod. Self-heal like the other per-show fixers below
  // (orphan images, venue/category, synopsis): the writer is now fixed
  // upstream (update-show-status.js no longer creates this contradiction),
  // so this is a backstop for whatever writer slips one through next. The
  // true closing date is unknown once we're here — same trade-off
  // update-show-status.js's own stale-open auto-close already makes — so
  // clear it rather than guess a date. Respect humanCorrectedClosingDate:
  // a human-locked future date on a closed show is a genuine data conflict
  // that needs a human, but still shouldn't block every OTHER show's deploy.
  for (const show of shows) {
    if (show.status === 'closed' && show.closingDate && show.closingDate > today) {
      if (canWriteClosingDate(show)) {
        const staleDate = show.closingDate;
        writeClosingDate(show, null, `pre-deploy-check self-heal: cleared stale future closingDate on closed show (was ${staleDate})`, { todayStr: today });
        console.log(`   Self-healed "${show.title}" (${show.id}): cleared future closingDate ${staleDate} on closed show`);
        statusDateHealed++;
      } else {
        console.log(`⚠️  "${show.title}" (${show.id}) is marked closed but closingDate ${show.closingDate} is in the future (humanCorrectedClosingDate=true — needs manual review, not auto-healing; deploy proceeds)`);
        statusIssues++;
      }
    }
  }

  if (statusIssues === 0 && statusDateHealed === 0) {
    ok(`Show status/date integrity: ${showCount} shows checked, no contradictions`);
  } else if (statusDateHealed > 0) {
    ok(`Auto-healed ${statusDateHealed} show(s) with a status=closed/future-closingDate contradiction`);
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
  let imageSources = {};
  try { imageSources = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'image-sources.json'), 'utf8')); } catch {}
  let orphansFixed = 0;
  let jpgUpgraded = 0;
  let danglingRefsFixed = 0;
  // A checkout without the image tree must not read as "every file missing".
  const imagesPresent = fs.existsSync(IMAGES_DIR);
  for (const show of shows) {
    if (!show || !show.id) continue;
    const dir = path.join(IMAGES_DIR, show.id);
    // A local path with no file behind it renders a broken image (high-society-
    // west-end-2026's hero.webp, 2026-10-08). Clear it so the fill below can
    // use a file that does exist, or the page falls back to the poster.
    let danglingFixed = false;
    for (const key of ['hero', 'poster', 'thumbnail']) {
      const val = show.images && show.images[key];
      if (imagesPresent && isPhantomImagePath(val)) {
        show.images[key] = null;
        danglingFixed = true;
      }
    }
    if (danglingFixed) danglingRefsFixed++;
    // Check for image files in any format (webp preferred, then jpg, png)
    // A file whose recorded source a person rejected stays off the site.
    const findImage = (name) => {
      if (!mayServeDiskImage(show, imageSources[show.id]?.[name])) return null;
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
  if (danglingRefsFixed > 0) ok(`Cleared image paths with no file behind them on ${danglingRefsFixed} shows`);
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

  // Auto-dedup: remove duplicate rows of the SAME London production (same
  // title+category+venue, no conflicting year, not linked via priorRuns).
  // Runs AFTER venue-category fix so both entries have corrected categories.
  // Only dedup shows with 0 reviews (safe — no data loss). Title-only matching
  // deleted distinct productions from prod (BRO-275) — see lib/london-deploy-dedup.js.
  const { findLondonDuplicatesToRemove } = require('./lib/london-deploy-dedup');
  const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const reviewsByShow = {};
  for (const r of (reviewsData.reviews || reviewsData || [])) {
    reviewsByShow[r.showId] = (reviewsByShow[r.showId] || 0) + 1;
  }
  const toRemove = findLondonDuplicatesToRemove(shows, reviewsByShow);
  if (toRemove.size > 0) {
    showsData.shows = shows.filter(s => !toRemove.has(s.id));
    shows = showsData.shows;
    ok(`Auto-removed ${toRemove.size} duplicate London show(s): ${[...toRemove].join(', ')}`);
  }

  // Bad-synopsis self-heal: strip any synopsis that's an LLM refusal, a generic
  // production-history placeholder ("X is a stage play written by Y"), or stale
  // future-tense transfer copy on an already-open show, before the UI renders
  // it. The UI at src/app/show/[slug]/page.tsx:126 leaks show.synopsis into the
  // SEO meta description, so a bad synopsis on prod is a double hit: bad show
  // page + bad Google snippet. Stripping to null makes the freshness gate flag
  // it as missing, so enrich-wikipedia-synopsis.js refills it on the next run.
  // Shared detector lives in lib/synopsis-validation.js (1536 incident, 2026-06-21).
  // Only strip clear-cut garbage at deploy time. 'invalid' (truncated /
  // marketing) may still be partially useful to a reader, so leave it visible
  // and let enrich-wikipedia-synopsis.js replace it on the next run.
  const { classifyBadSynopsis } = require('./lib/synopsis-validation');
  const HEALABLE = new Set(['refusal', 'placeholder', 'stale']);
  let refusalStripped = 0;
  for (const show of shows) {
    if (!show || typeof show.synopsis !== 'string') continue;
    const { bad, reason } = classifyBadSynopsis(show);
    if (bad && HEALABLE.has(reason)) {
      console.log(`   Stripped ${reason} synopsis from "${show.title}" (${show.id})`);
      show.synopsis = null;
      refusalStripped++;
    }
  }
  if (refusalStripped > 0) ok(`Auto-stripped ${refusalStripped} bad synopsis(es)`);

  // Write shows.json if any fixes were applied
  if (orphansFixed > 0 || jpgUpgraded > 0 || danglingRefsFixed > 0 || categoryFixed > 0 || toRemove.size > 0 || refusalStripped > 0 || statusDateHealed > 0) {
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
  const { shouldWriteDeployWatermark } = require('./lib/corpus-determinism.js');
  const watermarkGate = shouldWriteDeployWatermark(process.env);
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
