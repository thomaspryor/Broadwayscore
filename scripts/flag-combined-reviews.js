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
const { baseSlug } = require('./lib/combined-review-utils');

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
        // NOTE: wrongShow:true is INTENTIONALLY not skipped here. The
        // ensemble-scoreability-check rejects joint reviews as wrong_show
        // when the article spends most of its words on the OTHER show in the
        // pairing (issue #316: NYer Schmigadoon!/Lost Boys). If the same URL
        // appears in another show's directory, that's the strongest possible
        // signal it's a legitimate joint review — flag it so wrongShowCleared()
        // includes it in rebuild.
        if (data.wrongProduction || data.isRoundupArticle ||
            data.duplicateOf || data.fabricatedEntry) continue;
        if (!data.url) continue;
        const normUrl = normalizeUrl(data.url);
        if (!normUrl) continue;
        if (!urlMap.has(normUrl)) urlMap.set(normUrl, []);
        urlMap.get(normUrl).push({ showId: dir.name, file, filePath });
      } catch { continue; }
    }
  }

  // baseSlug() lives in scripts/lib/combined-review-utils.js so unit tests
  // can require() the real function. Joint review = URL that genuinely spans
  // 2+ DIFFERENT base shows (e.g. lost-boys + schmigadoon, NOT
  // the-lost-boys + the-lost-boys-2026).

  let flagged = 0, urlCount = 0;
  for (const [url, entries] of urlMap) {
    const uniqueShows = new Set(entries.map(e => e.showId));
    if (uniqueShows.size < 2) continue;
    // Require 2+ DIFFERENT base shows. Filters out same-production-different-id
    // cases that aren't joint reviews.
    const uniqueBaseShows = new Set([...uniqueShows].map(baseSlug));
    if (uniqueBaseShows.size < 2) continue;
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
        // Re-check flags on fresh read (handles concurrent modifications).
        // wrongShow stays in the recovery path — see top-of-loop comment.
        if (data.wrongProduction || data.duplicateOf || data.fabricatedEntry) continue;
        const newCombinedWith = showList.filter(s => s !== entry.showId).sort();
        const existingCombinedWith = (data.combinedWith || []).slice().sort();
        // Only write if flag is new or combinedWith list changed
        if (data.isCombinedReview && JSON.stringify(newCombinedWith) === JSON.stringify(existingCombinedWith)) {
          // Even when combinedWith is unchanged, still recover stale wrongShow
          // flags below — those clear the rebuild gate.
        } else {
          data.isCombinedReview = true;
          data.combinedWith = showList.filter(s => s !== entry.showId);
        }
        // Recover from a stale wrongShow rejection: a URL that exists in 2+
        // show dirs is intentional joint coverage, not a wrong-show false
        // positive. Clear the flag so this file lands in reviews.json.
        if (data.wrongShow === true && data.rejectionReason === 'wrong_show') {
          data.wrongShow = false;
          data.wrongShowOverride = true;
          data.wrongShowOverrideReason =
            'URL co-occurs across ' + uniqueShows.size + ' show dirs — joint review';
          data.wrongShowOverrideAt = new Date().toISOString();
        }
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
