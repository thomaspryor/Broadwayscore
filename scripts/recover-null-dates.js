#!/usr/bin/env node
/**
 * recover-null-dates.js
 *
 * Recover publishDates for files we previously nulled (publishDateNulledReason set)
 * by extracting dates from the URL itself (no web fetches needed).
 *
 * Uses extractDateFromUrl() which handles /YYYY/MM/DD/, /YYYY/mon/DD, YYYYMMDD,
 * YYYY-MM-DD, and blogspot patterns. Year-only URL matches are NOT persisted —
 * they're already handled by the cross-show URL dedup at rebuild time.
 *
 * fullText scanning was tried and removed due to ~60% false positive rate
 * (matched show booking dates, historical references, run dates).
 *
 * Usage:
 *   node scripts/recover-null-dates.js [--dry-run] [--write]
 */

const fs = require('fs');
const path = require('path');
const { extractDateFromUrl } = require('./lib/rebuild-helpers');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const dryRun = !process.argv.includes('--write');

console.log(`Mode: ${dryRun ? 'DRY RUN' : 'WRITING CHANGES'}\n`);

let stats = {
  total: 0,
  fromUrl: 0,
  notRecovered: 0,
};

for (const sid of fs.readdirSync(REVIEW_TEXTS_DIR)) {
  const sdir = path.join(REVIEW_TEXTS_DIR, sid);
  if (!fs.statSync(sdir).isDirectory()) continue;
  for (const f of fs.readdirSync(sdir).filter(x => x.endsWith('.json') && x !== 'failed-fetches.json')) {
    try {
      const filePath = path.join(sdir, f);
      const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Only target files we previously nulled that are still null
      if (!d.publishDateNulledReason || d.publishDate) continue;

      stats.total++;

      // Strategy 1: URL extraction
      let recovered = null;
      let recoveryMethod = null;
      let yearOnly = null;

      if (d.url) {
        const urlResult = extractDateFromUrl(d.url);
        if (urlResult) {
          if (urlResult.date) {
            recovered = urlResult.date;
            recoveryMethod = urlResult.source;
          } else if (urlResult.yearOnly) {
            yearOnly = urlResult.yearOnly;
          }
        }
      }

      // NOTE: Originally tried fullText regex scanning, but it had a ~60% false positive
      // rate — the patterns matched show booking dates ("until Feb 13, 2022"), historical
      // references ("March 11, 2020"), and show run dates ("Jul 30-Aug 16 2026") instead
      // of actual publish dates. URL extraction is 100% reliable; fullText is not worth it.

      // Year-only URL matches are already handled by the cross-show URL dedup
      // (rebuild-all-reviews.js line 1652-1654 extracts year from URL on the fly).
      // Don't persist fake YYYY-01-01 dates that would display as "Jan 1" on the site.

      if (recovered) {
        stats.fromUrl++;

        if (!dryRun) {
          d.publishDate = recovered;
          d.publishDateRecoveredVia = recoveryMethod;
          fs.writeFileSync(filePath, JSON.stringify(d, null, 2) + '\n');
        }
      } else {
        stats.notRecovered++;
      }
    } catch {}
  }
}

console.log(`Total still-null files: ${stats.total}`);
console.log(`Recovered from URL date: ${stats.fromUrl}`);
console.log(`Still not recovered: ${stats.notRecovered}`);
