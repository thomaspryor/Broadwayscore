'use strict';

/**
 * BRO-3381 — LLM scoring cost is computed every run (scripts/llm-scoring/
 * cost.ts's costBreakdown()) and printed to a log GitHub deletes, then
 * thrown away. This module persists that cost onto each run summary and
 * checks whether a GitHub Actions run's cumulative spend crossed the alarm
 * line — alarm only, never abort (a --max-cost default was reviewed and
 * rejected 2026-09-15: the cap is inert in --batch mode and per-process, so
 * the workflow's real spenders — the batch pass, the drain, and
 * comparative-rescore.ts — would stay uncapped while a trip force-red's the
 * job and still fires the always() chain step).
 *
 * Extracted per CLAUDE.md rule 15 (Test Extraction Pattern) so
 * cost-recording.test.mjs can require() the real functions instead of
 * re-deriving this logic — production code changes then make the test fail,
 * which is the point.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_RUNS_LOG_PATH = path.join(__dirname, '../../data/llm-scoring-runs.json');
const DEFAULT_THRESHOLDS_PATH = path.join(__dirname, '../config/provider-spend-thresholds.json');

/** Keep at least 100 summaries, plus every summary in the rolling alarm window. */
const MAX_RUNS_KEPT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Append `summary` to the run log at `runsLogPath` (capped at the last
 * MAX_RUNS_KEPT entries plus the last 24h), and return the resulting in-memory array so
 * callers (e.g. a breach check right after saving) don't need to re-read
 * the file they just wrote.
 */
function appendRunSummary(summary, { runsLogPath = DEFAULT_RUNS_LOG_PATH } = {}) {
  let runs = [];
  if (fs.existsSync(runsLogPath)) {
    try {
      runs = JSON.parse(fs.readFileSync(runsLogPath, 'utf-8'));
    } catch {
      runs = [];
    }
  }

  runs.push(summary);

  if (runs.length > MAX_RUNS_KEPT) {
    const cutoff = Date.parse(summary.completedAt) - DAY_MS;
    runs = runs.filter((r, i) => i >= runs.length - MAX_RUNS_KEPT || Date.parse(r?.completedAt) >= cutoff);
  }

  fs.mkdirSync(path.dirname(runsLogPath), { recursive: true });
  fs.writeFileSync(runsLogPath, JSON.stringify(runs, null, 2) + '\n');
  return runs;
}

/** Sum `costUsd` across `runs` entries matching `runId` (all non-numeric/missing costUsd count as 0). */
function sumCostUsdForRun(runs, runId) {
  return runs
    .filter((r) => r && r.runId === runId)
    .reduce((sum, r) => sum + (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);
}

/** Read the configured alarm line (per-run by default). Missing file/field returns null. */
function loadCostThresholdUsd(thresholdsPath = DEFAULT_THRESHOLDS_PATH, key = 'llmScoringRunUsd') {
  try {
    const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));
    return typeof thresholds[key] === 'number' ? thresholds[key] : null;
  } catch {
    return null;
  }
}

// Deliberately global, not per-runId or per-day (ship-check catch, BRO-3381):
// routeAlert's 20h cooldown on this single key means at most one owner-facing
// digest entry per ~day, matching check-provider-spend.js's own
// `provider-spend:overspend` key + cooldownHours:20 design for the same
// daily-cadence workflow. A second, distinct breach inside that window still
// prints its own console.log line in THIS run's CI log regardless of
// routeAlert's cooldown outcome — only the owner digest dedupes, by design.
const COST_BREACH_CONDITION_KEY = 'llm-scoring:cost-breach';

/**
 * Pure breach decision: given the run log (already includes this run's just-
 * appended summary) and a runId, is the runId's cumulative costUsd over
 * thresholdUsd? Returns null when there's nothing to correlate against
 * (no runId — a local/manual run) or no threshold configured, so callers
 * can skip alerting outright instead of alarming on an ungrounded number.
 */
function checkCostBreach(runs, { runId, thresholdUsd, conditionKey = COST_BREACH_CONDITION_KEY } = {}) {
  if (!runId || typeof thresholdUsd !== 'number' || !Number.isFinite(thresholdUsd)) return null;
  const totalUsd = sumCostUsdForRun(runs, runId);
  return { totalUsd, thresholdUsd, breached: totalUsd > thresholdUsd, conditionKey, runId };
}

function runsWithinDay(runs, now) {
  const end = new Date(now).getTime();
  return runs.filter(r => {
    const completed = Date.parse(r?.completedAt);
    return completed >= end - DAY_MS && completed <= end;
  });
}

/** Pure loop detector, independent of GitHub run ids and spend thresholds. */
function checkRepeatSignature(runs, now = new Date()) {
  const groups = new Map();
  for (const r of runsWithinDay(runs, now)) {
    const input = r.tokensUsed?.input;
    // Idle 0/0 summaries are common. Failed attempts with paid input still count.
    if (!Number.isInteger(r.processed) || r.processed < 0 || !Number.isInteger(input) || input <= 0) continue;
    const key = `${r.processed}/${input}`;
    const group = groups.get(key) || { processed: r.processed, input, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.count >= 3);
}

/** Rolling 24h total, across all invocations and GitHub run ids. Alarm only. */
function checkDailyCostBreach(runs, { now = new Date(), thresholdUsd } = {}) {
  if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) return null;
  const totalUsd = runsWithinDay(runs, now).reduce((sum, r) =>
    sum + (Number.isFinite(r.costUsd) && r.costUsd > 0 ? r.costUsd : 0), 0);
  return { totalUsd, thresholdUsd, breached: totalUsd > thresholdUsd, conditionKey: 'llm-scoring:daily-cost-breach' };
}

/** Shared by both scoring writers and the daily spend check. Injection keeps tests offline. */
async function reportRollingCostAlerts(runs, {
  now = new Date(), thresholdUsd = loadCostThresholdUsd(undefined, 'llmScoringDailyUsd'),
  dryRun = false, routeAlert,
} = {}) {
  const daily = checkDailyCostBreach(runs, { now, thresholdUsd });
  const repeats = checkRepeatSignature(runs, now);
  const alerts = [];
  if (!daily) console.warn('[llm-scoring] llmScoringDailyUsd unavailable; daily cost alarm skipped');
  if (daily?.breached) alerts.push({
    conditionKey: daily.conditionKey,
    title: 'LLM scoring daily spend over budget',
    description: `Rolling 24h LLM scoring cost $${daily.totalUsd.toFixed(2)} exceeds the $${daily.thresholdUsd.toFixed(2)} llmScoringDailyUsd alarm line, across all GitHub runs.`,
  });
  if (repeats.length) alerts.push({
    // Include "cost" so the router's never-quiet spend policy applies.
    conditionKey: 'llm-scoring:cost-repeat-signature',
    title: 'LLM scoring repeated work detected',
    description: `Repeated scoring signatures in the last 24h (processed/input tokens): ${repeats.map(r => `${r.processed}/${r.input} seen ${r.count} times`).join('; ')}.`,
  });
  for (const alert of alerts) {
    console.warn(`[llm-scoring] ${alert.conditionKey}: ${alert.description}`);
    if (!dryRun) {
      try {
        await (routeAlert || require('./owner-alert-router').routeAlert)({
          ...alert, severity: 'warning', disposition: 'digest', cooldownHours: 20,
          hint: 'Inspect data/llm-scoring-runs.json for repeated invocations, token usage and costUsd. Alarm only; scoring continues.',
        });
      } catch (err) {
        console.error(`[llm-scoring] ${alert.conditionKey} routing failed (non-fatal): ${err.message}`);
      }
    }
  }
  return { daily, repeats };
}

module.exports = {
  DEFAULT_RUNS_LOG_PATH,
  DEFAULT_THRESHOLDS_PATH,
  COST_BREACH_CONDITION_KEY,
  appendRunSummary,
  sumCostUsdForRun,
  loadCostThresholdUsd,
  checkCostBreach,
  checkRepeatSignature,
  checkDailyCostBreach,
  reportRollingCostAlerts,
};
