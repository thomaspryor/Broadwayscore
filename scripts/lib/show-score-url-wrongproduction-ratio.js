'use strict';

const fs = require('fs');
const path = require('path');

// Report stored flags, not a new production verdict. A file flagged both at
// the top level and by content verification contributes only once.
function countWrongProductionFiles(reviewTextsDir, showId) {
  const counts = { totalFiles: 0, wrongProductionFiles: 0, unreadableFiles: 0, unavailable: false };
  const showDir = path.join(reviewTextsDir, showId);
  let entries;
  try {
    entries = fs.readdirSync(showDir, { withFileTypes: true });
  } catch {
    counts.unavailable = true;
    return counts;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    counts.totalFiles++;
    try {
      const review = JSON.parse(fs.readFileSync(path.join(showDir, entry.name), 'utf8'));
      if (review?.wrongProduction === true || review?.contentVerification?.wrongProduction === true) {
        counts.wrongProductionFiles++;
      }
    } catch {
      // Keep all JSON files in the denominator, but disclose incomplete data.
      counts.unreadableFiles++;
    }
  }
  return counts;
}

function formatWrongProductionRatio(counts) {
  if (counts.unavailable) return 'wrongProduction: n/a (review-texts unavailable)';
  const { totalFiles, wrongProductionFiles, unreadableFiles } = counts;
  const percent = totalFiles ? `${(100 * wrongProductionFiles / totalFiles).toFixed(1)}%` : 'n/a';
  const incomplete = unreadableFiles ? `; ${unreadableFiles} unreadable` : '';
  return `wrongProduction: ${wrongProductionFiles}/${totalFiles} files (${percent}${incomplete})`;
}

module.exports = { countWrongProductionFiles, formatWrongProductionRatio };
