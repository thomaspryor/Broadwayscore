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
const { normalizeUrl } = require('./lib/url-utils');

const REPO_ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data/review-texts');
const PENDING_DIR = path.join(REVIEW_TEXTS_DIR, '_pending');

const CONTENT_TIER_RANK = {
  complete: 5,
  truncated: 4,
  excerpt: 3,
  stub: 2,
  invalid: 1,
  undefined: 0,
};

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

function decide(showId, pendingFile, pendingData, mainFiles, showsIndex) {
  // Rule 1: show not in shows.json → synthetic test scaffold
  if (!showsIndex.has(showId)) {
    return { action: 'delete', reason: 'synthetic-test-show' };
  }

  if (CONFIG.onlySynthetic) {
    return { action: 'keep', reason: 'not-synthetic (--only-synthetic mode)' };
  }

  const pendingUrl = pendingData.url ? normalizeUrl(pendingData.url) : null;
  const pendingOutlet = pendingData.outletId;
  const pendingTier = CONTENT_TIER_RANK[pendingData.contentTier] ?? 0;

  // Rule 2: URL collision with a main file — compare content tier
  if (pendingUrl) {
    const urlMatch = mainFiles.find(m => {
      const mu = m.data.url ? normalizeUrl(m.data.url) : null;
      return mu && mu === pendingUrl;
    });
    if (urlMatch) {
      const mainTier = CONTENT_TIER_RANK[urlMatch.data.contentTier] ?? 0;
      if (pendingTier > mainTier) {
        // Main may have been DELIBERATELY marked invalid/stub by a guard. Don't
        // automatically promote — flag for manual review instead. Operator can
        // use --allow-promote to override if they've audited the case.
        if (CONFIG.allowPromote) {
          return { action: 'promote', reason: `url-match: pending tier ${pendingData.contentTier} > main tier ${urlMatch.data.contentTier} (--allow-promote)`, target: urlMatch };
        }
        return { action: 'keep', reason: `url-match: pending has richer content than main (${pendingData.contentTier} > ${urlMatch.data.contentTier}) — manual review needed, re-run with --allow-promote to auto-promote` };
      }
      return { action: 'delete', reason: `url-match: main file ${urlMatch.filename} has same-or-better contentTier` };
    }
  }

  // Rule 3: Outlet has a named-critic file AND pending is from a fuzzy source
  // (RSS / site-search often produce false-positive URL matches to other articles
  // at the same outlet — e.g., NYT rss-discovery catching unrelated arts articles).
  // Deliberately NOT firing for source='serp-discovery' since SERP hits are verified
  // and should reach collect-review-texts.js AUTHOR ENRICHMENT to resolve the byline
  // rather than be discarded as duplicates.
  const FUZZY_SOURCES = new Set(['rss-discovery', 'site-search', 'bww-roundup']);
  if (pendingOutlet && FUZZY_SOURCES.has(pendingData.source)) {
    const criticName = (pendingData.criticName || '').toString().toLowerCase().trim();
    if (criticName === 'unknown' || !criticName) {
      const namedCritic = mainFiles.find(m => {
        if (m.data.outletId !== pendingOutlet) return false;
        const mc = (m.data.criticName || '').toString().toLowerCase().trim();
        return mc && mc !== 'unknown';
      });
      if (namedCritic) {
        // Preserve if pending has fullText that named file lacks — don't lose content
        const namedTier = CONTENT_TIER_RANK[namedCritic.data.contentTier] ?? 0;
        if (pendingTier > namedTier && pendingData.fullText && !namedCritic.data.fullText) {
          return { action: 'keep', reason: `outlet-dup but pending has fullText that named file lacks — preserve for manual review` };
        }
        return { action: 'delete', reason: `outlet-dup (fuzzy ${pendingData.source}): ${namedCritic.filename} exists with named critic` };
      }
    }
  }

  return { action: 'keep', reason: 'no-main-duplicate (legitimate unenriched)' };
}

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
      const decision = decide(showId, file, data, mainFiles, showsIndex);
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
