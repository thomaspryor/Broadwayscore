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

/**
 * Keep at least 100 summaries, plus every summary that completed on or after
 * 00:00Z of the UTC day before the newest one (BRO-7576). The daily spend job
 * (check-provider-spend.js) sums YESTERDAY's whole UTC day the next morning;
 * with only "100 rows + last 24h" kept, that day's early runs were already gone
 * on 9 of 20 days checked (2026-10-27..11-15), so the day total was unknowable.
 */
const MAX_RUNS_KEPT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 00:00Z of the UTC day before the one `iso` falls on (NaN when unparseable). */
function retentionCutoffMs(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return NaN;
  return Date.parse(`${new Date(t).toISOString().slice(0, 10)}T00:00:00Z`) - DAY_MS;
}

/**
 * Append `summary` to the run log at `runsLogPath` (capped at the last
 * MAX_RUNS_KEPT entries plus everything since 00:00Z yesterday), and return the resulting in-memory array so
 * callers (e.g. a breach check right after saving) don't need to re-read
 * the file they just wrote.
 */
function appendRunSummary(summary, { runsLogPath = DEFAULT_RUNS_LOG_PATH } = {}) {
  let runs = [];
  let readOk = false;
  if (fs.existsSync(runsLogPath)) {
    try {
      runs = JSON.parse(fs.readFileSync(runsLogPath, 'utf-8'));
      readOk = Array.isArray(runs);
      if (!readOk) runs = [];
    } catch {
      runs = [];
    }
  }

  // BRO-7576: stamp the newest row with the oldest time the log still keeps
  // in full, so sumCostUsdForUtcDay can tell "no runs that morning" from "those
  // runs were trimmed". Only when the existing log was read intact: a lost or
  // corrupt log keeps nothing, and must never vouch for a whole day.
  const cutoff = retentionCutoffMs(summary?.completedAt);
  if (readOk && Number.isFinite(cutoff) && summary && typeof summary === 'object') {
    // What the log vouched for before this append: the previous stamp, or for
    // a log written before stamps existed, its oldest retained row (every cap
    // so far only trimmed from the front). Never vouch for more than that
    // (Math.max): rows trimmed earlier are gone whatever this append keeps.
    const stamped = runs.length ? Date.parse(runs[runs.length - 1]?.logKeepsSince) : NaN;
    const times = runs.map(r => Date.parse(r?.completedAt)).filter(Number.isFinite);
    // An empty log vouches only from this summary on.
    const prevKeeps = Number.isFinite(stamped) ? stamped
      : (times.length ? Math.min(...times) : Date.parse(summary.completedAt));
    summary.logKeepsSince = new Date(Math.max(cutoff, prevKeeps)).toISOString();
  }

  runs.push(summary);

  if (runs.length > MAX_RUNS_KEPT) {
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
/** Owned by check-provider-spend.js since BRO-7576; same key so the open card carries over. */
const DAILY_COST_CONDITION_KEY = 'llm-scoring:daily-cost-breach';

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

/**
 * Per-invocation breakdown of one runId's spend (BRO-3464). Entries written
 * before `source` existed land in 'unknown' so the parts always sum to the
 * same total as sumCostUsdForRun.
 */
function sumCostUsdBySource(runs, runId) {
  const out = {};
  for (const r of runs) {
    if (!r || r.runId !== runId) continue;
    const usd = typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? r.costUsd : 0;
    const key = typeof r.source === 'string' && r.source ? r.source : 'unknown';
    out[key] = (out[key] || 0) + usd;
  }
  return out;
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

/**
 * Shared by index.ts and comparative-rescore.ts (BRO-3464): check one GitHub
 * run's cumulative spend and route a digest alert on breach. Alarm only, never
 * throws. Resolves to the breach object (or null when nothing to check).
 */
async function reportRunCostBreach(runs, {
  runId, logPrefix = '[llm-scoring]', thresholdUsd, routeAlert,
} = {}) {
  if (!runId) return null; // local/manual run: nothing to correlate against
  try {
    const threshold = thresholdUsd === undefined ? loadCostThresholdUsd() : thresholdUsd;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      console.warn(`${logPrefix} cost-breach threshold unavailable (scripts/config/provider-spend-thresholds.json missing or missing llmScoringRunUsd) — cost alarm is a no-op this run`);
    }
    const breach = checkCostBreach(runs, { runId, thresholdUsd: threshold });
    if (breach?.breached) {
      const bySource = Object.entries(sumCostUsdBySource(runs, runId))
        .map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ');
      await (routeAlert || require('./owner-alert-router').routeAlert)({
        conditionKey: breach.conditionKey,
        title: 'LLM scoring spend over budget',
        description: `GitHub run ${runId}: cumulative LLM scoring cost $${breach.totalUsd.toFixed(2)} exceeds the $${breach.thresholdUsd.toFixed(2)} alarm line (scripts/config/provider-spend-thresholds.json's llmScoringRunUsd). Cost basis: cost.ts's costBreakdown() applied to Claude/OpenAI/Gemini token usage across this run's index.ts AND comparative-rescore.ts invocations (BRO-3392). By invocation: ${bySource}. This is an alarm, not an enforcement cap — see BRO-3381 for why a --max-cost default was rejected.`,
        hint: 'Check data/llm-scoring-runs.json entries for this runId (each carries a `source` field) to see which invocation drove the spend.',
        severity: 'warning',
        disposition: 'digest',
        cooldownHours: 20,
        fields: [
          { name: 'GitHub run', value: String(runId) },
          { name: 'Cost', value: `$${breach.totalUsd.toFixed(2)}` },
          { name: 'Threshold', value: `$${breach.thresholdUsd.toFixed(2)}` },
        ],
      });
      console.log(`\n⚠️  LLM scoring cost breach: $${breach.totalUsd.toFixed(2)} > $${breach.thresholdUsd.toFixed(2)} (routed via ${breach.conditionKey})`);
    }
    return breach;
  } catch (err) {
    // Alarm plumbing must never abort a scoring run.
    console.error(`${logPrefix} cost-breach check failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * BRO-7576: total LLM scoring cost of one whole UTC day (`day` = YYYY-MM-DD),
 * across every invocation and GitHub run id. `covered` is false when the log
 * cannot answer: its oldest retained summary completed after the day began
 * (rows were capped away), or the day has not ended yet. An uncovered day is
 * "could not measure" (usd null), never $0. Invalid costs count as 0, as in
 * the per-run sums above.
 */
function sumCostUsdForUtcDay(runs, day, { now = new Date() } = {}) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (!Number.isFinite(start)) return { day, usd: null, covered: false, runs: 0 };
  const end = start + DAY_MS;
  const list = Array.isArray(runs) ? runs : [];
  const times = list.map(r => Date.parse(r?.completedAt)).filter(Number.isFinite);
  // Concurrent writers are merged by appending, so the last row's stamp may
  // come from a writer that saw less: trust the latest (narrowest) stamp.
  const stamps = list.map(r => Date.parse(r?.logKeepsSince)).filter(Number.isFinite);
  const keeps = stamps.length ? Math.max(...stamps) : NaN;
  let usd = 0;
  let count = 0;
  let badCost = false;
  for (const r of list) {
    const t = Date.parse(r?.completedAt);
    if (!(t >= start && t < end)) continue;
    count++;
    if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0) usd += r.costUsd;
    else badCost = true;
  }
  // Whole day present: the log reaches back to 00:00Z (a retained row from
  // before it, or a stamp saying nothing since then was trimmed), a summary
  // was written after the day ended (the log is not stale), and every run in
  // the day carries a real cost (a missing cost is unknown, never $0).
  const covered = times.length > 0 && (Math.min(...times) <= start || keeps <= start)
    && times.some(t => t >= end) && !badCost && new Date(now).getTime() >= end;
  return { day, usd: covered ? +usd.toFixed(4) : null, covered, runs: count };
}

/**
 * Shared by both scoring writers and the daily spend check. Injection keeps
 * tests offline. Loop alarms only: repeated signatures, and recovery of the
 * per-run breach. BRO-7576: the daily SPEND condition (DAILY_COST_CONDITION_KEY)
 * is not judged here any more. A rolling-24h total flipped over and under the
 * line with every scheduled batch (15 open/resolve cycles in 51 days, each a
 * chance for a fresh card); check-provider-spend.js owns it now, on a 7-day
 * average of whole UTC days (provider-spend-core.js llmScoringBreach), and is
 * the only place that raises or resolves it.
 */
async function reportRollingCostAlerts(runs, {
  now = new Date(),
  runThresholdUsd = loadCostThresholdUsd(),
  dryRun = false, routeAlert, resolveCondition,
} = {}) {
  const repeats = checkRepeatSignature(runs, now);
  const alerts = [];
  if (repeats.length) alerts.push({
    // Include "cost" so the router's never-quiet spend policy applies.
    conditionKey: 'llm-scoring:cost-repeat-signature',
    title: 'LLM scoring repeated work detected',
    description: `Repeated scoring signatures in the last 24h (processed/input tokens): ${repeats.map(r => `${r.processed}/${r.input} seen ${r.count} times`).join('; ')}.`,
  });
  // Missing or stale data is not recovery: unknown costs must never justify
  // resolving an existing alert (BRO-6732).
  const end = new Date(now).getTime();
  const recent = runsWithinDay(runs, now);
  const recoveryEvidence = recent.length > 0 && runs.every(r => {
    const completed = Date.parse(r?.completedAt);
    return Number.isFinite(completed) && completed <= end;
  }) && recent.every(r => Number.isFinite(r.costUsd) && r.costUsd >= 0);
  // BRO-7395: the per-run alarm shares one condition across GitHub runs.
  // A cheap invocation alone cannot clear it. Require a full 24h of retained
  // history, fresh summaries, and no cumulative breach among runs active in
  // that window. Include their older invocations so a late drain cannot hide
  // earlier spend. Unknown costs/IDs cannot establish recovery.
  if (!dryRun && recoveryEvidence && Number.isFinite(runThresholdUsd) && runThresholdUsd > 0
      && runs.some(r => Date.parse(r.completedAt) <= end - DAY_MS)) {
    const runIds = new Set(recent.map(r => r.runId));
    const complete = [...runIds].every(id => typeof id === 'string' && id.trim())
      && runs.filter(r => runIds.has(r.runId)).every(r => Number.isFinite(r.costUsd) && r.costUsd >= 0);
    const totals = [...runIds].map(id => sumCostUsdForRun(runs, id));
    const maxUsd = Math.max(...totals);
    if (complete && maxUsd <= runThresholdUsd) {
      try {
        await (resolveCondition || require('./owner-alert-router').resolveCondition)(COST_BREACH_CONDITION_KEY, {
          reason: `All ${runIds.size} GitHub runs active in the last 24h are at or below the $${runThresholdUsd.toFixed(2)} per-run alarm line (largest cumulative cost $${maxUsd.toFixed(2)}).`,
        });
      } catch (err) {
        console.error(`[llm-scoring] ${COST_BREACH_CONDITION_KEY} resolution failed (non-fatal): ${err.message}`);
      }
    }
  }
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
  return { repeats };
}

module.exports = {
  DEFAULT_RUNS_LOG_PATH,
  DEFAULT_THRESHOLDS_PATH,
  COST_BREACH_CONDITION_KEY,
  appendRunSummary,
  sumCostUsdForRun,
  sumCostUsdBySource,
  reportRunCostBreach,
  loadCostThresholdUsd,
  checkCostBreach,
  checkRepeatSignature,
  sumCostUsdForUtcDay,
  retentionCutoffMs,
  DAILY_COST_CONDITION_KEY,
  reportRollingCostAlerts,
};
