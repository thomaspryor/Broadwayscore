#!/usr/bin/env node
/**
 * Audit multi-production shows for cross-contamination.
 *
 * For each show with multiple productions that have review-text directories,
 * checks whether any review file's publish date is closer to a DIFFERENT
 * production's opening date than the one it's filed under.
 *
 * Also checks for duplicate files (same filename in multiple production dirs).
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const showsData = require('../data/shows.json');
const shows = showsData.shows;

// Build title → [show objects] map
const byTitle = {};
shows.forEach(s => {
  const base = s.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (!byTitle[base]) byTitle[base] = [];
  byTitle[base].push(s);
});

// Find multi-production shows with review-texts in 2+ dirs
const multiProd = Object.entries(byTitle)
  .filter(([, arr]) => arr.length > 1)
  .map(([title, arr]) => {
    const withDirs = arr.filter(s => fs.existsSync(path.join(REVIEW_TEXTS_DIR, s.id)));
    return { title, shows: withDirs };
  })
  .filter(m => m.shows.length > 1);

console.log(`Scanning ${multiProd.length} multi-production shows...\n`);

// Known WE-market URL patterns and outlet name fragments
const WE_URL_PATTERNS = [
  /timeout\.com\/london/i,
  /theguardian\.com\/stage/i,
  /westendwilma/i,
  /everything-theatre/i,
  /theatrecat/i,
  /londontheatre1/i,
  /whatsonstage/i,
  /thestage\.co\.uk/i,
  /broadwayworld\.com\/westend/i,
  /london-theatre/i,
  /theatre\.reviews/i,
  /stagedoor\.com/i,  // Stagedoor covers both, but filed-under market wins
];

const WE_OUTLET_FRAGMENTS = [
  'west-end-wilma', 'everything-theatre', 'theatrecat', 'londontheatre',
  'whatsonstage', 'london-theatre', 'the-stage', 'timeout-london',
];

function isWEShow(showId) {
  return showId.includes('west-end');
}

function isLikelyWEReview(review, outletFilename) {
  const url = (review.url || '').toLowerCase();
  if (WE_URL_PATTERNS.some(p => p.test(url))) return true;
  const outletPart = outletFilename.split('--')[0].toLowerCase();
  if (WE_OUTLET_FRAGMENTS.some(f => outletPart.includes(f))) return true;
  return false;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(d1, d2) {
  return Math.abs((d1 - d2) / (1000 * 60 * 60 * 24));
}

const issues = [];
let totalFilesScanned = 0;
let totalDuplicates = 0;
let totalWrongProd = 0;
let totalAlreadyFlagged = 0;

for (const group of multiProd) {
  const productions = group.shows.map(s => ({
    id: s.id,
    openingDate: parseDate(s.openingDate),
    closingDate: parseDate(s.closingDate),
    market: s.market,
    dir: path.join(REVIEW_TEXTS_DIR, s.id)
  }));

  // Check for duplicate filenames across productions
  const filesByName = {};
  for (const prod of productions) {
    const files = fs.readdirSync(prod.dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      if (!filesByName[f]) filesByName[f] = [];
      filesByName[f].push(prod.id);
    }
  }

  const dupes = Object.entries(filesByName).filter(([, ids]) => ids.length > 1);
  if (dupes.length > 0) {
    totalDuplicates += dupes.length;
  }

  // For each production, check if reviews belong to a different production
  for (const prod of productions) {
    const otherProds = productions.filter(p => p.id !== prod.id);
    if (!prod.openingDate) continue;

    const files = fs.readdirSync(prod.dir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      totalFilesScanned++;
      const filePath = path.join(prod.dir, file);
      let review;
      try {
        review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch { continue; }

      // Skip already flagged
      if (review.wrongProduction) {
        totalAlreadyFlagged++;
        continue;
      }

      const pubDate = parseDate(review.publishDate);
      if (!pubDate) continue;

      // Check if this review's publish date is closer to another production
      const distToOwn = daysBetween(pubDate, prod.openingDate);

      for (const other of otherProds) {
        if (!other.openingDate) continue;
        const distToOther = daysBetween(pubDate, other.openingDate);

        // Flag if review date is much closer to another production
        // AND is within 180 days of other's opening (to catch legitimate reviews)
        // AND is more than 365 days from own opening
        if (distToOther < distToOwn && distToOwn > 365 && distToOther < 180) {
          // Market-awareness: skip if this is a WE review correctly filed under a WE show
          // (the "closer" production is in a different market)
          if (isWEShow(prod.id) && !isWEShow(other.id) && isLikelyWEReview(review, file)) {
            continue;
          }
          totalWrongProd++;
          const issue = {
            file: `${prod.id}/${file}`,
            publishDate: review.publishDate,
            filedUnder: prod.id,
            filedUnderOpening: prod.openingDate.toISOString().split('T')[0],
            daysFromOwn: Math.round(distToOwn),
            closerTo: other.id,
            closerToOpening: other.openingDate.toISOString().split('T')[0],
            daysFromCloser: Math.round(distToOther),
            url: (review.url || '').substring(0, 80),
            hasDupeInCorrectDir: fs.existsSync(path.join(REVIEW_TEXTS_DIR, other.id, file))
          };
          issues.push(issue);
        }
      }
    }
  }
}

// Sort issues by show title for readability
issues.sort((a, b) => a.filedUnder.localeCompare(b.filedUnder));

console.log(`Files scanned: ${totalFilesScanned}`);
console.log(`Already flagged wrongProduction: ${totalAlreadyFlagged}`);
console.log(`Cross-production duplicates (same filename): ${totalDuplicates}`);
console.log(`Likely wrong-production reviews: ${totalWrongProd}`);
console.log('');

if (issues.length === 0) {
  console.log('✅ No unflagged wrong-production reviews found!');
} else {
  console.log('⚠️  Likely wrong-production reviews:\n');
  for (const i of issues) {
    console.log(`  ${i.file}`);
    console.log(`    Published: ${i.publishDate} (${i.daysFromOwn}d from ${i.filedUnder} opening ${i.filedUnderOpening})`);
    console.log(`    Closer to: ${i.closerTo} (${i.daysFromCloser}d from opening ${i.closerToOpening})`);
    console.log(`    Dupe in correct dir: ${i.hasDupeInCorrectDir ? 'YES' : 'no'}`);
    console.log(`    URL: ${i.url}`);
    console.log('');
  }
}

// Write machine-readable output
const output = {
  timestamp: new Date().toISOString(),
  totalScanned: totalFilesScanned,
  alreadyFlagged: totalAlreadyFlagged,
  crossProductionDupes: totalDuplicates,
  likelyWrongProduction: totalWrongProd,
  issues
};
fs.writeFileSync(
  path.join(__dirname, '..', 'data', 'audit', 'cross-production-audit.json'),
  JSON.stringify(output, null, 2) + '\n'
);
console.log('Wrote data/audit/cross-production-audit.json');
