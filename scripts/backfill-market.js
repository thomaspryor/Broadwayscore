#!/usr/bin/env node
'use strict';

/**
 * Backfill the shows.json `market` field from `category` for any show that has
 * category set but market null.
 *
 * Mapping:
 *   category='broadway'      → market='broadway'
 *   category='off-broadway'  → market='broadway'
 *   category='west-end'      → market='west-end'
 *   category='off-west-end'  → market='west-end'
 *
 * Balusters postmortem CLASS 5 (2026-04-21) — 109 open shows had null market
 * while category was set. Orchestrator fell back to broadway with warnings.
 *
 * Usage:
 *   node scripts/backfill-market.js             # dry-run, prints changes
 *   node scripts/backfill-market.js --write     # applies to private data repo
 *   node scripts/backfill-market.js --write --only-open  # only status=open
 *
 * Reads/writes the private broadway-scorecard-data/shows.json file directly.
 * Commit + push is done outside this script.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ONLY_OPEN = args.includes('--only-open');
const SHOWS_PATH = process.env.SHOWS_JSON_PATH
  || path.join(__dirname, '..', 'data', 'shows.json');

function deriveMarket(category) {
  if (category === 'broadway' || category === 'off-broadway') return 'broadway';
  if (category === 'west-end' || category === 'off-west-end') return 'west-end';
  if (category === 'regional') return 'regional';
  return null;
}

function main() {
  if (!fs.existsSync(SHOWS_PATH)) {
    console.error(`shows.json not found at ${SHOWS_PATH}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(SHOWS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const isArrayRoot = Array.isArray(parsed);
  const shows = parsed.shows || parsed;

  const changes = [];
  let skippedNoCategory = 0;

  for (const show of shows) {
    if (ONLY_OPEN && show.status !== 'open') continue;
    if (!show.category) { skippedNoCategory++; continue; }
    const expected = deriveMarket(show.category);
    if (!expected) continue;
    if (show.market && show.market !== expected) {
      console.warn(`CONFLICT ${show.id}: market="${show.market}" but category="${show.category}" expects "${expected}" — leaving as-is.`);
      continue;
    }
    if (!show.market) {
      changes.push({ id: show.id, category: show.category, oldMarket: show.market || null, newMarket: expected });
      show.market = expected;
    }
  }

  console.log(`\nBackfill summary:`);
  console.log(`  Candidate shows inspected: ${shows.filter(s => !ONLY_OPEN || s.status === 'open').length}`);
  console.log(`  Skipped (no category):     ${skippedNoCategory}`);
  console.log(`  Changes to apply:          ${changes.length}`);
  if (changes.length > 0) {
    const sample = changes.slice(0, 10);
    for (const c of sample) {
      console.log(`    ${c.id}: category=${c.category} → market=${c.newMarket}`);
    }
    if (changes.length > sample.length) {
      console.log(`    ... and ${changes.length - sample.length} more`);
    }
  }

  if (!WRITE) {
    console.log(`\nDry-run only. Pass --write to apply.`);
    return;
  }
  if (changes.length === 0) {
    console.log(`\nNo changes needed.`);
    return;
  }
  const out = isArrayRoot ? shows : { ...parsed, shows };
  fs.writeFileSync(SHOWS_PATH, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${changes.length} change(s) to ${SHOWS_PATH}`);
}

main();
