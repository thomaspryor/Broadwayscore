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
const DEFAULT_NEW_FILE_THRESHOLD = 1;

/**
 * Categorize one show's exclusion volume.
 *
 * `opts.knownFiles` (a Set of filenames already flagged as of a PRIOR day,
 * loaded from the cross-day ledger — see loadSeenLedger/CLI wrapper) is what
 * makes this actually distinguish new mistakes from stale re-logging.
 * Without it, a same-day repeat count alone can't tell "flagged for the
 * first time this morning, re-logged on the next 2 rebuild passes" (3 lines,
 * 1 file, repeatMultiplier 3 — indistinguishable from a file that's been
 * flagged for months) from genuine staleness. When `knownFiles` is provided:
 *
 * - NEEDS_REVIEW: at least one file in today's log is NOT in `knownFiles` —
 *   a genuinely new exclusion, regardless of how noisy the rest of the
 *   show's re-logging is. This is the case a pure repeat-ratio heuristic
 *   masks (see analyzeExclusionLog's `newFiles` plumbing).
 * - REPEATED_LOGGING: every file in today's log is already in `knownFiles`
 *   and got re-logged across multiple rebuild passes. Log noise, not
 *   over-blocking.
 * - NORMAL: low volume, nothing new.
 *
 * Without `knownFiles` (single-day snapshot, e.g. a first run with no
 * ledger yet), falls back to the same-day repeat-ratio heuristic: a high
 * totalLines/distinctFiles ratio still doesn't prove staleness, but it's the
 * best available signal until a ledger exists.
 */
function categorizeShow(entry, opts = {}) {
  const repeatThreshold = opts.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  const distinctFileThreshold = opts.distinctFileThreshold ?? DEFAULT_DISTINCT_FILE_THRESHOLD;
  const newFileThreshold = opts.newFileThreshold ?? DEFAULT_NEW_FILE_THRESHOLD;

  const distinctFiles = entry.files.size;
  const repeatMultiplier = distinctFiles > 0 ? entry.totalLines / distinctFiles : 0;

  let newFileCount = null;
  if (opts.knownFiles instanceof Set) {
    newFileCount = 0;
    for (const file of entry.files) {
      if (!opts.knownFiles.has(file)) newFileCount++;
    }
  }

  let category;
  if (newFileCount !== null) {
    // Ledger available: new-file evidence takes priority over repeat noise.
    category = newFileCount >= newFileThreshold ? 'NEEDS_REVIEW' : 'REPEATED_LOGGING';
    if (newFileCount === 0 && repeatMultiplier < repeatThreshold) category = 'NORMAL';
  } else if (repeatMultiplier >= repeatThreshold) {
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
    ...(newFileCount !== null ? { newFileCount } : {}),
    category,
  };
}

/**
 * Full pipeline: JSONL text -> per-show categorized summaries, sorted by
 * total log volume descending (matches how "top shows by exclusion count"
 * gets read).
 *
 * `opts.knownFilesByShow` (Map<showId, Set<file>> | Record<showId, string[]>)
 * is forwarded per-show as `knownFiles` to categorizeShow — pass the
 * cross-day ledger here to get real new-vs-stale categorization.
 */
function analyzeExclusionLog(jsonlText, opts = {}) {
  const records = parseExclusionLog(jsonlText);
  const byShow = summarizeByShow(records);
  const results = [];
  for (const entry of byShow.values()) {
    const perShowOpts = { ...opts };
    delete perShowOpts.knownFilesByShow;
    if (opts.knownFilesByShow) {
      const raw = opts.knownFilesByShow instanceof Map
        ? opts.knownFilesByShow.get(entry.showId)
        : opts.knownFilesByShow[entry.showId];
      if (raw) perShowOpts.knownFiles = raw instanceof Set ? raw : new Set(raw);
    }
    results.push(categorizeShow(entry, perShowOpts));
  }
  results.sort((a, b) => b.totalLines - a.totalLines);
  return results;
}

/**
 * Build the next cross-day ledger snapshot: union of everything previously
 * known with everything seen in today's log, per show. The CLI wrapper
 * persists this to disk so tomorrow's run can tell new files from old ones.
 */
function buildNextLedger(records, previousLedger = {}) {
  const byShow = summarizeByShow(records);
  const next = {};
  const showIds = new Set([...Object.keys(previousLedger), ...byShow.keys()]);
  for (const showId of showIds) {
    const known = new Set(previousLedger[showId] || []);
    const entry = byShow.get(showId);
    if (entry) for (const file of entry.files) known.add(file);
    next[showId] = [...known].sort();
  }
  return next;
}

module.exports = {
  parseExclusionLog,
  summarizeByShow,
  categorizeShow,
  analyzeExclusionLog,
  buildNextLedger,
};
