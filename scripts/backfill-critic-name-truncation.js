#!/usr/bin/env node
/**
 * backfill-critic-name-truncation.js
 *
 * One-shot backfill for critic names that the BWW Review Roundup parser
 * truncated by stripping a leading initial. After fixing the parser
 * (scripts/lib/bww-roundup-parser.js, 2026-04-26), this script:
 *
 *   1. Updates criticName in affected review-text JSON files.
 *   2. Renames each file to use the corrected critic slug.
 *   3. Deletes pure-duplicate sibling files where the correct-slug version
 *      already exists with identical content.
 *
 * Currently only the J. Kelly Nestruck case (Globe and Mail) is fixable from
 * data alone. The Randall David Cook (The Recs) case is a BWW editor
 * abbreviation, not a regex bug — that needs a critic-canonicalization map
 * entry, not a backfill.
 *
 * Run: node scripts/backfill-critic-name-truncation.js
 *      node scripts/backfill-critic-name-truncation.js --apply   # write changes
 */

'use strict';

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const REVIEW_TEXTS_DIR = '/Users/tompryor/broadway-review-texts';

const TRUNCATIONS = [
  // outletId, truncated criticName, fixed criticName, truncated slug, fixed slug
  { outletId: 'the-globe-and-mail', from: 'Kelly Nestruck', to: 'J. Kelly Nestruck',
    fromSlug: 'the-globe-and-mail--kelly-nestruck.json', toSlug: 'the-globe-and-mail--j-kelly-nestruck.json' },
];

function eqContent(a, b) {
  // Compare relevant fields. Filenames may differ but content is identical.
  return JSON.stringify({ ...a, criticName: null }) === JSON.stringify({ ...b, criticName: null });
}

let updated = 0, renamed = 0, deletedDupes = 0, skipped = 0, errors = 0;

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
  .filter(d => {
    if (d.startsWith('_')) return false;
    if (d === 'aggregator-archive') return false;
    try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); }
    catch { return false; }
  });

for (const showId of showDirs) {
  for (const t of TRUNCATIONS) {
    const fromPath = path.join(REVIEW_TEXTS_DIR, showId, t.fromSlug);
    const toPath = path.join(REVIEW_TEXTS_DIR, showId, t.toSlug);
    if (!fs.existsSync(fromPath)) continue;

    let fromJson;
    try { fromJson = JSON.parse(fs.readFileSync(fromPath, 'utf8')); }
    catch (e) { console.warn(`[skip] parse error: ${fromPath}`); errors++; continue; }

    if (fromJson.criticName !== t.from && fromJson.criticName !== t.to) {
      console.warn(`[skip] criticName="${fromJson.criticName}" doesn't match expected "${t.from}" or "${t.to}": ${fromPath}`);
      skipped++;
      continue;
    }

    if (fs.existsSync(toPath)) {
      // Sibling exists. If both have correct criticName and content matches, the
      // truncated-slug file is a pure dupe — safe to remove.
      let toJson;
      try { toJson = JSON.parse(fs.readFileSync(toPath, 'utf8')); }
      catch (e) { console.warn(`[skip] parse error on sibling: ${toPath}`); errors++; continue; }

      if (toJson.criticName === t.to && fromJson.criticName === t.to && eqContent(fromJson, toJson)) {
        console.log(`[dedupe] ${showId}/${t.fromSlug}  (sibling already has corrected name + same content)`);
        if (APPLY) fs.unlinkSync(fromPath);
        deletedDupes++;
      } else {
        console.warn(`[skip] sibling exists with different content: ${showId}/${t.fromSlug} vs ${t.toSlug}`);
        skipped++;
      }
      continue;
    }

    // No sibling — update + rename.
    const before = fromJson.criticName;
    fromJson.criticName = t.to;
    if (APPLY) {
      fs.writeFileSync(toPath, JSON.stringify(fromJson, null, 2));
      fs.unlinkSync(fromPath);
    }
    console.log(`[fix] ${showId}/${t.fromSlug}: criticName "${before}" → "${t.to}", renamed → ${t.toSlug}`);
    updated++;
    renamed++;
  }
}

console.log(`\nSummary: ${updated} updated, ${renamed} renamed, ${deletedDupes} duplicate files deleted, ${skipped} skipped, ${errors} errors`);
if (!APPLY) console.log(`\n(dry run — use --apply to write changes)`);
