#!/usr/bin/env node
/**
 * Clean HTML Entities from Review Text Files
 *
 * One-time backfill script that decodes HTML entities (&#8220;, &rsquo;, etc.)
 * in all review-text JSON files. Applies to fullText and all excerpt fields.
 *
 * Usage:
 *   node scripts/clean-review-entities.js              # Apply changes
 *   node scripts/clean-review-entities.js --dry-run    # Report only
 *   node scripts/clean-review-entities.js --show=slug  # Single show
 */

const fs = require('fs');
const path = require('path');
const { decodeHtmlEntities } = require('./lib/text-cleaning');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Fields to decode (active + historical)
const TEXT_FIELDS = [
  'fullText', 'dtliExcerpt', 'bwwExcerpt', 'showScoreExcerpt', 'nycTheatreExcerpt',
  'previousFullText', 'garbageFullText',
];

// Pattern to detect HTML entities
const ENTITY_PATTERN = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/;

const stats = {
  totalFiles: 0,
  filesWithEntities: 0,
  fieldsDecoded: 0,
  errors: 0,
};

console.log('=== CLEAN HTML ENTITIES FROM REVIEW TEXTS ===');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (writing changes)'}`);
if (SHOW_FILTER) console.log(`Filter: ${SHOW_FILTER}`);
console.log('');

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .filter(d => !SHOW_FILTER || d.name === SHOW_FILTER || d.name.startsWith(SHOW_FILTER))
  .map(d => d.name);

if (SHOW_FILTER && showDirs.length === 0) {
  console.error(`No show directory found matching "${SHOW_FILTER}"`);
  process.exit(1);
}

console.log(`Processing ${showDirs.length} show directories...\n`);

for (const showId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    stats.totalFiles++;
    const filePath = path.join(showDir, file);

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let modified = false;
      let fieldsChanged = [];

      for (const field of TEXT_FIELDS) {
        if (data[field] && typeof data[field] === 'string' && ENTITY_PATTERN.test(data[field])) {
          const decoded = decodeHtmlEntities(data[field]);
          if (decoded !== data[field]) {
            data[field] = decoded;
            modified = true;
            fieldsChanged.push(field);
            stats.fieldsDecoded++;
          }
        }
      }

      if (modified) {
        stats.filesWithEntities++;
        if (!DRY_RUN) {
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
        if (stats.filesWithEntities <= 20 || DRY_RUN) {
          console.log(`  ${showId}/${file} → ${fieldsChanged.join(', ')}`);
        }
      }
    } catch (e) {
      stats.errors++;
      console.error(`  Error: ${showId}/${file}: ${e.message}`);
    }
  }
}

console.log('\n=== RESULTS ===\n');
console.log(`Total files scanned: ${stats.totalFiles}`);
console.log(`Files with entities: ${stats.filesWithEntities}`);
console.log(`Fields decoded: ${stats.fieldsDecoded}`);
console.log(`Errors: ${stats.errors}`);

if (DRY_RUN) {
  console.log('\n[DRY RUN] No files were modified. Re-run without --dry-run to apply changes.');
}

console.log('\n=== DONE ===');
