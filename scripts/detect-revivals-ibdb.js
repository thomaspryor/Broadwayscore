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
    // Filter to target category (Broadway shows have no category field)
    if (categoryFilter === 'broadway') {
      shows = shows.filter(s => !s.category);
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

    if (result.isRevival) {
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

    // Checkpoint every N shows (write ibdbRevivalChecked even in dry-run to track progress)
    if (!dryRun && checked.length % CHECKPOINT_INTERVAL === 0) {
      console.log(`\n💾 Checkpoint: saving progress (${checked.length} checked)...`);
      for (const id of checked) {
        const showRecord = data.shows.find(s => s.id === id);
        if (showRecord) showRecord.ibdbRevivalChecked = true;
      }
      // Apply revival changes found so far
      for (const c of changes) {
        const showRecord = data.shows.find(s => s.id === c.id);
        if (showRecord) {
          showRecord.isRevival = true;
          if (!showRecord.tags) showRecord.tags = [];
          // Strip any stale "new" tag from creation-time classification — a show
          // can't be both (Galileo 2026-08-14 shipped with tags:["new","revival"]).
          showRecord.tags = showRecord.tags.filter(t => t !== 'new');
          if (!showRecord.tags.includes('revival')) showRecord.tags.push('revival');
        }
      }
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
    process.exit(1);
  }

  // Apply changes
  if (apply) {
    for (const id of checked) {
      const showRecord = data.shows.find(s => s.id === id);
      if (showRecord) showRecord.ibdbRevivalChecked = true;
    }
    for (const c of changes) {
      const showRecord = data.shows.find(s => s.id === c.id);
      if (showRecord) {
        showRecord.isRevival = true;
        if (!showRecord.tags) showRecord.tags = [];
        // Strip any stale "new" tag from creation-time classification — a show
        // can't be both (Galileo 2026-08-14 shipped with tags:["new","revival"]).
        showRecord.tags = showRecord.tags.filter(t => t !== 'new');
        if (!showRecord.tags.includes('revival')) showRecord.tags.push('revival');
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
