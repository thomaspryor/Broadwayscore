#!/usr/bin/env node
'use strict';

/**
 * canonicalize-award-categories.js
 *
 * One-off + re-runnable cleanup: collapse synonym-variant award categories in
 * awards.json (e.g. Drama Desk "Outstanding Direction of a Musical" AND
 * "Outstanding Director of a Musical" — the same single award scraped twice).
 * Idempotent. Writes BOTH the public and private awards.json byte-identical via
 * the existing atomic dual-repo writer (see feedback_awards_json_dual_repo).
 *
 * Usage:
 *   node scripts/canonicalize-award-categories.js [--dry-run]
 *   PRIVATE_AWARDS_PATH=/path node scripts/canonicalize-award-categories.js
 */

const fs = require('fs');
const path = require('path');
const {
  canonicalizeAllShows,
  findSynonymDuplicates,
} = require('./lib/award-category-canonical');
const { writeAwardsJsonAtomic } = require('./lib/awards-atomic-write');

const DRY_RUN = process.argv.includes('--dry-run');
const PUBLIC_AWARDS = path.join(__dirname, '..', 'data', 'awards.json');
const PRIVATE_AWARDS = process.env.PRIVATE_AWARDS_PATH
  || path.join(process.env.HOME || '', 'broadway-scorecard-data', 'awards.json');

function main() {
  const awards = JSON.parse(fs.readFileSync(PUBLIC_AWARDS, 'utf8'));
  const shows = awards.shows || awards;

  const dupsBefore = findSynonymDuplicates(shows);
  console.log(`Synonym-duplicate groups before: ${dupsBefore.length}`);

  // Summarize what will collapse, grouped by (ceremony, variant-set).
  const summary = {};
  for (const d of dupsBefore) {
    const key = `${d.ceremony} → "${d.canonical}"  [${[...new Set(d.variants)].sort().join(' | ')}]`;
    summary[key] = (summary[key] || 0) + 1;
  }
  for (const k of Object.keys(summary).sort((a, b) => summary[b] - summary[a])) {
    console.log(`  ${String(summary[k]).padStart(4)}×  ${k}`);
  }

  const changed = canonicalizeAllShows(shows);
  console.log(`\nShows modified: ${changed}`);

  const dupsAfter = findSynonymDuplicates(shows);
  console.log(`Synonym-duplicate groups after:  ${dupsAfter.length}`);
  if (dupsAfter.length > 0) {
    console.error('✗ Canonicalization did not resolve all duplicates:');
    console.error(JSON.stringify(dupsAfter.slice(0, 10), null, 2));
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\n(dry-run — no files written)');
    return;
  }

  if (fs.existsSync(PRIVATE_AWARDS)) {
    const r = writeAwardsJsonAtomic(awards, { publicPath: PUBLIC_AWARDS, privatePath: PRIVATE_AWARDS });
    console.log(`\n✓ Wrote ${PUBLIC_AWARDS} (${r.publicBytes} bytes)`);
    console.log(`✓ Wrote ${PRIVATE_AWARDS} (${r.privateBytes} bytes, byte-identical)`);
  } else {
    fs.writeFileSync(PUBLIC_AWARDS, JSON.stringify(awards, null, 2) + '\n');
    console.log(`\n✓ Wrote ${PUBLIC_AWARDS} (private repo not found — public only)`);
  }
}

main();
