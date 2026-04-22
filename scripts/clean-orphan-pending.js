#!/usr/bin/env node
/**
 * One-shot cleanup of orphaned files in data/review-texts/_pending/.
 *
 * Context: opening-night-poller rediscoveries + historical scraping passes can
 * create _pending files that duplicate reviews ALREADY present in the main
 * show directory. These orphans never get enriched (collect-review-texts.js
 * doesn't scan _pending/ per memory/feedback_express_coverage_gaps.md) and
 * accumulate across opening nights. Also: synthetic test shows
 * (proof-express-test-2026, cats-express-test-2026) leave pending cruft.
 *
 * Decision matrix per pending file:
 *   1. Show not in shows.json (synthetic test scaffold)            → DELETE
 *   2. URL collides with a file in the main show directory         → compare contentTier, delete lower
 *   3. Outlet+critic collision with a named-critic in main, no URL → DELETE
 *   4. URL not in main AND pending has no fullText, no score       → KEEP (legitimate unenriched discovery)
 *   5. Pending has richer contentTier than main duplicate          → PROMOTE (copy pending → main, delete pending)
 *
 * Default mode: --dry-run (report only). Use --execute to actually delete.
 * Modes:
 *   --only-synthetic    Clean ONLY synthetic test shows (safe first pass)
 *   --execute           Actually delete / promote files (commits per-show)
 *   --show=SHOW_ID      Scope to single show
 *   --verbose           Print every decision, not just deletions
 *
 * Usage:
 *   node scripts/clean-orphan-pending.js                       # dry-run, full corpus
 *   node scripts/clean-orphan-pending.js --only-synthetic      # dry-run, synthetic only
 *   node scripts/clean-orphan-pending.js --execute             # commit deletions
 *   node scripts/clean-orphan-pending.js --show=beaches-2026 --execute
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { decide } = require('./lib/orphan-pending-decision');

const REPO_ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data/review-texts');
const PENDING_DIR = path.join(REVIEW_TEXTS_DIR, '_pending');

const args = process.argv.slice(2);
const CONFIG = {
  execute: args.includes('--execute'),
  onlySynthetic: args.includes('--only-synthetic'),
  verbose: args.includes('--verbose'),
  allowPromote: args.includes('--allow-promote'),
  showFilter: args.find(a => a.startsWith('--show='))?.split('=')[1],
};

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadShowsIndex() {
  const shows = readJson(path.join(REPO_ROOT, 'data/shows.json'));
  const arr = Array.isArray(shows) ? shows : (shows?.shows || []);
  return new Set(arr.map(s => s.id));
}

function loadMainReviewFiles(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = readJson(path.join(dir, f));
      return data ? { filename: f, path: path.join(dir, f), data } : null;
    })
    .filter(Boolean);
}

// Decision logic extracted to scripts/lib/orphan-pending-decision.js (testable).

function perShowCommit(showId, deleted, promoted) {
  if (!CONFIG.execute) return;
  if (deleted.length === 0 && promoted.length === 0) return;
  try {
    const cwd = REVIEW_TEXTS_DIR;
    execSync('git add -A', { cwd, stdio: 'pipe' });
    const msg = `cleanup: ${showId} _pending orphans (${deleted.length} deleted${promoted.length ? `, ${promoted.length} promoted` : ''})`;
    execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd, stdio: 'pipe' });
    console.log(`  ✓ committed ${showId}`);
  } catch (e) {
    console.error(`  ⚠ commit for ${showId} failed: ${e.message}`);
  }
}

async function main() {
  console.log(`mode: ${CONFIG.execute ? 'EXECUTE' : 'DRY-RUN'}${CONFIG.onlySynthetic ? ' (synthetic only)' : ''}`);
  if (!fs.existsSync(PENDING_DIR)) {
    console.log('No _pending directory; nothing to clean.');
    return;
  }
  const showsIndex = loadShowsIndex();
  if (showsIndex.size === 0) {
    console.error('ERROR: could not load shows.json — refusing to run (would delete everything as synthetic).');
    process.exit(2);
  }
  const showDirs = fs.readdirSync(PENDING_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => !CONFIG.showFilter || name === CONFIG.showFilter);

  let totalDeleted = 0, totalPromoted = 0, totalKept = 0;

  for (const showId of showDirs) {
    const pendingShowDir = path.join(PENDING_DIR, showId);
    const pendingFiles = fs.readdirSync(pendingShowDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ file: f, path: path.join(pendingShowDir, f) }));
    if (pendingFiles.length === 0) continue;

    const mainFiles = loadMainReviewFiles(showId);
    const showDeleted = [], showPromoted = [];

    console.log(`\n${showId} (${pendingFiles.length} pending, ${mainFiles.length} main):`);
    for (const { file, path: fpath } of pendingFiles) {
      const data = readJson(fpath);
      if (!data) {
        console.log(`  ? ${file} — unreadable, skipping`);
        continue;
      }
      const decision = decide(showId, data, mainFiles, showsIndex, { onlySynthetic: CONFIG.onlySynthetic, allowPromote: CONFIG.allowPromote });
      if (decision.action === 'delete') {
        console.log(`  − ${file} → DELETE: ${decision.reason}`);
        totalDeleted++;
        showDeleted.push(file);
        if (CONFIG.execute) fs.unlinkSync(fpath);
      } else if (decision.action === 'promote') {
        console.log(`  ↑ ${file} → PROMOTE to ${decision.target.filename}: ${decision.reason}`);
        totalPromoted++;
        showPromoted.push(file);
        if (CONFIG.execute) {
          fs.writeFileSync(decision.target.path, fs.readFileSync(fpath));
          fs.unlinkSync(fpath);
        }
      } else {
        if (CONFIG.verbose) console.log(`  = ${file} → keep: ${decision.reason}`);
        totalKept++;
      }
    }

    // Clean up empty show dir
    if (CONFIG.execute && showDeleted.length + showPromoted.length === pendingFiles.length) {
      try { fs.rmdirSync(pendingShowDir); console.log(`  ✓ removed empty ${pendingShowDir}`); } catch {}
    }

    perShowCommit(showId, showDeleted, showPromoted);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Deleted:  ${totalDeleted}`);
  console.log(`Promoted: ${totalPromoted}`);
  console.log(`Kept:     ${totalKept}`);
  if (!CONFIG.execute) console.log(`\n(dry-run. Re-run with --execute to apply.)`);
}

main().catch(e => { console.error(e); process.exit(1); });
