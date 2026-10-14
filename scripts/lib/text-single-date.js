/**
 * Strict single-date extractor for the head of an article (extracted from
 * scripts/backfill-text-dates.js, BRO-4252). Full month names only, exactly one
 * non-run-date match in the first 500 chars, else null.
 */
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

// Words that precede show-run/closing dates, not publish dates.
// "Through March 5" = show runs through that date. "Until April 2" = booking window.
const RUN_DATE_WORDS = /\b(through|until|closing|effective|expires|ends|extended|running|booking|playing|performances?)\b/i;

function extractSingleDate(text) {
  const header = text.substring(0, HEADER_CHARS);
  const allMatches = [];

  for (const pat of PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(header)) !== null) {
      // Check the 50 chars before the match for run-date context words
      const before = header.substring(Math.max(0, m.index - 50), m.index).toLowerCase();
      if (RUN_DATE_WORDS.test(before)) continue; // skip — this is a show-run date
      allMatches.push(m[0]);
    }
  }

  // Only proceed if exactly one non-run-date match found
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

module.exports = { extractSingleDate };
