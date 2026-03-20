#!/usr/bin/env node
/**
 * Backfill publishDate from URL patterns for review files that are missing dates.
 *
 * Extracts dates from two URL patterns:
 *   - /YYYY/MM/DD/ (slash-separated, e.g. chicagotribune.com/2025/11/16/...)
 *   - YYYY-MM-DD   (dash-separated in path only, e.g. latimes.com/.../2025-04-22-...)
 *
 * Validation:
 *   - Year: 1970–2027
 *   - Month: 1–12
 *   - Day: 1–31
 *   - The constructed date must be a real calendar date (Feb 30 rejected)
 *   - Show title substrings that look like years (e.g. "1776") are excluded
 *
 * Usage:
 *   node scripts/backfill-url-dates.js              # dry run (default)
 *   node scripts/backfill-url-dates.js --apply      # write to files
 *   node scripts/backfill-url-dates.js --show chess-2025  # single show
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DRY_RUN = !process.argv.includes('--apply');
const SHOW_FILTER = process.argv.find(a => a.startsWith('--show='))?.split('=')[1]
  || (process.argv.includes('--show') ? process.argv[process.argv.indexOf('--show') + 1] : null);

// Show titles that contain 4-digit numbers — these can appear in URLs and look like years
const TITLE_YEAR_BLOCKLIST = new Set([
  '1776', '1984', '1812', '1921', '1992', '1940', '2026',
]);

/**
 * Extract a date from a URL path. Returns YYYY-MM-DD or null.
 *
 * Only matches path segments (before ? and #). Two patterns:
 *   1. /YYYY/MM/DD/ — unambiguous, used by WordPress sites, major newspapers
 *   2. YYYY-MM-DD   — used by Bloomberg, LA Times, USA Today, Village Voice
 */
function extractDateFromUrl(url) {
  if (!url) return null;

  // Strip query string and fragment
  const pathOnly = url.split('?')[0].split('#')[0];

  // Pattern 1: /YYYY/MM/DD/ (must have slashes on both sides of each segment)
  const slashMatch = pathOnly.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (slashMatch) {
    const result = validateAndFormat(slashMatch[1], slashMatch[2], slashMatch[3]);
    if (result) return result;
  }

  // Pattern 2: YYYY-MM-DD (dash-separated, in the path)
  // Must NOT match show-title years. We check that the 4 digits aren't in the blocklist.
  const dashMatch = pathOnly.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dashMatch) {
    if (TITLE_YEAR_BLOCKLIST.has(dashMatch[1])) return null;
    const result = validateAndFormat(dashMatch[1], dashMatch[2], dashMatch[3]);
    if (result) return result;
  }

  return null;
}

/**
 * Validate year/month/day and return YYYY-MM-DD, or null if invalid.
 * Uses Date constructor to catch impossible dates like Feb 30.
 */
function validateAndFormat(yearStr, monthStr, dayStr) {
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  // Range checks
  if (year < 1970 || year > 2027) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  // Calendar validity — Date(2025, 1, 30) silently rolls over to March
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// --- Main ---

function run() {
  const showDirs = SHOW_FILTER
    ? [SHOW_FILTER]
    : fs.readdirSync(REVIEW_TEXTS_DIR).filter(d =>
        fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory()
      );

  let updated = 0;
  let skipped = 0;
  let alreadyHasDate = 0;
  let noUrl = 0;
  let noDateInUrl = 0;

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }

      if (data.publishDate) {
        alreadyHasDate++;
        continue;
      }

      if (!data.url) {
        noUrl++;
        continue;
      }

      const extracted = extractDateFromUrl(data.url);
      if (!extracted) {
        noDateInUrl++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [dry-run] ${showDir}/${file}: ${extracted}  ← ${data.url.substring(0, 70)}`);
      } else {
        data.publishDate = extracted;
        data.dateSource = 'url';
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
      updated++;
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Already had date: ${alreadyHasDate}`);
  console.log(`No URL:           ${noUrl}`);
  console.log(`No date in URL:   ${noDateInUrl}`);
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}:     ${updated}`);
  if (DRY_RUN && updated > 0) {
    console.log(`\nRun with --apply to write changes.`);
  }
}

run();
