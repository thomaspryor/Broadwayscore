'use strict';

const fs = require('fs');
const path = require('path');
// Balusters ship-check P1 #5: use canonical generateReviewFilename from review-normalization
// so filenames match how rebuild and gather write them (handles aliases + prefix stripping).
let _generateReviewFilename;
try {
  ({ generateReviewFilename: _generateReviewFilename } = require('../review-normalization'));
} catch {
  _generateReviewFilename = null;
}
// Codex ship-check finding (2026-08-26): the fallback below must call the
// SAME predicate rebuild-all-reviews.js uses to decide inclusion, not a
// hand-rolled subset of flags. explainExclusion() already covers
// wrongProduction/wrongShow/duplicateOf/isRoundupArticle/contentTier=invalid
// AND their manual-clear/staleness overrides (wrongShowCleared,
// isLikelyStaleWrongShow, isLikelyStaleRoundupFlag, freshness-bounded
// auto-clears, circular-duplicate tiebreaking) — reimplementing any subset
// of that here would silently diverge from the real rebuild decision the
// moment one of those override paths fires (e.g. a manually-cleared
// wrongProduction flag would falsely read as still-excluded).
let _explainExclusion;
try {
  ({ explainExclusion: _explainExclusion } = require('../review-guards'));
} catch {
  _explainExclusion = null;
}

const name = 'review-count-match';
const description = 'Local review-texts file count matches reviews.json count (exclusion drift detection)';

const WARN_THRESHOLD = 1;
const ERROR_THRESHOLD = 5;

// Reasons that mean "the pipeline is broken," not "this file was correctly
// excluded" — a real logged reason still counts toward severity as if it
// were unexplained. 'not-logged' is the literal absence of a reason;
// 'skippedProcessingError' is a caught runtime exception (rebuild-all-
// reviews.js's generic catch block) — both are bug signals, and a systemic
// version of either (many files failing the same way) must still surface as
// 'error', not get laundered into 'warning' by having a technically-present
// reason string (Codex ship-check finding, task #1846 follow-up).
const BUG_SIGNAL_REASONS = new Set(['not-logged', 'skippedProcessingError']);

// explainExclusion() answers "is this includable in reviews.json", which is
// a broader question than this check's "is the absence explained by a real,
// specific reason". Its generic catch-all reasons fire even for a totally
// empty/malformed file ({} -> 'noTextOrScoreSignal') — exactly the case this
// check exists to catch, not explain away. Only reasons backed by a
// SPECIFIC persisted flag or signal count as an explanation here.
const GENERIC_EXPLAIN_EXCLUSION_REASONS = new Set([
  'no-data',
  'noTextOrScoreSignal',
  'wrongContentNoUsableSignal',
  'rejectedAt',
]);

/**
 * Fallback for when the daily exclusion JSONL has no entry for a file (e.g.
 * the full rebuild-all-reviews.js run that would have logged it didn't run
 * today/yesterday — CI's fast-rebuild path doesn't write this log). Calls
 * the canonical explainExclusion() predicate directly against the file's
 * current on-disk state, so a manually-cleared or stale flag is honored
 * exactly the way rebuild-all-reviews.js itself would honor it. Returns
 * null if the file is genuinely includable, or if explainExclusion only
 * found a generic/no-signal reason (making its absence from reviews.json
 * unexplained — a real bug signal), or if the predicate is unavailable.
 */
function deriveOnDiskExclusionReason(showDir, filename, show) {
  if (!_explainExclusion) return null;
  const filePath = path.join(showDir, filename);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  const reason = _explainExclusion(data, show, filePath);
  if (!reason || GENERIC_EXPLAIN_EXCLUSION_REASONS.has(reason)) return null;
  return `on-disk:${reason}`;
}

/**
 * Task #1846: severity tracks the UNEXPLAINED (bug-signal) portion of the
 * gap, not the raw gap. A large gap where every file carries a real,
 * legitimate logged reason (dedup, wrong-production, non-review, etc.) is
 * expected pipeline behavior, not an operator action item — only a
 * bug-signal reason (see BUG_SIGNAL_REASONS) is the actual silent-exclusion
 * class this check exists to catch.
 * @param {number} gap - localCount - builtCount
 * @param {number} unexplainedCount - how many of the gap files had a bug-signal reason
 * @returns {'ok'|'warning'|'error'}
 */
function computeGapSeverity(gap, unexplainedCount) {
  if (unexplainedCount >= ERROR_THRESHOLD) return 'error';
  if (unexplainedCount > 0) return 'warning';
  if (gap >= ERROR_THRESHOLD) return 'warning';
  return 'ok';
}

/**
 * Read today's and yesterday's exclusion JSONL and return a map of
 * filename → { reason, details } for the given show. Balusters postmortem meta-fix:
 * without per-file reasons the check's remediation hint is "go grep the rebuild log" —
 * during a live opening-night review this was invisible. Now every ghost review is
 * named with its exclusion reason up-front.
 */
function loadExclusionIndex(showId, now) {
  const auditDir = path.join(__dirname, '..', '..', '..', 'data', 'audit');
  const dayKeys = [];
  const dayNow = new Date(now);
  const dayPrev = new Date(now.getTime() - 86400000);
  dayKeys.push(dayNow.toISOString().slice(0, 10));
  dayKeys.push(dayPrev.toISOString().slice(0, 10));
  const index = new Map(); // basename → { reason, details }
  for (const day of dayKeys) {
    const p = path.join(auditDir, `exclusions-${day}.jsonl`);
    if (!fs.existsSync(p)) continue;
    let content;
    try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.showId !== showId) continue;
      if (!rec.file || rec.file === '-') continue;
      // Prefer newer exclusions; overwrite older
      const prev = index.get(rec.file);
      if (!prev || (prev.ts && rec.ts && rec.ts > prev.ts)) {
        index.set(rec.file, { reason: rec.reason || 'unknown', ts: rec.ts, details: rec.details });
      }
    }
  }
  return index;
}

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  const showDir = path.join(context.reviewTextsRoot, show.id);

  if (!fs.existsSync(showDir)) {
    // No review-texts dir yet — normal pre-opening
    return { ok: true, severity: 'ok', message: 'No review-texts directory yet — skipping count check' };
  }

  let localFiles;
  try {
    localFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  } catch (err) {
    return { ok: true, severity: 'ok', message: `Could not read review-texts dir: ${err.message}` };
  }

  const localCount = localFiles.length;
  const reviewsForShow = context.reviewsDoc[show.id] || [];
  const builtCount = reviewsForShow.length;
  const gap = localCount - builtCount;

  if (gap <= 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `review-texts (${localCount}) matches reviews.json (${builtCount}) — no exclusion drift`,
    };
  }

  // gap > 0: local files exist that were excluded from rebuild.
  // Balusters postmortem meta-fix — load today's exclusion log and name each ghost.
  const exclusionIndex = loadExclusionIndex(show.id, context.now || new Date());
  // Build set of review-text filenames that are represented in reviews.json so we can
  // find the absentees (files on disk not in reviews.json).
  const filenamesInBuild = new Set();
  for (const r of reviewsForShow) {
    if (r.__sourceFile) filenamesInBuild.add(r.__sourceFile);
    if (r.sourceFile) filenamesInBuild.add(r.sourceFile);
    // Canonical filename (outlet--critic.json) via review-normalization so aliases
    // and prefix-stripping match how the actual file was written. Falls back to
    // naive slug if the lib is unavailable (unit-test environment).
    if (r.outletId && r.criticName) {
      if (_generateReviewFilename) {
        try { filenamesInBuild.add(_generateReviewFilename(r.outletId, r.criticName)); } catch { /* fall through */ }
      }
      const slug = String(r.criticName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      filenamesInBuild.add(`${r.outletId}--${slug}.json`);
    }
  }
  const absentees = localFiles.filter(f => !filenamesInBuild.has(f));
  const reasons = {};
  const named = [];
  for (const f of absentees) {
    const info = exclusionIndex.get(f);
    // Prefer CURRENT on-disk state over the log: the log is an append-only
    // snapshot from whenever the file was last excluded, which can predate a
    // later manual clear or re-flag — trusting a stale log entry over the
    // live file would launder today's real regression as an old, resolved
    // exclusion (Codex ship-check finding, 2026-08-26). Only fall back to
    // the log's reason (e.g. 'skippedProcessingError', a transient runtime
    // exception with no corresponding persisted flag) when the file's
    // current state doesn't explain the absence on its own.
    const onDiskReason = deriveOnDiskExclusionReason(showDir, f, show);
    const reason = onDiskReason || (info ? info.reason : 'not-logged');
    reasons[reason] = (reasons[reason] || 0) + 1;
    named.push({ file: f, reason });
  }

  const unexplainedCount = Object.entries(reasons)
    .reduce((sum, [reason, count]) => sum + (BUG_SIGNAL_REASONS.has(reason) ? count : 0), 0);
  const severity = computeGapSeverity(gap, unexplainedCount);
  // Stays print-only (task #1132, extending #389): this check's "fix" is a
  // read-only diagnostic pipe (grep EXCLUSION), not an idempotent action — the
  // real remediation depends on the per-file reason above (re-run collection,
  // clear a bad flag, or accept the exclusion), which only a human can decide.
  const cmd = `node scripts/rebuild-all-reviews.js --show=${show.id} --verbose 2>&1 | grep EXCLUSION`;
  const reasonSummary = Object.entries(reasons)
    .map(([r, c]) => `${r}=${c}`)
    .sort()
    .join(', ');
  const top = named.slice(0, 8)
    .map(n => `  - ${n.file} (${n.reason})`)
    .join('\n');
  const explainedLabel = unexplainedCount === 0
    ? `all ${gap} explained by a legitimate logged reason`
    : `${unexplainedCount} of ${gap} are a BUG SIGNAL (not-logged or skippedProcessingError)`;

  return {
    ok: unexplainedCount === 0 && gap < ERROR_THRESHOLD,
    severity,
    message: `${gap} local review file(s) excluded from reviews.json (${localCount} local vs ${builtCount} built) — ${explainedLabel}.\n  By reason: ${reasonSummary || '(no audit log today)'}\n${top}${named.length > 8 ? `\n  ... and ${named.length - 8} more` : ''}\n  Full inspect: ${cmd}`,
    details: { localCount, builtCount, gap, showId: show.id, reasons, unexplainedCount, ghosts: named },
  };
}

module.exports = { name, description, run, loadExclusionIndex, computeGapSeverity, BUG_SIGNAL_REASONS };
