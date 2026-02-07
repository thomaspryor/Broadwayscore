#!/usr/bin/env node
/**
 * Fix Unknown Critics
 *
 * Finds --unknown.json review-text files that have a same-URL sibling with a
 * real critic name, and transfers the critic name into the unknown file.
 * Then removes the redundant named file (which was marked as duplicateOf
 * or lacks scoring data).
 *
 * Usage:
 *   node scripts/fix-unknown-critics.js --dry-run    # Preview changes
 *   node scripts/fix-unknown-critics.js               # Apply changes
 */

const fs = require('fs');
const path = require('path');

const textsDir = path.join(__dirname, '..', 'data', 'review-texts');
const dryRun = process.argv.includes('--dry-run');

console.log(`=== Fix Unknown Critics ${dryRun ? '(DRY RUN)' : '(LIVE)'} ===\n`);

const showDirs = fs.readdirSync(textsDir).filter(d =>
  fs.statSync(path.join(textsDir, d)).isDirectory()
);

let fixed = 0;
let deleted = 0;
let renamed = 0;
let skipped = 0;

function normalizeUrl(u) {
  if (!u) return '';
  try {
    const p = new URL(u);
    p.hash = '';
    return p.toString().replace(/\/$/, '').replace(/^http:/, 'https:');
  } catch {
    return u.toLowerCase();
  }
}

for (const showId of showDirs) {
  const showDir = path.join(textsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  const unknownFiles = files.filter(f => /--unknown\.json$/i.test(f));

  for (const uf of unknownFiles) {
    const outletId = uf.replace(/--unknown\.json$/i, '');
    const unknownPath = path.join(showDir, uf);

    // Find sibling file(s) from same outlet with a real critic name
    const siblings = files.filter(f =>
      f.startsWith(outletId + '--') && f !== uf && !/--unknown/i.test(f)
    );

    if (siblings.length === 0) continue;

    let unknownData;
    try {
      unknownData = JSON.parse(fs.readFileSync(unknownPath, 'utf8'));
    } catch { continue; }

    const unknownUrl = normalizeUrl(unknownData.url);
    if (!unknownUrl) continue;

    // Find sibling with matching URL
    let bestMatch = null;
    for (const sib of siblings) {
      try {
        const sibData = JSON.parse(fs.readFileSync(path.join(showDir, sib), 'utf8'));
        const sibUrl = normalizeUrl(sibData.url);

        if (sibUrl === unknownUrl && sibData.criticName && sibData.criticName !== 'Unknown') {
          bestMatch = { file: sib, data: sibData };
          break;
        }
      } catch { continue; }
    }

    if (!bestMatch) continue;

    const newCriticName = bestMatch.data.criticName;
    const newFilename = `${outletId}--${newCriticName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;

    // Transfer critic name into unknown file
    unknownData.criticName = newCriticName;

    // Remove the duplicateOf from the unknown file if it points to itself
    if (unknownData.duplicateOf) {
      delete unknownData.duplicateOf;
    }

    if (!dryRun) {
      // Write updated data to new filename
      fs.writeFileSync(path.join(showDir, newFilename), JSON.stringify(unknownData, null, 2) + '\n');

      // Delete old unknown file
      if (newFilename !== uf) {
        fs.unlinkSync(unknownPath);
        renamed++;
      }

      // Delete the redundant named sibling (it was the duplicate)
      const sibPath = path.join(showDir, bestMatch.file);
      if (fs.existsSync(sibPath) && bestMatch.file !== newFilename) {
        fs.unlinkSync(sibPath);
        deleted++;
      }
    }

    fixed++;
    if (fixed <= 20 || fixed % 100 === 0) {
      console.log(`  ${showId}/${outletId}: "Unknown" → "${newCriticName}"`);
    }
  }
}

console.log(`\n=== RESULTS ===`);
console.log(`Critics recovered: ${fixed}`);
console.log(`Files renamed (unknown → named): ${renamed}`);
console.log(`Redundant siblings deleted: ${deleted}`);
console.log(`Skipped: ${skipped}`);

if (dryRun) {
  console.log('\nThis was a dry run. Run without --dry-run to apply changes.');
}
