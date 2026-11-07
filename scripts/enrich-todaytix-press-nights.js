#!/usr/bin/env node
/**
 * BRO-626 — Enrich WE shows with verified press night dates (todaytix source).
 *
 * Applies the manually-verified corrections/confirmations in
 * scripts/lib/enrich-todaytix-press-nights.js to the West End/Off-West-End
 * shows still collapsed onto their TodayTix first-performance date. See that
 * file's header for why this is a one-off manual pass rather than another
 * scraper: the residual cohort is shows too small for Theatremonkey/Playbill
 * to list and too sparse in reviews.json for the automated cluster
 * inference (scripts/lib/infer-press-night-from-reviews.js, run daily by
 * enrich-west-end-dates.js --fix-unconfirmed) to catch.
 *
 * Usage:
 *   node scripts/enrich-todaytix-press-nights.js [--dry-run]
 *   node scripts/enrich-todaytix-press-nights.js --help, -h    print this usage and exit
 */

'use strict';

const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { computeTodaytixPressNightChanges } = require('./lib/enrich-todaytix-press-nights');

const USAGE = `enrich-todaytix-press-nights.js — BRO-626 WE press-night date enrichment.

Usage:
  node scripts/enrich-todaytix-press-nights.js [options]
  node scripts/enrich-todaytix-press-nights.js --help, -h    print this usage and exit

Options:
  --dry-run    Show what would change without modifying shows.json
`;

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const dryRun = process.argv.includes('--dry-run');

  const data = loadShows();
  const { applied, unresolved } = computeTodaytixPressNightChanges(data.shows);

  console.log('='.repeat(60));
  console.log('BRO-626: TODAYTIX PRESS NIGHT ENRICHMENT');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');
  console.log(`Applied: ${applied.length}`);
  for (const a of applied) {
    console.log(`  ${a.title} (${a.id}) [confidence: ${a.confidence}]`);
    for (const ch of a.changes) {
      console.log(`    ${ch.field}: ${ch.old || 'null'} -> ${ch.new}`);
    }
    console.log(`    source: ${a.citation}`);
  }
  console.log('');
  console.log(`Unresolved (left unchanged): ${unresolved.length}`);
  for (const u of unresolved) {
    console.log(`  ${u.title} (${u.id}): ${u.reason}`);
  }
  console.log('');

  if (applied.length === 0) {
    console.log('No changes to apply.');
    return;
  }

  if (dryRun) {
    console.log(`${applied.length} change(s) would be applied (dry run).`);
    return;
  }

  let updated = 0;
  for (const a of applied) {
    const showRecord = data.shows.find((s) => s.id === a.id);
    if (!showRecord) continue;
    for (const ch of a.changes) {
      showRecord[ch.field] = ch.new;
    }
    updated++;
  }

  saveShows(data);
  console.log(`Updated ${updated} show(s) in shows.json`);

  console.log('');
  console.log('Running data validation...');
  const { execSync } = require('child_process');
  try {
    execSync('node scripts/validate-data.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    console.log('Validation passed');
  } catch (e) {
    console.error('Validation failed! Review changes.');
    process.exitCode = 1;
  }
}

main();
