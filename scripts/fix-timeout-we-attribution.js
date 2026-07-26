#!/usr/bin/env node
/**
 * Fix Time Out outlet attribution in West End directories.
 *
 * Problem: Many WE reviews by London-based Time Out critics are filed as
 * "timeout" (Time Out New York) instead of "timeout-london" (Time Out London).
 * The cross-market guard blocks "timeout" from WE, so these legitimate
 * London reviews are excluded from scoring.
 *
 * Fix:
 * - timeout.com/london/ URLs → rename to timeout-london, update outletId
 * - timeout.com/newyork/ URLs → flag as wrongProduction (Broadway review)
 * - Other timeout.com URLs → check manually
 *
 * Safe to re-run: skips already-renamed files.
 */
const fs = require('fs');
const path = require('path');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-timeout-we-attribution.js — Fix Time Out outlet attribution in West End directories.

Usage:
  node scripts/fix-timeout-we-attribution.js [options]
  node scripts/fix-timeout-we-attribution.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const dryRun = process.argv.includes('--dry-run');

const dirs = fs.readdirSync(REVIEW_TEXTS_DIR)
  .filter(d => (d.includes('west-end') || d.includes('off-west-end')) && fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory());

let renamed = 0, flagged = 0, skipped = 0, ambiguous = 0;

for (const dir of dirs) {
  const dirPath = path.join(REVIEW_TEXTS_DIR, dir);
  const files = fs.readdirSync(dirPath).filter(f => f.startsWith('timeout--') && f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) { continue; }

    // Skip already-excluded
    if (data.wrongProduction || data.wrongShow || data.duplicateOf || data.rejectionReason) {
      skipped++;
      continue;
    }

    const url = (data.url || '').toLowerCase();
    const critic = file.replace('timeout--', '').replace('.json', '');

    if (url.includes('timeout.com/london') || url.includes('timeout.co.uk')) {
      // London URL → rename to timeout-london
      const newFile = file.replace('timeout--', 'timeout-london--');
      const newPath = path.join(dirPath, newFile);

      // Check if timeout-london version already exists
      if (fs.existsSync(newPath)) {
        // Mark this one as duplicate
        data.duplicateOf = newFile;
        if (!dryRun) fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        console.log(`${dryRun ? '[DRY] ' : ''}DEDUP: ${dir}/${file} → duplicate of ${newFile}`);
        skipped++;
        continue;
      }

      // Update outlet fields and rename
      data.outletId = 'timeout-london';
      data.outlet = 'Time Out London';
      if (!dryRun) {
        fs.writeFileSync(newPath, JSON.stringify(data, null, 2) + '\n');
        fs.unlinkSync(filePath);
      }
      console.log(`${dryRun ? '[DRY] ' : ''}RENAMED: ${dir}/${file} → ${newFile}`);
      renamed++;

    } else if (url.includes('timeout.com/newyork') || url.includes('newyork.timeout.com') || url.includes('timeout.com/us')) {
      // NYC URL → this is a Broadway review
      data.wrongProduction = true;
      data.wrongProductionNote = 'Time Out New York review filed in West End directory';
      if (!dryRun) fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      console.log(`${dryRun ? '[DRY] ' : ''}FLAGGED: ${dir}/${file} (NYC URL)`);
      flagged++;

    } else if (url.includes('timeout.com/melbourne') || url.includes('timeout.com/sydney')) {
      // Australia → wrong market
      data.wrongProduction = true;
      data.wrongProductionNote = 'Time Out Australia review filed in West End directory';
      if (!dryRun) fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      console.log(`${dryRun ? '[DRY] ' : ''}FLAGGED: ${dir}/${file} (AU URL)`);
      flagged++;

    } else if (!url || url.length < 10) {
      // No URL — check if critic is known London-based
      const londonCritics = new Set(['andrzej-lukowski', 'andrjez-lukowski', 'tim-bano', 'holly-williams',
        'nina-culley', 'ben-walters', 'anya-ryan', 'nina-caplan', 'sam-marlowe', 'tom-wicker',
        'honour-bayes', 'caroline-mcginn']);
      if (londonCritics.has(critic)) {
        const newFile = file.replace('timeout--', 'timeout-london--');
        const newPath = path.join(dirPath, newFile);
        if (fs.existsSync(newPath)) {
          data.duplicateOf = newFile;
          if (!dryRun) fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
          console.log(`${dryRun ? '[DRY] ' : ''}DEDUP: ${dir}/${file} → duplicate of ${newFile}`);
          skipped++;
          continue;
        }
        data.outletId = 'timeout-london';
        data.outlet = 'Time Out London';
        if (!dryRun) {
          fs.writeFileSync(newPath, JSON.stringify(data, null, 2) + '\n');
          fs.unlinkSync(filePath);
        }
        console.log(`${dryRun ? '[DRY] ' : ''}RENAMED (known critic): ${dir}/${file} → ${newFile}`);
        renamed++;
      } else {
        console.log(`AMBIGUOUS: ${dir}/${file} (no URL, unknown critic "${critic}")`);
        ambiguous++;
      }
    } else {
      console.log(`AMBIGUOUS: ${dir}/${file} (URL: ${url.substring(0, 60)})`);
      ambiguous++;
    }
  }
}

console.log(`\n--- Summary ---`);
console.log(`Renamed to timeout-london: ${renamed}`);
console.log(`Flagged wrongProduction: ${flagged}`);
console.log(`Already excluded/deduped: ${skipped}`);
console.log(`Ambiguous (needs manual check): ${ambiguous}`);
if (dryRun) console.log('(DRY RUN — no files modified)');
