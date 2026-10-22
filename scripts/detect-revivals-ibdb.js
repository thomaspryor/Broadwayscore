#!/usr/bin/env node
/**
 * IBDB Revival Detection Backfill
 *
 * Checks IBDB for prior productions of Off-Broadway shows to detect revivals.
 * Uses SERP queries to find multiple production pages — if 2+ exist, it's a revival.
 *
 * Usage:
 *   node scripts/detect-revivals-ibdb.js [options]
 *
 * Options:
 *   --dry-run       Show what would change without modifying files (DEFAULT)
 *   --apply         Actually write changes to shows.json
 *   --force         Allow >5 shows to change (required with --apply when many changes)
 *   --show=SLUG     Only process a specific show by slug/id
 *   --category=CAT  Filter by category (default: off-broadway)
 */

const fs = require('fs');
const path = require('path');
const { checkIBDBForPriorProductions } = require('./lib/ibdb-dates');
const showsWriteGuard = require('./lib/shows-write-guard');
const { syncRevivalTags } = require('./lib/revival-tags');
const { isBroadwayCategory } = require('./lib/venue-classification');
const { shouldAcceptIbdbRevival } = require('./lib/revival-cross-reference');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `detect-revivals-ibdb.js — IBDB Revival Detection Backfill.

Usage:
  node scripts/detect-revivals-ibdb.js [options]
  node scripts/detect-revivals-ibdb.js --help, -h    print this usage and exit
`;
// hygiene-help-flag-ok: audit-help-flag-safety.js's risky-call regex matches this file's own local saveShows(data) wrapper DECLARATION (`function saveShows(data) {`), not a call — the wrapper is only invoked from inside main(), well after the --help guard. Verified: node <this file> --help exits immediately with no fs/network side effects.
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const RATE_LIMIT_MS = 1500;
const CHECKPOINT_INTERVAL = 10;

// Parse arguments
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const force = args.includes('--force');
const dryRun = !apply; // dry-run is the default

const showArg = args.find(a => a.startsWith('--show='));
const showFilter = showArg ? showArg.split('=')[1] : null;

const catArg = args.find(a => a.startsWith('--category='));
const categoryFilter = catArg ? catArg.split('=')[1] : 'off-broadway';
// Broadway shows have no category field — use --category=broadway to target them

function loadShows() {
  return showsWriteGuard.loadShows();
}

function saveShows(data) {
  showsWriteGuard.saveShows(data);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Mark checked shows done, except the ones whose revival finding is pending. */
function markChecked(data, checked, pending) {
  const pendingIds = new Set(pending.map(c => c.id));
  for (const id of checked) {
    if (pendingIds.has(id)) continue;
    const showRecord = data.shows.find(s => s.id === id);
    if (showRecord) showRecord.ibdbRevivalChecked = true;
  }
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('='.repeat(60));
  console.log('IBDB REVIVAL DETECTION');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN (use --apply to write)' : 'LIVE'}`);
  if (showFilter) console.log(`Show filter: ${showFilter}`);
  console.log(`Category filter: ${categoryFilter}`);
  console.log('');

  const data = loadShows();
  let shows = data.shows;

  // Apply filters
  if (showFilter) {
    shows = shows.filter(s => s.slug === showFilter || s.id === showFilter);
    if (shows.length === 0) {
      console.error(`❌ No show found with slug/id: ${showFilter}`);
      process.exit(1);
    }
  } else {
    // Filter to target category. Broadway entries now carry category 'broadway'
    // (legacy ones have none), so `!s.category` alone matched almost nothing.
    if (categoryFilter === 'broadway') {
      shows = shows.filter(isBroadwayCategory);
    } else {
      shows = shows.filter(s => s.category === categoryFilter);
    }

    // Only check shows that haven't been checked and aren't already marked as revivals
    shows = shows.filter(s =>
      !s.ibdbRevivalChecked &&
      (s.isRevival === undefined || s.isRevival === false)
    );

    // Skip specials (concerts, revues, etc.)
    shows = shows.filter(s => s.type !== 'special');
  }

  console.log(`Shows to check: ${shows.length}`);
  console.log('');

  if (shows.length === 0) {
    console.log('✅ No shows need revival checking');
    return;
  }

  const changes = [];
  const checked = [];

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    console.log(`\n📌 [${i + 1}/${shows.length}] Checking "${show.title}" (${show.id})...`);

    const showYear = show.openingDate ? parseInt(show.openingDate.split('-')[0]) :
                     show.previewsStartDate ? parseInt(show.previewsStartDate.split('-')[0]) : null;
    const showCategory = show.category || 'broadway';
    const result = await checkIBDBForPriorProductions(show.title, { currentYear: showYear, showCategory });

    // Unsearched is not checked: leave it for the next run.
    if (result.searchFailed) {
      console.log(`  ⚠️  Search failed; "${show.title}" stays unchecked`);
      if (i < shows.length - 1) await sleep(RATE_LIMIT_MS);
      continue;
    }

    if (result.isRevival && !shouldAcceptIbdbRevival(result, show)) {
      console.log(`  ➡️  IBDB title match ignored: synopsis describes a new work`);
    } else if (result.isRevival) {
      changes.push({
        id: show.id,
        title: show.title,
        priorProductionCount: result.priorProductionCount,
        urls: result.urls,
        confidence: result.confidence
      });
    } else if (result.isTransfer) {
      console.log(`  ℹ️  "${show.title}" is a transfer (original production), not a revival`);
    }

    checked.push(show.id);

    // Checkpoint every N shows. Only shows with no finding are marked: revival
    // edits wait for the >5 safety gate below, so a gate trip never leaves a
    // partly applied batch behind and the workflow can still push the marks
    // (BRO-5975: discarding them re-queried the same 123 shows every week).
    if (!dryRun && checked.length % CHECKPOINT_INTERVAL === 0) {
      console.log(`\n💾 Checkpoint: saving progress (${checked.length} checked)...`);
      markChecked(data, checked, changes);
      saveShows(data);
    }

    // Rate limit
    if (i < shows.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Report
  console.log('\n');
  console.log('='.repeat(60));
  console.log('📊 Results:');
  console.log('='.repeat(60));
  console.log(`  Shows checked: ${checked.length}`);
  console.log(`  Revivals detected: ${changes.length}`);
  console.log('');

  if (changes.length > 0) {
    console.log('🔄 Detected Revivals:');
    for (const c of changes) {
      console.log(`  ${c.title} (${c.id}) — ${c.priorProductionCount} prior productions [${c.confidence}]`);
      for (const u of c.urls) console.log(`    ${u}`);
    }
    console.log('');
  }

  // Safety gate: require --force if >5 shows change
  if (apply && changes.length > 5 && !force) {
    console.log(`⚠️  ${changes.length} shows would change. Use --force to confirm this many changes.`);
    console.log('   Review the list above first.');
    // Keep the shows that had no finding, so the next run re-checks only the
    // ones a human still has to review. The workflow pushes on gated=true.
    markChecked(data, checked, changes);
    saveShows(data);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'gated=true\n');
    console.log(`   Saved ${checked.length - changes.length} no-finding show(s) as checked; the ${changes.length} above stay pending.`);
    process.exit(1);
  }

  // Apply changes
  if (apply) {
    markChecked(data, checked, []);
    for (const c of changes) {
      const showRecord = data.shows.find(s => s.id === c.id);
      if (showRecord) {
        showRecord.isRevival = true;
        syncRevivalTags(showRecord);
      }
    }
    saveShows(data);
    console.log(`✅ Updated ${changes.length} show(s), marked ${checked.length} as checked`);

    // Run validation
    console.log('\nRunning data validation...');
    try {
      const { execSync } = require('child_process');
      execSync('node scripts/validate-data.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
      console.log('✅ Validation passed');
    } catch (e) {
      console.error('❌ Validation failed! Review changes.');
      process.exit(1);
    }
  } else {
    console.log(`ℹ️  Dry run complete. Use --apply to write changes.`);
    if (changes.length > 5) {
      console.log(`   ⚠️  ${changes.length} changes detected — will require --apply --force`);
    }
  }
}

main()
  .catch(e => {
    console.error('Revival detection failed:', e);
    process.exit(1);
  });
