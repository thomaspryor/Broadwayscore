#!/usr/bin/env node
/**
 * One-time script: Sync ibdbUrl from cast files into shows.json
 *
 * The initial backfill stored ibdbUrl in each cast file but didn't
 * write it back to shows.json. This script bridges that gap so
 * future scrapes can skip SERP lookup and go direct to IBDB.
 *
 * Usage: node scripts/backfill-ibdb-urls.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const CAST_DIR = path.join(__dirname, '..', 'data', 'cast');
const dryRun = process.argv.includes('--dry-run');

const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
let synced = 0;
let alreadySet = 0;
let noCastFile = 0;
let noUrl = 0;

for (const show of showsData.shows) {
  const castPath = path.join(CAST_DIR, `${show.id}.json`);

  if (!fs.existsSync(castPath)) {
    noCastFile++;
    continue;
  }

  const castData = JSON.parse(fs.readFileSync(castPath, 'utf8'));

  if (!castData.ibdbUrl) {
    noUrl++;
    continue;
  }

  if (show.ibdbUrl === castData.ibdbUrl) {
    alreadySet++;
    continue;
  }

  if (dryRun) {
    console.log(`Would set: ${show.id} -> ${castData.ibdbUrl}`);
  } else {
    show.ibdbUrl = castData.ibdbUrl;
  }
  synced++;
}

if (!dryRun && synced > 0) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(showsData, null, 2) + '\n');
}

console.log(`ibdbUrl backfill ${dryRun ? '(DRY RUN)' : 'complete'}:`);
console.log(`  Synced:      ${synced}`);
console.log(`  Already set: ${alreadySet}`);
console.log(`  No cast file: ${noCastFile}`);
console.log(`  No IBDB URL: ${noUrl}`);
console.log(`  Total shows: ${showsData.shows.length}`);
