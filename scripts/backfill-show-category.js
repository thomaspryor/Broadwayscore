#!/usr/bin/env node
/**
 * One-time backfill: stamp category+market on the ~1958 historical Broadway
 * shows that were imported with null category. Closes the convention trap
 * where `s.category === 'broadway'` matches 42/2449 but the site-canonical
 * `!s.category || s.category === 'broadway'` matches 2009/2449.
 *
 * Safe because:
 *   - Only touches shows where category is null/undefined.
 *   - Classifies via validateVenue() — only known canonical BW venues are
 *     stamped 'broadway'. TBA/unknown venues are left alone.
 *   - Off-Broadway venues already have category set; not touched.
 *
 * Reads + writes the file that data/shows.json points to (the symlink
 * resolves to the private broadway-scorecard-data repo; see CLAUDE.md §11).
 *
 * Usage:
 *   node scripts/backfill-show-category.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');

const { validateVenue } = require('./lib/broadway-theaters');
const { classifyShow } = require('./lib/classify-show');

const DRY_RUN = process.argv.includes('--dry-run');

// Resolve to the actual file behind data/shows.json — this is a symlink in the
// public repo that points at the private broadway-scorecard-data repo. Allow
// override via --shows-path=... for testing / worktree usage.
const overrideFlag = process.argv.find(a => a.startsWith('--shows-path='));
const defaultPath = path.join(__dirname, '../data/shows.json');
const targetPath = overrideFlag ? overrideFlag.split('=')[1] : defaultPath;
const showsPath = fs.realpathSync(targetPath);

console.log(`Reading: ${showsPath}`);
const raw = fs.readFileSync(showsPath, 'utf8');
const data = JSON.parse(raw);
const list = data.shows || data;

let stamped = 0;
let skippedTBA = 0;
let skippedUnknownVenue = 0;
let alreadySet = 0;
const unknownVenueSamples = {};

for (const s of list) {
  if (s.category) {
    alreadySet++;
    continue;
  }

  const venueCheck = validateVenue(s.venue);
  if (!venueCheck || !venueCheck.category) {
    if (s.venue === 'TBA') {
      skippedTBA++;
    } else {
      skippedUnknownVenue++;
      unknownVenueSamples[s.venue || '(no venue)'] =
        (unknownVenueSamples[s.venue || '(no venue)'] || 0) + 1;
    }
    continue;
  }

  const { category, market } = classifyShow({ category: venueCheck.category });
  s.category = category;
  s.market = market;
  stamped++;
}

console.log('');
console.log('=== Backfill results ===');
console.log(`  Total shows            : ${list.length}`);
console.log(`  Already had category   : ${alreadySet}`);
console.log(`  Stamped                : ${stamped}`);
console.log(`  Skipped (TBA venue)    : ${skippedTBA}`);
console.log(`  Skipped (unknown venue): ${skippedUnknownVenue}`);
if (skippedUnknownVenue > 0) {
  console.log('  Unknown venues:');
  for (const [v, c] of Object.entries(unknownVenueSamples)) {
    console.log(`    ${c}x  "${v}"`);
  }
}

if (DRY_RUN) {
  console.log('');
  console.log('DRY RUN — no file written.');
  process.exit(0);
}

if (stamped === 0) {
  console.log('');
  console.log('Nothing to stamp. File unchanged.');
  process.exit(0);
}

// Preserve trailing newline if present.
const hasTrailingNewline = raw.endsWith('\n');
const output = JSON.stringify(data, null, 2) + (hasTrailingNewline ? '\n' : '');

fs.writeFileSync(showsPath, output);
console.log('');
console.log(`Wrote ${showsPath} (${stamped} shows stamped)`);
