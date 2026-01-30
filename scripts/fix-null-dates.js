#!/usr/bin/env node

/**
 * fix-null-dates.js
 * Extracts publish dates from review URLs and updates review files.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const reviewsDir = path.join(__dirname, '..', 'data', 'review-texts');

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

function formatDateForDisplay(isoDate) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const [year, month, day] = isoDate.split('-');
  return `${months[parseInt(month) - 1]} ${parseInt(day)}, ${year}`;
}

const shows = fs.readdirSync(reviewsDir).filter(f =>
  fs.statSync(path.join(reviewsDir, f)).isDirectory()
);

let fixed = 0, skipped = 0, alreadyHasDate = 0, yearMismatch = 0;

// Extract show year from ID (e.g., "hamilton-2015" -> 2015)
function getShowYear(showId) {
  const match = showId.match(/-(\d{4})$/);
  return match ? parseInt(match[1]) : null;
}

console.log(dryRun ? '=== DRY RUN ===' : '=== FIXING NULL DATES ===');

for (const show of shows) {
  const showPath = path.join(reviewsDir, show);
  const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  const showYear = getShowYear(show);

  for (const file of files) {
    const filePath = path.join(showPath, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (data.publishDate || data.dateUnknown) { alreadyHasDate++; continue; }

    const extractedDate = extractDateFromUrl(data.url);
    if (extractedDate) {
      const extractedYear = parseInt(extractedDate.split('-')[0]);

      // Validate: extracted year should be within ±1 of show year (reviews can come out year before/after opening)
      if (showYear && Math.abs(extractedYear - showYear) > 1) {
        console.log(`[SKIP] ${show}/${file} - year mismatch (show: ${showYear}, extracted: ${extractedYear})`);
        yearMismatch++;
        continue;
      }

      const displayDate = formatDateForDisplay(extractedDate);
      console.log(`[FIX] ${show}/${file} -> ${displayDate}`);
      if (!dryRun) {
        data.publishDate = displayDate;
        data.dateSource = 'extracted-from-url';
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      }
      fixed++;
    } else {
      skipped++;
    }
  }
}

console.log('\n=== SUMMARY ===');
console.log(`Already had date: ${alreadyHasDate}`);
console.log(`Fixed from URL: ${fixed}`);
console.log(`Could not extract: ${skipped}`);
console.log(`Year mismatch (wrong production): ${yearMismatch}`);
