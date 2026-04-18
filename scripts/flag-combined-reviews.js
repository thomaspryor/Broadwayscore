#!/usr/bin/env node
/**
 * Flag review-text files that share a URL across 2+ different shows as
 * isCombinedReview: true. These are legitimate multi-show articles.
 *
 * Usage:
 *   node scripts/flag-combined-reviews.js --dry-run
 *   node scripts/flag-combined-reviews.js
 */
const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DRY_RUN = process.argv.includes('--dry-run');

function normalizeUrl(url) {
  if (!url) return null;
  return url.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
}

function main() {
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));
  const urlMap = new Map();

  for (const dir of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, dir.name);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.wrongProduction || data.wrongShow || data.isRoundupArticle ||
            data.duplicateOf || data.fabricatedEntry) continue;
        if (!data.url) continue;
        const normUrl = normalizeUrl(data.url);
        if (!normUrl) continue;
        if (!urlMap.has(normUrl)) urlMap.set(normUrl, []);
        urlMap.get(normUrl).push({ showId: dir.name, file, filePath });
      } catch { continue; }
    }
  }

  let flagged = 0, urlCount = 0;
  for (const [url, entries] of urlMap) {
    const uniqueShows = new Set(entries.map(e => e.showId));
    if (uniqueShows.size < 2) continue;
    urlCount++;
    const showList = Array.from(uniqueShows);
    if (DRY_RUN) {
      console.log(`URL: ${url.substring(0, 100)}`);
      for (const e of entries) console.log(`  ${e.showId}/${e.file}`);
      console.log();
    }
    for (const entry of entries) {
      if (!DRY_RUN) {
        const data = JSON.parse(fs.readFileSync(entry.filePath, 'utf8'));
        // Re-check flags on fresh read (handles concurrent modifications)
        if (data.wrongProduction || data.wrongShow || data.duplicateOf || data.fabricatedEntry) continue;
        const newCombinedWith = showList.filter(s => s !== entry.showId).sort();
        const existingCombinedWith = (data.combinedWith || []).slice().sort();
        // Only write if flag is new or combinedWith list changed
        if (data.isCombinedReview && JSON.stringify(newCombinedWith) === JSON.stringify(existingCombinedWith)) continue;
        data.isCombinedReview = true;
        data.combinedWith = showList.filter(s => s !== entry.showId);
        safeWriteReview(entry.filePath, data);
      }
      flagged++;
    }
  }

  console.log('=== SUMMARY ===');
  console.log(`URLs shared across 2+ shows: ${urlCount}`);
  console.log(`Files flagged isCombinedReview: ${flagged}`);
  if (DRY_RUN) console.log('(DRY RUN)');
}

main();
