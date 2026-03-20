#!/usr/bin/env node
/**
 * Extract publishDate from the first 500 chars of fullText using regex.
 * Only extracts when exactly ONE date is found (avoids ambiguity).
 *
 * Patterns matched:
 *   - "March 31, 2016" / "March 31st, 2016"
 *   - "31 March 2016" / "31st March, 2016"
 *
 * Does NOT match abbreviated months (Jan, Feb, etc.) to avoid false
 * positives from casual mentions like "the Jan. 5 performance".
 *
 * Usage:
 *   node scripts/backfill-text-dates.js              # dry run
 *   node scripts/backfill-text-dates.js --apply      # write to files
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DRY_RUN = !process.argv.includes('--apply');
const HEADER_CHARS = 500;

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Full month names only — no abbreviations to reduce false positives
const PATTERNS = [
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi,
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})\b/gi,
];

function extractSingleDate(text) {
  const header = text.substring(0, HEADER_CHARS);
  const allMatches = [];

  for (const pat of PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(header)) !== null) {
      allMatches.push(m[0]);
    }
  }

  // Only proceed if exactly one date found — avoids index pages, roundups
  if (allMatches.length !== 1) return null;

  const match = allMatches[0];
  const m1 = match.match(/^([A-Za-z]+)\s+(\d+)(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  const m2 = match.match(/^(\d+)(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/);

  let monthStr, day, year;
  if (m1) {
    monthStr = m1[1].toLowerCase();
    day = parseInt(m1[2], 10);
    year = parseInt(m1[3], 10);
  } else if (m2) {
    day = parseInt(m2[1], 10);
    monthStr = m2[2].toLowerCase();
    year = parseInt(m2[3], 10);
  } else {
    return null;
  }

  const month = MONTHS[monthStr];
  if (!month || day < 1 || day > 31 || year < 1970 || year > 2027) return null;

  // Calendar validity
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function run() {
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory()
  );

  let updated = 0, alreadyHasDate = 0, noText = 0, noMatch = 0, skipped = 0;

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      if (data.publishDate) { alreadyHasDate++; continue; }
      if (data.wrongProduction || data.wrongShow) { skipped++; continue; }
      if (!data.fullText || data.fullText.length < 100) { noText++; continue; }

      const extracted = extractSingleDate(data.fullText);
      if (!extracted) { noMatch++; continue; }

      if (DRY_RUN) {
        console.log(`  [dry-run] ${showDir}/${file}: ${extracted}`);
      } else {
        data.publishDate = extracted;
        data.dateSource = 'text-regex';
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
      updated++;
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Already had date:  ${alreadyHasDate}`);
  console.log(`Excluded (flags):  ${skipped}`);
  console.log(`No fullText:       ${noText}`);
  console.log(`No single match:   ${noMatch}`);
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}:      ${updated}`);
  if (DRY_RUN && updated > 0) {
    console.log(`\nRun with --apply to write changes.`);
  }
}

run();
