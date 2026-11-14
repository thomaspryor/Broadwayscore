/**
 * BRO-2970: log-only check of a guardrail's registered expectation against
 * non-overlapping weekly analyzer readouts. No queries, emails or flag writes.
 *
 * The only adapter is gate-cold-start. That experiment concluded 2026-09-15;
 * the weekly caller skips it unless it is registered as a live split again.
 * Keep its retained readout usable for historical verification, without
 * resurrecting its deleted analyzer or treating stale data as current.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Post-recalibration expectation, docs/experiments/gate-cold-start.md,
// amendment 2026-09-07. The original rules module was deleted at teardown.
const EXPECTED_RATIO = 2.5;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_PATH = path.join(__dirname, '../../data/audit/gate-cold-start-monitor-state.json');
const KEY = 'gate-cold-start';

/** Select complete, trustworthy weekly windows, newest first, without
 * counting overlapping reruns twice. Pool shown counts, not ratios, so a
 * tiny week cannot outweigh a busy week. At least 100 shown people are
 * required per window to exclude the pre-row-cap-fix 1:1 noise.
 */
function auditGateColdStart(snapshots = [], {
  nowMs = Date.now(), weeks = 4, expectedRatio = EXPECTED_RATIO, maxDriftFactor = 2,
} = {}) {
  if (!Number.isFinite(nowMs) || !Number.isInteger(weeks) || weeks < 1
      || !Number.isFinite(expectedRatio) || expectedRatio <= 0
      || !Number.isFinite(maxDriftFactor) || maxDriftFactor <= 1) {
    throw new Error('Invalid guardrail audit options');
  }
  const cutoff = nowMs - weeks * 7 * DAY_MS;
  const candidates = [];
  for (const snapshot of snapshots) {
    const recent = snapshot?.lastSummary?.recent;
    const end = Date.parse(snapshot?.lastRunAt);
    const control = recent?.arms?.control?.shown;
    const treatment = recent?.arms?.['cold-start']?.shown;
    const start = end - 7 * DAY_MS;
    if (!Number.isFinite(end) || end > nowMs || start < cutoff
        || recent?.days !== 7 || recent?.effectiveDays !== 7 || recent?.flagHealthy !== true
        || !Number.isSafeInteger(control) || control < 0
        || !Number.isSafeInteger(treatment) || treatment < 0
        || control + treatment < 100) continue;
    candidates.push({ snapshot, start, end, control, treatment });
  }
  candidates.sort((a, b) => b.end - a.end);
  const selected = [];
  let latestEnd = nowMs;
  for (const candidate of candidates) {
    if (candidate.end > latestEnd) continue;
    selected.push(candidate);
    latestEnd = candidate.start;
  }
  const base = { key: KEY, expectedRatio, maxDriftFactor, windowWeeks: weeks, sampleWeeks: selected.length };
  if (selected.length === 0) {
    return { ...base, status: 'insufficient-data', reason: 'No complete, healthy, sufficiently populated weekly readout in the trailing window.', snapshots: [] };
  }
  const controlShown = selected.reduce((n, s) => n + s.control, 0);
  const treatmentShown = selected.reduce((n, s) => n + s.treatment, 0);
  const ratio = controlShown / treatmentShown;
  const drift = Math.max(ratio / expectedRatio, expectedRatio / ratio);
  return {
    ...base, status: drift > maxDriftFactor ? 'warning' : 'healthy',
    controlShown, treatmentShown,
    // JSON-safe even when an arm has zero shown people; the warning and
    // counts still distinguish a collapsed arm from missing measurements.
    measuredRatio: Number.isFinite(ratio) ? ratio : null,
    driftFactor: Number.isFinite(drift) ? drift : null,
    snapshots: selected.map((s) => ({ lastRunAt: s.snapshot.lastRunAt, lastSummary: { recent: s.snapshot.lastSummary.recent } })),
  };
}

/** Called by the existing weekly flag monitor; its persisted lastSummary
 * carries the bounded history, so no extra workflow commit path is needed.
 * Read failures are visible and advisory, never a flag-monitor failure.
 */
function auditRegisteredGuardrails({ registry, history = [], nowMs = Date.now(),
  readState = () => JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')),
} = {}) {
  const entry = registry?.find((flag) => flag.key === KEY);
  const live = entry?.expected?.exists === true && entry.expected.active === true
    && entry.expected.variants?.filter((v) => v.pct > 0).length === 2;
  if (!live) return { key: KEY, status: 'skipped', reason: 'Experiment is not a registered live split.', snapshots: [] };
  try {
    const current = readState();
    return auditGateColdStart([...(Array.isArray(history) ? history : []), current], { nowMs });
  } catch (err) {
    return { key: KEY, status: 'unavailable', reason: `Cannot read analyzer state: ${err.code || err.name}`, snapshots: [] };
  }
}

function formatGuardrailAudit({ snapshots, ...summary }) {
  const prefix = ['warning', 'unavailable', 'insufficient-data'].includes(summary.status) ? 'WARNING' : 'INFO';
  return `[log-only] ${prefix} experiment-guardrail-drift: ${JSON.stringify(summary)}`;
}

module.exports = { EXPECTED_RATIO, auditGateColdStart, auditRegisteredGuardrails, formatGuardrailAudit };
