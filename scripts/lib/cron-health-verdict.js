'use strict';
// Pure verdict for one "Cron: <name>" health row (extracted from
// scripts/health-check.js checkCronHealth so it can be tested).
//
// Why this exists: high-churn workflows (Rebuild Reviews, Collect Review Texts,
// LLM Ensemble Score) run dozens of times a day, and the daily digest runs at
// ~10:30 UTC, the same minute two of them fire on schedule. Reading only the
// newest run meant "Last run still running" whenever the digest caught one
// mid-flight, which the owner email rendered as "job is not running on time"
// even with a green run minutes earlier. An in-flight head run with a success
// inside the freshness window is a healthy cron.

/**
 * @param {Array<{createdAt:string, conclusion:(string|null)}>} runs newest first
 * @param {{name:string, maxHours:number, livenessOnly?:boolean}} cron
 * @param {(iso:string)=>number} hoursAgo
 * @param {(h:number)=>string} formatAge
 */
function cronHealthVerdict(runs, cron, hoursAgo, formatAge) {
  const { name, maxHours, livenessOnly } = cron;
  const rowName = `Cron: ${name}`;
  if (!runs || !runs.length) {
    return { name: rowName, status: 'warn', message: 'No runs found' };
  }
  const run = runs[0];
  const age = hoursAgo(run.createdAt);
  if (age > maxHours) {
    return { name: rowName, status: 'error', message: `Last run ${formatAge(age)} ago (max ${maxHours}h). Conclusion: ${run.conclusion || 'still running'}`, hint: 'Check Actions tab — workflow may be disabled' };
  }
  if (livenessOnly && run.conclusion) {
    return { name: rowName, status: 'pass', message: `${formatAge(age)} ago, ran (${run.conclusion}; liveness-only check)` };
  }
  if (run.conclusion === 'success') {
    return { name: rowName, status: 'pass', message: `${formatAge(age)} ago, success` };
  }
  const recentSuccess = runs.find(r => r.conclusion === 'success' && hoursAgo(r.createdAt) <= maxHours);
  if (!run.conclusion) {
    if (recentSuccess) {
      return { name: rowName, status: 'pass', message: `${formatAge(hoursAgo(recentSuccess.createdAt))} ago, success (newest run in progress)` };
    }
    // In flight with no recent success to lean on: not proof of a problem,
    // stays at baseline urgency (not the fix-now `Cron failed:` name).
    return { name: rowName, status: 'warn', message: `Last run still running (started ${formatAge(age)} ago)` };
  }
  if (recentSuccess) {
    return { name: rowName, status: 'pass', message: `${formatAge(hoursAgo(recentSuccess.createdAt))} ago, success (newest run ${run.conclusion} — superseded, not a failure)` };
  }
  return { name: `Cron failed: ${name}`, status: 'warn', message: `Last run inconclusive: ${run.conclusion} (${formatAge(age)} ago), no success in ${maxHours}h` };
}

module.exports = { cronHealthVerdict };
