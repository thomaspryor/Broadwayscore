#!/usr/bin/env node
/**
 * check-data-health.js
 *
 * Fast (<1s) sanity check that core private data files are present, valid, and fresh.
 * Run at session start to catch missing/stale data before making data-dependent decisions.
 *
 * Compares local data against committed baseline (data/audit/validation-baseline.json)
 * to detect missing shows/reviews even when files exist but are outdated.
 *
 * Also reports how far the private clone is BEHIND ORIGIN. Age and currency are
 * different questions: on 2026-09-05 a 30-minute-old clone that was 8 commits
 * behind reported "Data healthy", and ~10,700 local tests passed against data
 * CI would never see (CI checks the data repo out at origin). See
 * scripts/lib/data-freshness.js.
 *
 * Exit codes: 0 = healthy, 1 = missing/empty/drift (critical), 2 = stale (warning)
 * Usage: node scripts/check-data-health.js [--fix] [--no-fetch]
 *   --fix       Auto-pull latest data from private repo if stale or missing
 *   --no-fetch  Skip refreshing remote refs (offline). The behind-origin count
 *               then falls back to the local ref and is only a LOWER BOUND, so
 *               "0 behind" no longer proves the clone is current.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { classifyDataFreshness } = require('./lib/data-freshness');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRIVATE_REPO = process.env.BSC_DATA_REPO || path.join(os.homedir(), 'broadway-scorecard-data');
const BASELINE_FILE = path.join(DATA_DIR, 'audit', 'validation-baseline.json');

const CORE_FILES = [
  'shows.json',
  'reviews.json',
  'grosses.json',
  'grosses-history.json',
  'commercial.json',
  'audience-buzz.json',
  'critic-consensus.json',
  'critic-registry.json',
  'outlet-registry.json',
];

const STALE_WARN_HOURS = 4;
const STALE_ERROR_HOURS = 48;
// Allow up to 10% fewer shows/reviews than baseline before flagging drift
const DRIFT_TOLERANCE = 0.10;

const doFix = process.argv.includes('--fix');

let hasCritical = false;
let hasWarning = false;

// ── Step 1: Check file existence and validity ──

const missing = [];
const empty = [];
let oldestMtime = Date.now();

// mtime lies for files that are symlinked into (or cp-skipped as identical to)
// the private data repo: their mtime is the last content change, not the last
// sync. For those, freshness = when the clone's checked-out commit was made.
//
// Deliberately HEAD commit time ONLY — do not fold in FETCH_HEAD's mtime.
// `git fetch` touches FETCH_HEAD on every run, including ones that update
// origin/<branch> without fast-forwarding local HEAD (fetch never merges).
// A prior version took max(FETCH_HEAD mtime, HEAD commit time), so a bare
// fetch made a clone that was days behind report as "synced just now" —
// this silently hid a 3-day-stale reviews.json (missing a live opening-night
// show's reviews entirely) behind "Data healthy: Updated: 0m ago" (2026-09-02
// incident). HEAD commit time only changes on checkout/pull/commit, i.e. on
// an actual sync, so it can't be fooled the same way.
function privateRepoSyncMs() {
  try {
    const head = parseInt(execSync('git log -1 --format=%ct', {
      cwd: PRIVATE_REPO, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).toString().trim(), 10) * 1000;
    return head || null;
  } catch { return null; /* not a clone */ }
}
const repoSyncMs = privateRepoSyncMs();

function matchesPrivateRepo(filePath, stat) {
  // CORE_FILES currently all live at the private repo ROOT; also try data/ so a
  // future subdir move degrades to a compare-miss, not a silent false-stale.
  // A wrong-file candidate is harmless: it can only fail the identity compare.
  for (const counterpart of [
    path.join(PRIVATE_REPO, path.basename(filePath)),
    path.join(PRIVATE_REPO, 'data', path.basename(filePath)),
  ]) {
    try {
      const cstat = fs.statSync(counterpart);
      if (fs.realpathSync(filePath) === fs.realpathSync(counterpart)) return true;
      if (stat.size !== cstat.size) continue;
      if (fs.readFileSync(filePath).equals(fs.readFileSync(counterpart))) return true;
    } catch { /* counterpart missing at this location */ }
  }
  return false;
}

for (const file of CORE_FILES) {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) {
    missing.push(file);
    hasCritical = true;
    continue;
  }

  const stat = fs.statSync(filePath);
  if (stat.size < 10) {
    empty.push(file);
    hasCritical = true;
    continue;
  }

  // Quick JSON parse check for the two critical files
  if (file === 'shows.json' || file === 'reviews.json') {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const items = file === 'shows.json' ? (data.shows || data) : (data.reviews || data);
      if (!Array.isArray(items) || items.length === 0) {
        empty.push(file);
        hasCritical = true;
        continue;
      }
    } catch {
      empty.push(file + ' (invalid JSON)');
      hasCritical = true;
      continue;
    }
  }

  let effectiveMtime = stat.mtimeMs;
  if (repoSyncMs && repoSyncMs > effectiveMtime && matchesPrivateRepo(filePath, stat)) {
    effectiveMtime = repoSyncMs;
  }
  if (effectiveMtime < oldestMtime) {
    oldestMtime = effectiveMtime;
  }
}

// If critical files missing and --fix requested, try to pull
if (hasCritical && doFix) {
  console.log('Attempting to pull core data from private repo...');
  try {
    const setupScript = path.join(__dirname, 'setup-local-data.sh');
    execSync(`bash "${setupScript}"`, { stdio: 'inherit', timeout: 60000 });
    console.log('Data pulled successfully. Re-checking...');
    // Re-run self without --fix to verify
    try {
      execSync(`node "${__filename}"`, { stdio: 'inherit' });
      process.exit(0);
    } catch (e) {
      process.exit(e.status || 1);
    }
  } catch (e) {
    console.error('Auto-fix failed:', e.message);
  }
}

// Report critical missing/empty issues
if (hasCritical) {
  const problems = [];
  if (missing.length) problems.push(`MISSING: ${missing.join(', ')}`);
  if (empty.length) problems.push(`EMPTY/INVALID: ${empty.join(', ')}`);
  console.error(`\u274c ${problems.join(' | ')}`);
  console.error(`  Fix: ./scripts/setup-local-data.sh  (or: node scripts/check-data-health.js --fix)`);
  process.exit(1);
}

// ── Step 2: Compute stats ──

let showCount = 0;
let reviewCount = 0;
const categories = {};

try {
  const showsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
  const shows = showsData.shows || showsData;
  showCount = shows.length;
  for (const s of shows) {
    const cat = s.category || 'broadway';
    categories[cat] = (categories[cat] || 0) + 1;
  }
} catch { /* already validated above */ }

try {
  const reviewsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'reviews.json'), 'utf8'));
  const reviews = reviewsData.reviews || reviewsData;
  reviewCount = reviews.length;
} catch { /* already validated above */ }

const parts = [`${showCount} shows`];
if (categories['broadway']) parts.push(`${categories['broadway']} Broadway`);
if (categories['off-broadway']) parts.push(`${categories['off-broadway']} Off-Broadway`);
if (categories['west-end']) parts.push(`${categories['west-end']} West End`);
if (categories['off-west-end']) parts.push(`${categories['off-west-end']} Off-West End`);
const statsLine = `${parts[0]} (${parts.slice(1).join(', ')}), ${reviewCount} reviews`;

// ── Step 3: Compare against baseline ──

if (fs.existsSync(BASELINE_FILE)) {
  try {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    const driftIssues = [];

    if (baseline.totalShows && showCount < baseline.totalShows * (1 - DRIFT_TOLERANCE)) {
      driftIssues.push(`shows: ${showCount} local vs ${baseline.totalShows} expected`);
    }
    if (baseline.totalReviews && reviewCount < baseline.totalReviews * (1 - DRIFT_TOLERANCE)) {
      driftIssues.push(`reviews: ${reviewCount} local vs ${baseline.totalReviews} expected`);
    }

    if (driftIssues.length > 0) {
      console.error(`\u274c Data drift detected \u2014 local data is behind the baseline:`);
      for (const issue of driftIssues) {
        console.error(`  ${issue}`);
      }
      console.error(`  Fix: ./scripts/setup-local-data.sh  (or: node scripts/check-data-health.js --fix)`);

      if (doFix) {
        console.log('Attempting to pull latest data...');
        try {
          execSync(`bash "${path.join(__dirname, 'setup-local-data.sh')}"`, { stdio: 'inherit', timeout: 60000 });
          try {
            execSync(`node "${__filename}"`, { stdio: 'inherit' });
            process.exit(0);
          } catch (e) {
            process.exit(e.status || 1);
          }
        } catch (e) {
          console.error('Auto-fix failed:', e.message);
        }
      }
      process.exit(1);
    }
  } catch { /* baseline missing or invalid — skip drift check */ }
}

// ── Step 4: Check staleness ──

const ageMs = Date.now() - oldestMtime;
const ageHours = ageMs / (1000 * 60 * 60);
const ageLabel = ageHours < 1 ? `${Math.round(ageHours * 60)}m ago`
  : ageHours < 48 ? `${Math.round(ageHours)}h ago`
  : `${Math.round(ageHours / 24)}d ago`;

// ── Step 5: Currency — how far behind origin? ──
// Age says nothing about currency; see the header note and data-freshness.js.
// Fetch by DEFAULT. Without it, behindCount is computed from the local
// remote-tracking ref, which setup-local-data.sh leaves level with HEAD — so
// the 2026-09-05 clone would have reported 0 behind and this guard would have
// stayed silent through the very incident it exists to catch. One small fetch
// at session start is the price of the check meaning anything. --no-fetch
// opts out for offline work.
const wantFetch = !process.argv.includes('--no-fetch');
let refsFetched = false;
if (wantFetch) {
  try {
    execSync('git fetch origin main', {
      cwd: PRIVATE_REPO, stdio: ['ignore', 'ignore', 'ignore'], timeout: 30000,
    });
    refsFetched = true;
  } catch { /* offline or no remote — behindCount stays a lower bound */ }
}

let behindCount = null;
try {
  behindCount = parseInt(execSync('git rev-list --count HEAD..origin/main', {
    cwd: PRIVATE_REPO, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  }).toString().trim(), 10);
} catch { /* no origin/main ref — classify as unknown */ }

const freshness = classifyDataFreshness({ behindCount, refsFetched });
if (freshness.level === 'behind' || freshness.level === 'far-behind') {
  console.warn(`\u26a0\ufe0f  ${freshness.message}`);
  console.warn(`   Fix: ${freshness.remedy}`);
  console.log(`   ${statsLine} | Updated: ${ageLabel}`);
  process.exit(2);
}


if (ageHours > STALE_ERROR_HOURS) {
  if (doFix) {
    console.log(`Data stale (${ageLabel}). Auto-pulling latest...`);
    try {
      execSync(`bash "${path.join(__dirname, 'setup-local-data.sh')}"`, { stdio: 'inherit', timeout: 60000 });
      try {
        execSync(`node "${__filename}"`, { stdio: 'inherit' });
        process.exit(0);
      } catch (e) {
        process.exit(e.status || 1);
      }
    } catch (e) {
      console.error('Auto-fix failed:', e.message);
    }
  }
  console.warn(`\u26a0\ufe0f  Data very stale (${ageLabel}) \u2014 Run: ./scripts/setup-local-data.sh`);
  console.log(`   ${statsLine}`);
  process.exit(2);
}

if (ageHours > STALE_WARN_HOURS) {
  console.warn(`\u26a0\ufe0f  Data may be stale (${ageLabel}) \u2014 ${statsLine}`);
  process.exit(0); // Warning only, not a failure
}

console.log(`\u2705 Data healthy: ${statsLine} | Updated: ${ageLabel}`);
if (!freshness.trustworthy) {
  // Not a failure: refs simply were not refreshed this run.
  console.log(`   \u2139\ufe0f  ${freshness.message}`);
}
