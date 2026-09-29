'use strict';

/**
 * Pure evaluation of the "Quality: outlet-heartbeat red flags" signal —
 * extracted out of scripts/health-check.js (BRO-2521) so it's independently
 * runnable via scripts/outlet-heartbeat-monitor.js instead of only reachable
 * by running the full digest. health-check.js requires this same function so
 * the two callers can't drift apart (CLAUDE.md #15 test extraction pattern).
 */

const fs = require('fs');
const path = require('path');
const { getActionableOutletRows } = require('./outlet-heartbeat-state');

function hoursAgo(dateStr, nowMs) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return ((nowMs ?? Date.now()) - d.getTime()) / (1000 * 60 * 60);
}

function formatAge(hours) {
  if (hours === Infinity) return 'unknown';
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * @param {object} [opts]
 * @param {string} [opts.auditDir] directory holding outlet-heartbeat*.json (default data/audit)
 * @param {number} [opts.nowMs] override "now" for tests
 * @returns {{name: string, status: 'pass'|'warn', message: string, hint?: string, actionable?: Array}}
 */
function evaluateOutletHeartbeat(opts = {}) {
  const auditDir = opts.auditDir || path.join(__dirname, '..', '..', 'data', 'audit');
  const name = 'Quality: outlet-heartbeat red flags';
  const heartbeatFile = path.join(auditDir, 'outlet-heartbeat.json');
  if (!fs.existsSync(heartbeatFile)) {
    return { name, status: 'warn', message: 'No outlet-heartbeat.json (audit-critic-coverage.yml may not have run)', hint: 'Trigger the "Audit Critic Coverage" workflow' };
  }
  const data = readJSON(heartbeatFile);
  const age = data?.generatedAt ? hoursAgo(data.generatedAt, opts.nowMs) : Infinity;
  // Weekly cron; 8 days means it's missed a week's run.
  if (age > 192) {
    return { name, status: 'warn', message: `Heartbeat monitor last ran ${formatAge(age)} ago (>8d)`, hint: 'audit-critic-coverage.yml may be stale/disabled' };
  }
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const stateFile = path.join(auditDir, 'outlet-heartbeat-state.json');
  const state = fs.existsSync(stateFile) ? readJSON(stateFile) : {};
  let baselineKeys = new Set();
  try {
    const b = readJSON(path.join(auditDir, 'outlet-heartbeat-baseline.json'));
    if (b && Array.isArray(b.keys)) baselineKeys = new Set(b.keys);
  } catch { /* no baseline yet — everything is "new" */ }
  const { actionable, baselinedCount } = getActionableOutletRows(rows, state, baselineKeys);
  if (actionable.length === 0) {
    return { name, status: 'pass', message: `${rows.length} outlet×market rows checked, none NEW silent 2+ consecutive weeks (${baselinedCount} known/baselined, ${formatAge(age)} ago)` };
  }
  const worst = actionable[0];
  return {
    name,
    status: 'warn',
    message: `${actionable.length} NEW T1/T2 outlet×market row(s) silent 2+ consecutive weekly checks (worst: ${worst.outletId}/${worst.market}, ${worst.silentDays}d silent vs ${worst.thresholdDays}d threshold; ${baselinedCount} known/baselined)`,
    hint: 'Run `node scripts/monitor-outlet-recency.js` — check whether the outlet stopped reviewing or an extractor broke (card #582 class). `--write-baseline` acks the ENTIRE current red backlog at once (not just the worst offender) — only run it once every currently-red outlet has been triaged.',
    actionable,
  };
}

module.exports = { evaluateOutletHeartbeat, hoursAgo, formatAge };
