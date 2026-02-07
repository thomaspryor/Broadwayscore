#!/usr/bin/env node
/**
 * Split Combined Creative Team Credits
 *
 * One-time pass through all shows to split combined "X and Y" entries
 * into separate entries for individual creator pages.
 *
 * No API calls needed — runs in seconds locally.
 *
 * Usage:
 *   node scripts/split-combined-credits.js [--dry-run] [--show=SLUG]
 */

const fs = require('fs');
const path = require('path');
const { splitCombinedCredits, splitNames, SPLITTABLE_ROLES } = require('./lib/credit-splitting');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const showArg = args.find(a => a.startsWith('--show='));
const showSlug = showArg ? showArg.split('=')[1] : null;

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function main() {
  console.log('='.repeat(60));
  console.log('CREDIT SPLITTING');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (showSlug) console.log(`Show filter: ${showSlug}`);
  console.log('');

  const data = loadShows();
  let totalSplits = 0;
  let showsAffected = 0;

  for (const show of data.shows) {
    if (showSlug && show.slug !== showSlug && show.id !== showSlug) continue;

    const { result, splitCount } = splitCombinedCredits(show.creativeTeam);

    if (splitCount > 0) {
      showsAffected++;
      totalSplits += splitCount;

      console.log(`${show.title} (${show.id}):`);

      // Show what was split — only display splittable roles
      for (const entry of show.creativeTeam || []) {
        if (!SPLITTABLE_ROLES.has(entry.role)) continue;
        const splitResult = splitNames(entry.name);
        if (splitResult) {
          console.log(`  "${entry.name}" [${entry.role}] → ${splitResult.map(n => `"${n}"`).join(' + ')}`);
        }
      }
      console.log(`  (${show.creativeTeam.length} entries → ${result.length} entries)`);
      console.log('');

      if (!dryRun) {
        show.creativeTeam = result;
      }
    }
  }

  if (!dryRun && totalSplits > 0) {
    saveShows(data);
  }

  console.log('-'.repeat(40));
  console.log(`Shows affected: ${showsAffected}`);
  console.log(`Combined entries split: ${totalSplits}`);

  if (dryRun && totalSplits > 0) {
    console.log('\nRun without --dry-run to apply changes.');
  } else if (totalSplits > 0) {
    console.log('\nChanges saved to shows.json');
  } else {
    console.log('\nNo combined entries found to split.');
  }

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `splits=${totalSplits}\n`);
    fs.appendFileSync(outputFile, `shows_affected=${showsAffected}\n`);
  }
}

main();
