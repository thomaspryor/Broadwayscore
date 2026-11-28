'use strict';

// Opening-night checklist subscriber to data/audit/drift-state.json. The only
// writer (updateState in review-count-probe.js) stores
// {fingerprint, firstSeen, consecutiveCount, lastAlertTs, aboveThreshold, suppressed}; there
// is no numeric `drift` field (BRO-4048: reading one kept this check at 'ok').
const CONFIRM_RUNS = 2; // same repeat-confirmation the drift alert itself uses

function buildDriftCheckResult(show, driftState) {
  const base = {
    name: 'drift-detector',
    description: 'Drift detector subscription (reads data/audit/drift-state.json)',
  };
  const entry = (driftState || {})[show.id];
  if (!entry) {
    return {
      ...base,
      ok: true,
      severity: 'warning',
      message: `Drift state unavailable for ${show.id} — is check-opening-night-drift.yml running?`,
    };
  }
  const aboveThreshold = entry.aboveThreshold === true;
  const consecutiveCount = entry.consecutiveCount || 0;
  // The detector stays quiet on allowlisted / deploy-lag shows; so must the gate.
  const confirmed = aboveThreshold && !entry.suppressed && consecutiveCount >= CONFIRM_RUNS;
  return {
    ...base,
    ok: !aboveThreshold,
    severity: confirmed ? 'error' : aboveThreshold ? 'warning' : 'ok',
    message: !aboveThreshold
      ? 'Drift ok'
      : confirmed
        ? `Review-count drift above threshold for ${consecutiveCount} consecutive runs — CRITICAL`
        : 'Review-count drift above threshold on the latest run — monitor',
    details: { aboveThreshold, consecutiveCount, fingerprint: entry.fingerprint ?? null, showId: show.id },
  };
}

module.exports = { buildDriftCheckResult, CONFIRM_RUNS };
