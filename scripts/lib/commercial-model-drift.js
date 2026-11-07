const COMMERCIAL_HISTORY_MAX_AGE_HOURS = 200;

/** Pure check shared by the weekly writer (pre-write) and daily digest. */
function commercialHistoryIssue(history, nowMs = Date.now()) {
  if (!Array.isArray(history) || !history.length) return 'No persisted commercial model history';
  const time = (entry) => typeof entry?.date === 'string' && entry.date.trim() ? Date.parse(entry.date) : NaN;
  const latest = time(history[history.length - 1]);
  const hour = 3600000;
  if (!Number.isFinite(latest) || latest > nowMs + hour) return 'Invalid latest commercial model history date';
  if (nowMs - latest > COMMERCIAL_HISTORY_MAX_AGE_HOURS * hour) {
    return `Commercial model history is ${((nowMs - latest) / hour).toFixed(1)}h old (>${COMMERCIAL_HISTORY_MAX_AGE_HOURS}h)`;
  }
  if (history.length > 1) {
    const prior = time(history[history.length - 2]);
    if (!Number.isFinite(prior) || prior > latest) return 'Invalid prior commercial model history date';
    const gap = (latest - prior) / hour;
    if (gap > COMMERCIAL_HISTORY_MAX_AGE_HOURS) return `Commercial model history has a ${gap.toFixed(1)}h gap between its latest observations`;
  }
  return null;
}

/**
 * Pure drift-detection logic for the commercial-model rolling history
 * (data/audit/commercial-data-history.json, written by
 * scripts/audit-commercial-data.js --write-history — see S2-T1).
 *
 * Extracted per CLAUDE.md §15 (test extraction pattern) so
 * scripts/health-check.js's "Commercial model drift" check and its unit test
 * share one implementation, rather than the health-check.js copy drifting
 * from what's actually tested.
 *
 * Mirrors scripts/health-check.js's existing "Quality: corpus drift" check
 * (checkQuality() → runCheck('Quality: corpus drift', ...)): warn (not error)
 * on drift itself so it surfaces in the digest without paging; only a
 * missing/unparseable history file is treated as a harder signal.
 */

/**
 * @param {Array<object>} history  rolling history array (oldest..newest), as
 *   written by audit-commercial-data.js's saveCommercialHistory(). Each entry
 *   has modelDesignationFlagCount, aiEstimatedCount, modelMethodBreakdown, etc.
 * @returns {{status: 'pass'|'warn', message: string}}
 */
// Share rises smaller than this (0.5 percentage points) are rounding-level
// churn, not drift.
const AI_SHARE_TOLERANCE = 0.005;
const pct = (x) => (x * 100).toFixed(1);

/** ai-estimated / all modelled shows, or null when the entry has no breakdown. */
function aiEstimatedShare(entry) {
  const breakdown = entry && entry.modelMethodBreakdown;
  if (!breakdown || typeof breakdown !== 'object') return null;
  const total = Object.values(breakdown).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  if (total <= 0) return null;
  const ai = Number.isFinite(entry.aiEstimatedCount) ? entry.aiEstimatedCount : (breakdown['ai-estimated'] || 0);
  return ai / total;
}

function computeCommercialModelDriftStatus(history, nowMs = Date.now()) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      status: 'warn',
      message: 'No commercial model drift history yet (commercial-weekly.yml may not have run --write-history)',
    };
  }

  const ledgerIssue = commercialHistoryIssue(history, nowMs);
  if (ledgerIssue) {
    return { status: 'warn', message: ledgerIssue,
      hint: 'Check commercial-weekly.yml --write-history and persistence of data/audit/commercial-data-history.json; workflow success alone does not prove its writes survived.' };
  }

  const latest = history[history.length - 1];
  const prior = history.length >= 2 ? history[history.length - 2] : null;

  const latestFlagCount = latest.modelDesignationFlagCount || 0;
  const latestAiCount = latest.aiEstimatedCount || 0;

  if (!prior) {
    return {
      status: 'pass',
      message: `${latestFlagCount} modelDesignationFlag contradiction(s), ${latestAiCount} ai-estimated shows (only 1 history entry — no prior week to compare)`,
    };
  }

  const priorFlagCount = prior.modelDesignationFlagCount || 0;
  const priorAiCount = prior.aiEstimatedCount || 0;
  const flagDelta = latestFlagCount - priorFlagCount;
  const aiDelta = latestAiCount - priorAiCount;

  const issues = [];
  if (flagDelta > 0) {
    issues.push(`modelDesignationFlag contradictions up ${flagDelta} (${priorFlagCount} → ${latestFlagCount})`);
  }
  // BRO-5749: the modelled set keeps growing (230 → 476 shows, Sep-Oct 2026),
  // so the raw ai-estimated count rose most weeks while its SHARE fell
  // (47% → 26%). Drift is the share rising; the raw count is only the
  // fallback when an entry has no modelMethodBreakdown to divide by.
  const priorShare = aiEstimatedShare(prior);
  const latestShare = aiEstimatedShare(latest);
  if (priorShare != null && latestShare != null) {
    if (aiDelta > 0 && latestShare - priorShare > AI_SHARE_TOLERANCE) {
      issues.push(`ai-estimated share up ${pct(latestShare - priorShare)} pts (${pct(priorShare)}% → ${pct(latestShare)}%; count ${priorAiCount} → ${latestAiCount})`);
    }
  } else if (aiDelta > 0) {
    issues.push(`ai-estimated tier count up ${aiDelta} (${priorAiCount} → ${latestAiCount})`);
  }

  if (issues.length > 0) {
    return { status: 'warn', message: issues.join('; ') };
  }

  return {
    status: 'pass',
    message: `${latestFlagCount} modelDesignationFlag contradiction(s), ${latestAiCount} ai-estimated shows${latestShare != null ? ` (${pct(latestShare)}% of modelled)` : ''} (no rise vs prior week)`,
  };
}

module.exports = { computeCommercialModelDriftStatus, aiEstimatedShare, commercialHistoryIssue, COMMERCIAL_HISTORY_MAX_AGE_HOURS };
