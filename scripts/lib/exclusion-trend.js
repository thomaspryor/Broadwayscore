'use strict';

const fs = require('fs');
const path = require('path');
const { readDailyTotals } = require('./rebuild-exclusion-audit');

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

/** Parse JSONL, ignoring blank lines and non-JSON log headers. */
function parseExclusionLog(jsonlText) {
  const records = [];
  for (const line of String(jsonlText || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return records;
}

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
 * Shared categorizer for (reason, showId) groups and the narrow
 * wrong-production compatibility API. Reports new LINE volume as well as
 * new file count when per-file counts and a knownFiles ledger are supplied,
 * since that's what a volume-based spike detector needs.
 */
// exclusion-logger.js defaults `file` to '-' when a reason has no per-file
// identity (e.g. show-level reasons like skippedUpcomingShows/skippedPreviewsShows,
// and some callers of skippedBlockedUrl/skippedCrossShowUrl) — every event
// from every rebuild pass looks like the identical "file". Treating '-' as a
// real filename would mean the FIRST time a show logs a '-' reason, it goes
// into the ledger as "known" and every later occurrence — including a
// genuinely new one — reads as REPEATED_LOGGING forever after. '-' carries no
// distinguishing information, so it must never be evidence either way.
const NO_FILE_IDENTITY = '-';

// Aggregate-only callers may pass { files: Set, totalLines } instead of
// fileCounts. Their new-file count is known, but new-line volume is not.
// includeUnidentifiedFiles preserves the original narrow tool's '-' behavior;
// the daily digest keeps its stricter identity handling by default.
function categorizeGroup(entry, opts = {}) {
  const repeatThreshold = opts.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  const distinctFileThreshold = opts.distinctFileThreshold ?? DEFAULT_DISTINCT_FILE_THRESHOLD;
  const newFileThreshold = opts.newFileThreshold ?? DEFAULT_NEW_FILE_THRESHOLD;

  const files = entry.fileCounts ? [...entry.fileCounts.keys()] : [...entry.files];
  const distinctFiles = files.length;
  const totalLines = entry.fileCounts
    ? [...entry.fileCounts.values()].reduce((a, b) => a + b, 0)
    : entry.totalLines;
  const repeatMultiplier = distinctFiles > 0 ? totalLines / distinctFiles : 0;
  const realFiles = files.filter((file) => opts.includeUnidentifiedFiles || file !== NO_FILE_IDENTITY);
  const hasFileIdentity = realFiles.length > 0;
  // Sentinel-tagged lines (file:'-') carry zero repeat-vs-new evidence —
  // never fold them into "repeated" volume, even when the SAME reason also
  // has real-filed lines in this group (some callers of skippedBlockedUrl /
  // skippedCrossShowUrl pass a real file, others pass '-' — see
  // scripts/gather-reviews.js vs scripts/rebuild-all-reviews.js). Exposed so
  // computeExclusionTrend can always attribute this volume as new.
  const sentinelLineCount = opts.includeUnidentifiedFiles ? 0 : (entry.fileCounts?.get(NO_FILE_IDENTITY) || 0);

  let newFileCount = null;
  let newLineCount = null;
  if (opts.knownFiles instanceof Set && (hasFileIdentity || opts.includeUnidentifiedFiles)) {
    newFileCount = 0;
    if (entry.fileCounts) newLineCount = 0;
    for (const file of realFiles) {
      if (!opts.knownFiles.has(file)) {
        newFileCount++;
        if (entry.fileCounts) newLineCount += entry.fileCounts.get(file);
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
    hasFileIdentity,
    sentinelLineCount,
    ...(newFileCount !== null ? { newFileCount } : {}),
    ...(newLineCount !== null ? { newLineCount } : {}),
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
    if (opts.knownFilesByReasonAndShow && Object.prototype.hasOwnProperty.call(opts.knownFilesByReasonAndShow, entry.reason)) {
      // A ledger entry exists for this REASON — an absent showId within it
      // means "this show has never logged this reason before" (a real,
      // definitively empty known-files set), not "no data available". Only
      // an entirely-missing reason (never ledgered at all) falls through to
      // the same-day ratio heuristic below. Getting this wrong would let a
      // brand-new show's first-ever occurrence of a KNOWN reason fall back
      // to the ratio heuristic and get misread as REPEATED_LOGGING.
      const byShow = opts.knownFilesByReasonAndShow[entry.reason];
      const raw = byShow instanceof Map ? byShow.get(entry.showId) : byShow[entry.showId];
      perGroupOpts.knownFiles = raw instanceof Set ? raw : new Set(raw || []);
    }
    results.push(categorizeGroup(entry, perGroupOpts));
  }
  results.sort((a, b) => b.totalLines - a.totalLines);
  return results;
}

/**
 * Build the next cross-day ledger snapshot: union of everything previously
 * known with everything seen in today's log, per (reason, showId). The
 * narrow compatibility wrapper adapts this reason-keyed result to its
 * per-show shape and passes includeUnidentifiedFiles to retain '-' entries.
 */
function buildNextLedger(records, previousLedger = {}, opts = {}) {
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
      if (entry) {
        for (const file of entry.fileCounts.keys()) {
          if (opts.includeUnidentifiedFiles || file !== NO_FILE_IDENTITY) known.add(file);
        }
      }
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
/**
 * BRO-3598: trend from rebuild-all-reviews.js's committed per-reason daily
 * totals (data/audit/exclusion-daily-totals.json), for runs that have no
 * exclusions-*.jsonl at all (daily-digest.yml, data-health-check.yml: fresh
 * checkouts — the JSONL lives only on the runner that wrote it).
 *
 * Each day's entry is the latest full rebuild's DISTINCT excluded-file count
 * per reason, a whole-corpus snapshot rather than a sum of re-logged lines,
 * so the BRO-75 repeat-logging inflation cannot occur here: "new" is simply
 * growth over the previous recorded day. Same return shape as the JSONL path.
 */
const TOTALS_MAX_AGE_DAYS = 2;

function computeTrendFromDailyTotals(doc, now) {
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const days = Object.keys((doc && doc.days) || {}).filter((d) => d <= todayKey).sort();
  const empty = { spikes: [], novelReasons: [], topToday: [], todayTotal: 0, source: 'daily-totals', day: null };
  if (days.length === 0) return empty;
  const day = days[days.length - 1];
  // Totals stop moving when the rebuild stops recording them; an old snapshot
  // must read as "no data", never as today's quiet baseline.
  if (Date.parse(todayKey) - Date.parse(day) > TOTALS_MAX_AGE_DAYS * 86400000) {
    return { ...empty, stale: true, day };
  }
  const baselineDays = days.slice(0, -1).slice(-7);
  const today = doc.days[day] || {};
  const prev = baselineDays.length ? doc.days[baselineDays[baselineDays.length - 1]] || {} : null;
  const reasons = new Set([...Object.keys(today), ...baselineDays.flatMap((d) => Object.keys(doc.days[d] || {}))]);
  const trend = [];
  for (const reason of reasons) {
    const todayCount = (today[reason] && today[reason].files) || 0;
    const pastCounts = baselineDays.map((d) => ((doc.days[d] || {})[reason] || {}).files || 0);
    const mean = pastCounts.length ? pastCounts.reduce((a, b) => a + b, 0) / pastCounts.length : 0;
    const stdev = pastCounts.length
      ? Math.sqrt(pastCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / pastCounts.length)
      : 0;
    const threshold = mean + 2 * stdev;
    const prevCount = prev ? ((prev[reason] || {}).files || 0) : todayCount;
    const newLines = Math.max(0, todayCount - prevCount);
    // A snapshot series is often flat (stdev 0), so +1 file would clear
    // mean+2σ; require a real jump of at least 5 files as well.
    const spike = pastCounts.length > 0 && todayCount > threshold && todayCount - mean >= Math.max(5, 2 * stdev);
    const seenBefore = baselineDays.some((d) => (doc.days[d] || {})[reason]);
    const novel = baselineDays.length > 0 && !seenBefore && todayCount > 0;
    const prevTop = (prev && prev[reason] && prev[reason].topShows) || {};
    const growingShows = Object.entries((today[reason] && today[reason].topShows) || {})
      .filter(([id, n]) => prev && n > (prevTop[id] || 0))
      .map(([id]) => id);
    trend.push({
      reason,
      todayCount,
      mean: Math.round(mean * 10) / 10,
      stdev: Math.round(stdev * 10) / 10,
      threshold: Math.round(threshold * 10) / 10,
      spike,
      novel,
      firstSeen: seenBefore ? baselineDays.find((d) => (doc.days[d] || {})[reason]) : day,
      newLines,
      repeatedLines: todayCount - newLines,
      needsReviewShows: growingShows,
    });
  }
  return {
    spikes: trend.filter((t) => t.spike).sort((a, b) => b.todayCount - a.todayCount),
    novelReasons: trend.filter((t) => t.novel).sort((a, b) => b.todayCount - a.todayCount),
    topToday: trend.filter((t) => t.todayCount > 0).sort((a, b) => b.todayCount - a.todayCount).slice(0, 10),
    todayTotal: trend.reduce((a, t) => a + t.todayCount, 0),
    source: 'daily-totals',
    day,
  };
}

function computeExclusionTrend(now, opts = {}) {
  const auditDir = opts.auditDir || DEFAULT_AUDIT_DIR;
  // BRO-3598: no JSONL for any of the window's days means a fresh checkout
  // (the scheduled digest), where the trend used to be silently empty forever.
  const windowHasJsonl = Array.from({ length: 8 }, (_, i) => new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10))
    .some((d) => fs.existsSync(path.join(auditDir, `exclusions-${d}.jsonl`)));
  if (!windowHasJsonl) {
    return computeTrendFromDailyTotals(readDailyTotals(auditDir), now);
  }
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
    // Sentinel-tagged lines (file:'-') carry zero repeat-vs-new evidence —
    // always attribute them as new, even in a group that ALSO has real
    // files (some callers of the same reason pass a real file, others
    // pass '-' — see categorizeGroup's sentinelLineCount comment). Counting
    // them as "new" rather than trusting a same-day-only ratio keeps raw
    // mean/stdev spike detection intact (not sticky-suppressed) for volume
    // this mechanism has no basis to call stale.
    b.newLines += g.sentinelLineCount;
    const realTotalLines = g.totalLines - g.sentinelLineCount;
    if (realTotalLines === 0) {
      // nothing else to categorize — this group was 100% sentinel-tagged
    } else if (g.category === 'NEEDS_REVIEW') {
      b.needsReviewShows.push(g.showId);
      const newLines = g.newLineCount ?? realTotalLines; // no ledger yet: trust the ratio heuristic fully
      b.newLines += newLines;
      b.repeatedLines += realTotalLines - newLines;
    } else {
      b.repeatedLines += realTotalLines;
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
  parseExclusionLog,
  summarizeByReasonAndShow,
  categorizeGroup,
  analyzeExclusionLog,
  buildNextLedger,
  computeExclusionTrend,
  computeTrendFromDailyTotals,
};
