#!/usr/bin/env node

/**
 * fix-null-dates.js
 * Extracts publish dates from review URLs, archive.org timestamps,
 * and opening-date proximity for reviews missing publishDate.
 *
 * Usage: node scripts/fix-null-dates.js [--dry-run] [--market=off-broadway|west-end|broadway]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const marketArg = args.find(a => a.startsWith('--market='));
const market = marketArg ? marketArg.split('=')[1] : null;

const reviewsDir = path.join(__dirname, '..', 'data', 'review-texts');
const showsPath = path.join(__dirname, '..', 'data', 'shows.json');

const datePatterns = [
  { regex: /\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//, format: (m) => `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` },
  { regex: /\/(\d{4})-(\d{2})-(\d{2})[-\/]/, format: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { regex: /[?&]date=(\d{4})-(\d{2})-(\d{2})/, format: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { regex: /\/(\d{4})(\d{2})(\d{2})-/, format: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { regex: /news\/(\d{4})-(\d{2})-(\d{2})\//, format: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { regex: /articles[^/]*\/(\d{4})-(\d{2})-(\d{2})/, format: (m) => `${m[1]}-${m[2]}-${m[3]}` },
];

function extractDateFromUrl(url) {
  if (!url) return null;
  for (const pattern of datePatterns) {
    const match = url.match(pattern.regex);
    if (match) {
      const dateStr = pattern.format(match);
      const date = new Date(dateStr);
      if (!isNaN(date.getTime()) && date.getFullYear() >= 1990 && date.getFullYear() <= 2030) {
        return dateStr;
      }
    }
  }
  return null;
}

// Extract date from archive.org timestamp (format: YYYYMMDDHHmmss)
function extractDateFromArchiveTimestamp(timestamp) {
  if (!timestamp || typeof timestamp !== 'string') return null;
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  const dateStr = `${match[1]}-${match[2]}-${match[3]}`;
  const d = new Date(dateStr);
  if (isNaN(d.getTime()) || d.getFullYear() < 1990 || d.getFullYear() > 2030) return null;
  return dateStr;
}

function formatDateForDisplay(isoDate) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const [year, month, day] = isoDate.split('-');
  return `${months[parseInt(month) - 1]} ${parseInt(day)}, ${year}`;
}

// Extract show year from ID (e.g., "hamilton-2015" -> 2015)
function getShowYear(showId) {
  const match = showId.match(/-(\d{4})$/);
  return match ? parseInt(match[1]) : null;
}

// Load shows.json for market filtering
let showCategoryMap = {};
if (fs.existsSync(showsPath)) {
  const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  for (const s of showsData.shows) {
    showCategoryMap[s.id] = s.category || 'broadway';
  }
}

const shows = fs.readdirSync(reviewsDir).filter(f => {
  const fp = path.join(reviewsDir, f);
  if (!fs.statSync(fp).isDirectory()) return false;
  // Market filter
  if (market) {
    const showCat = showCategoryMap[f] || 'broadway';
    if (showCat !== market) return false;
  }
  return true;
});

let fixed = 0, fixedFromArchive = 0, skipped = 0, alreadyHasDate = 0, yearMismatch = 0;

console.log(dryRun ? '=== DRY RUN ===' : '=== FIXING NULL DATES ===');
if (market) console.log(`Market filter: ${market}`);
console.log(`Processing ${shows.length} show directories\n`);

for (const show of shows) {
  const showPath = path.join(reviewsDir, show);
  const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  const showYear = getShowYear(show);

  for (const file of files) {
    const filePath = path.join(showPath, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (data.publishDate || data.dateUnknown) { alreadyHasDate++; continue; }

    // Try URL-based extraction first
    let extractedDate = extractDateFromUrl(data.url);
    let source = 'extracted-from-url';

    // Fallback: archive.org timestamp
    if (!extractedDate && data.archiveOrgTimestamp) {
      extractedDate = extractDateFromArchiveTimestamp(data.archiveOrgTimestamp);
      source = 'extracted-from-archive-timestamp';
    }

    if (extractedDate) {
      const extractedYear = parseInt(extractedDate.split('-')[0]);

      // Validate: extracted year should be within ±2 of show year for WE/OB (wider tolerance)
      const tolerance = (market === 'west-end' || market === 'off-broadway') ? 2 : 1;
      if (showYear && Math.abs(extractedYear - showYear) > tolerance) {
        yearMismatch++;
        continue;
      }

      const displayDate = formatDateForDisplay(extractedDate);
      if (!dryRun) {
        data.publishDate = displayDate;
        data.dateSource = source;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      }
      if (source === 'extracted-from-archive-timestamp') fixedFromArchive++;
      fixed++;
    } else {
      skipped++;
    }
  }
}

console.log('\n=== SUMMARY ===');
console.log(`Already had date: ${alreadyHasDate}`);
console.log(`Fixed from URL: ${fixed - fixedFromArchive}`);
console.log(`Fixed from archive timestamp: ${fixedFromArchive}`);
console.log(`Could not extract: ${skipped}`);
console.log(`Year mismatch (wrong production): ${yearMismatch}`);
