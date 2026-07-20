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
function computeCommercialModelDriftStatus(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      status: 'warn',
      message: 'No commercial model drift history yet (commercial-weekly.yml may not have run --write-history)',
    };
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
  if (aiDelta > 0) {
    issues.push(`ai-estimated tier count up ${aiDelta} (${priorAiCount} → ${latestAiCount})`);
  }

  if (issues.length > 0) {
    return { status: 'warn', message: issues.join('; ') };
  }

  return {
    status: 'pass',
    message: `${latestFlagCount} modelDesignationFlag contradiction(s), ${latestAiCount} ai-estimated shows (stable vs prior week)`,
  };
}

module.exports = { computeCommercialModelDriftStatus };
