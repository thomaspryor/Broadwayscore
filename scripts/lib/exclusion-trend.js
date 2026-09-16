'use strict';

const fs = require('fs');
const path = require('path');
const { parseExclusionLog } = require('./wrong-production-exclusion-analysis');

/**
 * BRO-2379: generalizes the sticky-flag repeat-vs-new categorization built
 * for skippedWrongProduction (BRO-75, see wrong-production-exclusion-analysis.js)
 * to EVERY exclusion reason, and wires it into the daily digest's exclusion
 * trend (send-daily-digest.js's computeExclusionTrend).
 *
 * BRO-75's root cause wasn't specific to wrongProduction: rebuild-all-reviews.js
 * re-logs an exclusion for every review file that still carries its exclusion
 * flag on EVERY rebuild pass, because the flag is sticky (nothing clears it
 * once set). That inflates a reason's raw per-day line count with the SAME
 * already-known files being re-logged across rebuild runs, not new mistakes —
 * and that mechanism applies to any sticky exclusion flag, not just
 * wrongProduction. computeExclusionTrend's original mean/stdev spike detector
 * only saw raw per-reason volume, so it was exposed to the exact false-alarm
 * shape BRO-75 found (skippedWrongProduction=40,322 lines, 77% of all
 * exclusions, almost entirely re-logging of already-known files).
 */

const DEFAULT_AUDIT_DIR = process.env.EXCLUSION_LOGGER_AUDIT_DIR
  || path.join(__dirname, '..', '..', 'data', 'audit');

/**
 * Group exclusion-logger records by (reason, showId), tracking a per-file
 * line count so callers can tell "one file re-logged N times" apart from
 * "N distinct files logged once" — and, with a knownFiles ledger, how many
 * of today's LINES (not just files) belong to genuinely new exclusions.
 */
function summarizeByReasonAndShow(records) {
  const groups = new Map(); // `${reason}::${showId}` -> {reason, showId, fileCounts: Map<file,count>}
  for (const rec of records) {
    if (!rec) continue;
    const reason = rec.reason || 'unknown';
    const showId = rec.showId || 'unknown';
    const file = rec.file || '-';
    const key = `${reason}::${showId}`;
    if (!groups.has(key)) {
      groups.set(key, { reason, showId, fileCounts: new Map() });
    }
    const entry = groups.get(key);
    entry.fileCounts.set(file, (entry.fileCounts.get(file) || 0) + 1);
  }
  return groups;
}

const DEFAULT_REPEAT_THRESHOLD = 1.5;
const DEFAULT_DISTINCT_FILE_THRESHOLD = 10;
const DEFAULT_NEW_FILE_THRESHOLD = 1;

/**
 * Categorize one (reason, showId) group — same thresholds/semantics as
 * wrong-production-exclusion-analysis.js's categorizeShow, generalized to
 * carry the reason through and to report new LINE volume (not just new file
 * count) when a knownFiles ledger is supplied, since that's what a
 * volume-based spike detector needs.
 */
function categorizeGroup(entry, opts = {}) {
  const repeatThreshold = opts.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  const distinctFileThreshold = opts.distinctFileThreshold ?? DEFAULT_DISTINCT_FILE_THRESHOLD;
  const newFileThreshold = opts.newFileThreshold ?? DEFAULT_NEW_FILE_THRESHOLD;

  const distinctFiles = entry.fileCounts.size;
  const totalLines = [...entry.fileCounts.values()].reduce((a, b) => a + b, 0);
  const repeatMultiplier = distinctFiles > 0 ? totalLines / distinctFiles : 0;

  let newFileCount = null;
  let newLineCount = null;
  if (opts.knownFiles instanceof Set) {
    newFileCount = 0;
    newLineCount = 0;
    for (const [file, count] of entry.fileCounts) {
      if (!opts.knownFiles.has(file)) {
        newFileCount++;
        newLineCount += count;
      }
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
    reason: entry.reason,
    showId: entry.showId,
    totalLines,
    distinctFiles,
    repeatMultiplier: Math.round(repeatMultiplier * 100) / 100,
    ...(newFileCount !== null ? { newFileCount, newLineCount } : {}),
    category,
  };
}

/**
 * Full pipeline: JSONL text -> per-(reason, showId) categorized summaries,
 * sorted by total log volume descending.
 *
 * `opts.knownFilesByReasonAndShow` (the cross-day ledger — see
 * buildNextLedger) is `{ [reason]: { [showId]: string[] | Set<string> } }`,
 * forwarded per-group as `knownFiles` to categorizeGroup.
 */
function analyzeExclusionLog(jsonlText, opts = {}) {
  const records = parseExclusionLog(jsonlText);
  const groups = summarizeByReasonAndShow(records);
  const results = [];
  for (const entry of groups.values()) {
    const perGroupOpts = { ...opts };
    delete perGroupOpts.knownFilesByReasonAndShow;
    if (opts.knownFilesByReasonAndShow) {
      const byShow = opts.knownFilesByReasonAndShow[entry.reason];
      const raw = byShow instanceof Map ? byShow.get(entry.showId) : byShow && byShow[entry.showId];
      if (raw) perGroupOpts.knownFiles = raw instanceof Set ? raw : new Set(raw);
    }
    results.push(categorizeGroup(entry, perGroupOpts));
  }
  results.sort((a, b) => b.totalLines - a.totalLines);
  return results;
}

/**
 * Build the next cross-day ledger snapshot: union of everything previously
 * known with everything seen in today's log, per (reason, showId). The
 * generalized counterpart of wrong-production-exclusion-analysis.js's
 * buildNextLedger — nested one level deeper by reason.
 */
function buildNextLedger(records, previousLedger = {}) {
  const groups = summarizeByReasonAndShow(records);
  const groupList = [...groups.values()];
  const next = {};
  const reasons = new Set([...Object.keys(previousLedger), ...groupList.map((g) => g.reason)]);
  for (const reason of reasons) {
    const prevByShow = previousLedger[reason] || {};
    const reasonGroups = groupList.filter((g) => g.reason === reason);
    const showIds = new Set([...Object.keys(prevByShow), ...reasonGroups.map((g) => g.showId)]);
    const nextByShow = {};
    for (const showId of showIds) {
      const known = new Set(prevByShow[showId] || []);
      const entry = groups.get(`${reason}::${showId}`);
      if (entry) for (const file of entry.fileCounts.keys()) known.add(file);
      nextByShow[showId] = [...known].sort();
    }
    next[reason] = nextByShow;
  }
  return next;
}

/**
 * Daily digest exclusion trend: aggregates exclusion-logger JSONL entries
 * from today + the last 7 days (baseline) per reason, and surfaces today's
 * top reasons, reasons >2sigma above the 7-day mean (spike detection), and
 * reasons first seen within 7 days (novel).
 *
 * Each reason's spike verdict is cross-checked against the generalized
 * sticky-flag categorization above: if every bit of a reason's volume today
 * is REPEATED_LOGGING or NORMAL (no NEEDS_REVIEW group contributed any new
 * line), the raw-count spike is suppressed — that shape is re-logging of
 * already-known files, not a real new problem (the BRO-75 false alarm).
 *
 * opts.auditDir / opts.ledgerFile let callers (tests) point this at a
 * fixture directory instead of the real data/audit; opts.persistLedger
 * (default true) lets callers skip writing the ledger back to disk.
 */
function computeExclusionTrend(now, opts = {}) {
  const auditDir = opts.auditDir || DEFAULT_AUDIT_DIR;
  const ledgerFile = opts.ledgerFile || path.join(auditDir, 'exclusion-seen-files.json');
  const persistLedger = opts.persistLedger !== false;

  const todayKey = new Date(now).toISOString().slice(0, 10);
  const days = [];
  for (let i = 0; i < 8; i++) {
    days.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  const perDay = new Map(); // day -> Map<reason, count>
  const firstSeen = new Map(); // reason -> day
  let todayRawText = '';

  for (const day of days) {
    const p = path.join(auditDir, `exclusions-${day}.jsonl`);
    if (!fs.existsSync(p)) continue;
    let content;
    try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (day === todayKey) todayRawText = content;
    const dayCounts = new Map();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const reason = rec.reason || 'unknown';
      dayCounts.set(reason, (dayCounts.get(reason) || 0) + 1);
      if (!firstSeen.has(reason) || day < firstSeen.get(reason)) {
        firstSeen.set(reason, day);
      }
    }
    perDay.set(day, dayCounts);
  }

  const today = perDay.get(todayKey) || new Map();
  const pastDays = days.slice(1).filter((d) => perDay.has(d));
  const allReasons = new Set([...today.keys(), ...pastDays.flatMap((d) => [...perDay.get(d).keys()])]);

  let previousLedger = {};
  try {
    previousLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  } catch {
    // no ledger yet — first run falls back to the same-day repeat-ratio heuristic
  }

  const categorized = analyzeExclusionLog(todayRawText, { knownFilesByReasonAndShow: previousLedger });
  const breakdownByReason = new Map(); // reason -> {newLines, repeatedLines, needsReviewShows}
  for (const g of categorized) {
    if (!breakdownByReason.has(g.reason)) {
      breakdownByReason.set(g.reason, { newLines: 0, repeatedLines: 0, needsReviewShows: [] });
    }
    const b = breakdownByReason.get(g.reason);
    if (g.category === 'NEEDS_REVIEW') {
      b.needsReviewShows.push(g.showId);
      const newLines = g.newLineCount ?? g.totalLines; // no ledger yet: trust the ratio heuristic fully
      b.newLines += newLines;
      b.repeatedLines += g.totalLines - newLines;
    } else {
      b.repeatedLines += g.totalLines;
    }
  }

  if (persistLedger && todayRawText) {
    try {
      const nextLedger = buildNextLedger(parseExclusionLog(todayRawText), previousLedger);
      fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
      fs.writeFileSync(ledgerFile, JSON.stringify(nextLedger, null, 2));
    } catch (err) {
      // The ledger is a best-effort optimization for spike detection — a
      // write failure shouldn't take down the whole digest.
      process.stderr.write(`[exclusion-trend] ledger write failed: ${err.message}\n`);
    }
  }

  const trend = [];
  for (const reason of allReasons) {
    const todayCount = today.get(reason) || 0;
    const pastCounts = pastDays.map((d) => (perDay.get(d) || new Map()).get(reason) || 0);
    const mean = pastCounts.length ? pastCounts.reduce((a, b) => a + b, 0) / pastCounts.length : 0;
    const variance = pastCounts.length
      ? pastCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / pastCounts.length
      : 0;
    const stdev = Math.sqrt(variance);
    const threshold = mean + 2 * stdev;
    const breakdown = breakdownByReason.get(reason);
    const stickyRepeatOnly = !!breakdown && breakdown.newLines === 0 && breakdown.repeatedLines > 0;
    const spike = todayCount > threshold && todayCount >= 5 && !stickyRepeatOnly;
    const novel = firstSeen.get(reason) >= days[6]; // first seen within last 7 days
    trend.push({
      reason,
      todayCount,
      mean: Math.round(mean * 10) / 10,
      stdev: Math.round(stdev * 10) / 10,
      threshold: Math.round(threshold * 10) / 10,
      spike,
      novel,
      firstSeen: firstSeen.get(reason),
      ...(breakdown ? {
        newLines: breakdown.newLines,
        repeatedLines: breakdown.repeatedLines,
        needsReviewShows: breakdown.needsReviewShows,
      } : {}),
    });
  }

  const spikes = trend.filter((t) => t.spike).sort((a, b) => b.todayCount - a.todayCount);
  const novelReasons = trend.filter((t) => t.novel && t.todayCount > 0).sort((a, b) => b.todayCount - a.todayCount);
  const topToday = trend.filter((t) => t.todayCount > 0).sort((a, b) => b.todayCount - a.todayCount).slice(0, 10);

  return { spikes, novelReasons, topToday, todayTotal: [...today.values()].reduce((a, b) => a + b, 0) };
}

module.exports = {
  DEFAULT_AUDIT_DIR,
  summarizeByReasonAndShow,
  categorizeGroup,
  analyzeExclusionLog,
  buildNextLedger,
  computeExclusionTrend,
};
