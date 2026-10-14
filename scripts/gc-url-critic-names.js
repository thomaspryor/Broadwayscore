#!/usr/bin/env node
/**
 * gc-url-critic-names.js
 *
 * Garbage-collect review files whose `criticName` is a URL the scraper grabbed
 * instead of the byline text (e.g. "https://observer.com/author/rex-reed").
 * Mirrors the save-time guard now in review-file-writer.js (sanitizeCriticName)
 * and the validate-data [url-critic] detector — this sweep cleans the files
 * that predate the guard.
 *
 * For each match it resolves a clean personal name (or 'Unknown') via
 * sanitizeCriticName and rewrites ONLY the criticName field in place (plain
 * write, all other fields preserved verbatim). It deliberately does NOT rename
 * the file and does NOT route through safeWriteReview — see the inline note in
 * the FIX block for why (url-collision detection would dangle duplicateOf). The
 * validate-data [url-critic] gate reads the field, so field-only is sufficient.
 *
 * Usage:
 *   node scripts/gc-url-critic-names.js          # report only
 *   node scripts/gc-url-critic-names.js --fix    # apply
 *   node scripts/gc-url-critic-names.js --json   # machine-readable report (CI)
 *
 * Exit codes: 0 = clean (or --fix applied), 1 = matches found in report mode.
 */

const fs = require('fs');
const path = require('path');
const { sanitizeCriticName, looksLikeUrlCriticName } = require('./lib/byline-normalization');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

function main() {
  const matches = [];
  let fixed = 0;

  for (const showId of walkShowDirs(REVIEW_TEXTS_DIR)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { continue; }
      const critic = (data.criticName || '').trim();
      if (!looksLikeUrlCriticName(critic)) continue;

      const clean = sanitizeCriticName(critic) || 'Unknown';
      matches.push({ showId, file, from: critic, to: clean });

      if (FIX) {
        // FIELD-ONLY, plain write — deliberately NOT safeWriteReview and NEVER a
        // rename. safeWriteReview runs url-collision detection (findUrlCollision)
        // that stamps duplicateOf toward a same-URL sibling; on a rename the old
        // file is still on disk during the write, so it stamps a pointer at the
        // about-to-be-deleted file → dangling duplicateOf (56 false mismatches in
        // testing). The validate-data [url-critic] gate reads the criticName
        // FIELD, not the filename, so changing only the field is sufficient and
        // leaves the duplicateOf machinery untouched. We change exactly one field
        // and preserve everything else verbatim.
        data.criticName = clean;
        data.criticNameSanitized = `gc-url-critic-names.js on ${new Date().toISOString().slice(0, 10)}: was URL-shaped (field-only)`;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        fixed++;
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ count: matches.length, matches }, null, 2));
    process.exit(matches.length === 0 || FIX ? 0 : 1);
  }

  if (matches.length === 0) {
    console.log('OK: no URL-shaped critic names found');
    process.exit(0);
  }

  console.log(`Found ${matches.length} URL-shaped critic name(s):\n`);
  for (const m of matches) {
    console.log(`  ${m.showId}/${m.file}`);
    console.log(`    "${m.from.slice(0, 70)}" → "${m.to}" ${FIX ? '→ field fixed' : ''}`);
  }

  if (FIX) {
    console.log(`\nApplied: ${fixed} criticName field(s) fixed (no renames). Re-run rebuild.`);
    process.exit(0);
  }
  console.log('\nRun with --fix to clean.');
  process.exit(1);
}

main();
