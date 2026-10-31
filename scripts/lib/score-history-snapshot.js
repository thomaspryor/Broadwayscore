'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_OUTFILE = path.resolve(__dirname, '../../data/audit/score-history.jsonl');

/**
 * Record today's composite score + review count for each show.
 * Appends one JSONL line per show per day; dedupes by (date, showId).
 *
 * @param {Object[]} shows - Array of show objects from shows.json
 * @param {string} [outfile] - Path to the JSONL file (default: data/audit/score-history.jsonl)
 */
function recordDailySnapshot(shows, outfile = DEFAULT_OUTFILE) {
  const today = new Date().toISOString().slice(0, 10);

  // Read existing entries to dedupe
  const existing = new Set();
  if (fs.existsSync(outfile)) {
    const lines = fs.readFileSync(outfile, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        existing.add(`${entry.date}:${entry.showId}`);
      } catch (_) {}
    }
  } else {
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
  }

  const newLines = [];
  for (const show of shows) {
    if (!show.id) continue;
    const key = `${today}:${show.id}`;
    if (existing.has(key)) continue;

    newLines.push(JSON.stringify({
      date: today,
      showId: show.id,
      compositeScore: show.compositeScore ?? null,
      reviewCount: show.reviewCount ?? null,
    }));
  }

  if (newLines.length > 0) {
    fs.appendFileSync(outfile, newLines.join('\n') + '\n');
  }

  return { recorded: newLines.length, skipped: shows.length - newLines.length };
}

module.exports = { recordDailySnapshot };
