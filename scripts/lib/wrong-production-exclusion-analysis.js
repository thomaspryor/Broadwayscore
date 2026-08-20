'use strict';

/**
 * BRO-75: analyzes exclusion-logger output for the `skippedWrongProduction`
 * reason to distinguish genuine over-blocking from log noise.
 *
 * Root cause found investigating beetlejuice-2022's reported 261/day volume:
 * rebuild-all-reviews.js re-logs `skippedWrongProduction` for every review
 * file that still carries `wrongProduction: true` on EVERY rebuild pass (the
 * flag is sticky — nothing clears it once set, see rebuild-all-reviews.js
 * ~line 2805). beetlejuice-2022 has 94 files flagged wrongProduction, all
 * touring/prior-run reviews correctly excluded (2019 NYT/Post/Vulture
 * reviews of the original run, scraped into the 2022 return-engagement show
 * ID; BWW national-tour city reviews). 94 files x ~3 rebuild runs/day ≈ 261
 * log lines — the same known-bad files re-logged, not 261 new mistakes.
 * moulin-rouge-the-musical-west-end-2021 (82/114 flagged) and
 * pretty-woman-the-musical-2018 (75/129 flagged) show the identical pattern.
 */

/**
 * Parse a raw exclusions-YYYY-MM-DD.jsonl file (or any JSONL text) into an
 * array of exclusion-logger records. Skips blank lines and non-JSON lines.
 */
function parseExclusionLog(jsonlText) {
  const records = [];
  for (const line of String(jsonlText || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // not a JSON line (e.g. a stray log header) — skip
    }
  }
  return records;
}

/**
 * Group wrongProduction exclusion records by show, tracking both the raw
 * log-line count and the count of DISTINCT (showId, file) pairs.
 *
 * Why the distinction matters: a show with N already-flagged files and R
 * rebuild runs in a day logs ~N*R lines even though zero NEW reviews were
 * excluded that day. Raw volume alone can't tell "newly over-blocking this
 * show" apart from "rebuild ran a few times and re-logged the same
 * known-bad files."
 */
function summarizeByShow(records) {
  const byShow = new Map();
  for (const rec of records) {
    if (!rec || rec.reason !== 'skippedWrongProduction') continue;
    const showId = rec.showId || 'unknown';
    if (!byShow.has(showId)) {
      byShow.set(showId, { showId, totalLines: 0, files: new Set() });
    }
    const entry = byShow.get(showId);
    entry.totalLines++;
    entry.files.add(rec.file || '-');
  }
  return byShow;
}

const DEFAULT_REPEAT_THRESHOLD = 1.5;
const DEFAULT_DISTINCT_FILE_THRESHOLD = 10;

/**
 * Categorize one show's exclusion volume.
 *
 * - REPEATED_LOGGING: the same small set of files re-logged across multiple
 *   rebuild runs (high totalLines, low distinct-file-to-line ratio). Not
 *   evidence of over-blocking — log noise from a sticky flag.
 * - NEEDS_REVIEW: many DISTINCT files excluded, each close to once. A real
 *   signal of newly-excluded content — warrants a content-level audit (see
 *   scripts/audit-wrong-production.js).
 * - NORMAL: low volume either way.
 */
function categorizeShow(entry, opts = {}) {
  const repeatThreshold = opts.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  const distinctFileThreshold = opts.distinctFileThreshold ?? DEFAULT_DISTINCT_FILE_THRESHOLD;

  const distinctFiles = entry.files.size;
  const repeatMultiplier = distinctFiles > 0 ? entry.totalLines / distinctFiles : 0;

  let category;
  if (repeatMultiplier >= repeatThreshold) {
    category = 'REPEATED_LOGGING';
  } else if (distinctFiles >= distinctFileThreshold) {
    category = 'NEEDS_REVIEW';
  } else {
    category = 'NORMAL';
  }

  return {
    showId: entry.showId,
    totalLines: entry.totalLines,
    distinctFiles,
    repeatMultiplier: Math.round(repeatMultiplier * 100) / 100,
    category,
  };
}

/**
 * Full pipeline: JSONL text -> per-show categorized summaries, sorted by
 * total log volume descending (matches how "top shows by exclusion count"
 * gets read).
 */
function analyzeExclusionLog(jsonlText, opts) {
  const records = parseExclusionLog(jsonlText);
  const byShow = summarizeByShow(records);
  const results = [];
  for (const entry of byShow.values()) {
    results.push(categorizeShow(entry, opts));
  }
  results.sort((a, b) => b.totalLines - a.totalLines);
  return results;
}

module.exports = {
  parseExclusionLog,
  summarizeByShow,
  categorizeShow,
  analyzeExclusionLog,
};
