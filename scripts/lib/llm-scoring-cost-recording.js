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

/** Max run summaries kept in the log — matches index.ts's prior inline saveRunSummary(). */
const MAX_RUNS_KEPT = 100;

/**
 * Append `summary` to the run log at `runsLogPath` (capped at the last
 * MAX_RUNS_KEPT entries), and return the resulting in-memory array so
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
    runs = runs.slice(-MAX_RUNS_KEPT);
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

/** Reads scripts/config/provider-spend-thresholds.json's `llmScoringRunUsd` line. Returns null if the file/field is missing. */
function loadCostThresholdUsd(thresholdsPath = DEFAULT_THRESHOLDS_PATH) {
  try {
    const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));
    return typeof thresholds.llmScoringRunUsd === 'number' ? thresholds.llmScoringRunUsd : null;
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

module.exports = {
  DEFAULT_RUNS_LOG_PATH,
  DEFAULT_THRESHOLDS_PATH,
  COST_BREACH_CONDITION_KEY,
  appendRunSummary,
  sumCostUsdForRun,
  loadCostThresholdUsd,
  checkCostBreach,
};
