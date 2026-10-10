/**
 * Pure planning logic for the opening-night automation freeze (BRO-934).
 * scripts/automation-freeze.js does the gh I/O; tests require() this directly.
 *
 * Freeze = `gh workflow disable` on non-critical cron / workflow_run workflows so a
 * manual-intervention night (2026-04-15: 5 orchestrator runs cancelled by hand) is not
 * fought by cascading automation. Never touches:
 *   - any workflow in check-cron-health.yml's CRITICAL_CRONS (cron-health pages on or
 *     self-heals a disabled critical cron, so disabling one would fight the monitor)
 *   - NEVER_FREEZE (the opening-night pipeline, landing, deploy, tests, the freeze itself)
 * Unfreeze re-enables ONLY what the freeze ledger says this freeze disabled, so
 * workflows disabled on purpose for other reasons stay disabled.
 */
'use strict';

const NEVER_FREEZE = new Set([
  'automation-freeze.yml',
  'land.yml',
  'land-retry-cancelled.yml',
  'test.yml',
  'vercel-deploy.yml',
  'rebuild-reviews.yml',
  'rebuild-fast.yml',
  'collect-review-texts.yml',
  'gather-reviews.yml',
  'enrich-reviews.yml',
  'update-show-status.yml',
  'opening-night-orchestrator.yml',
  'opening-night-poller.yml',
  'opening-night-broadcast.yml',
  'opening-night-stage-alert.yml',
  'llm-ensemble-score.yml',
  'check-cron-health.yml',
  'aggregator-url-watcher.yml', // dispatches opening-night-poller with override URLs
  'opening-digest.yml',
  'check-push-ledger.yml', // re-verifies CI pushes (the thing a freeze night leans on)
]);

// Anything named opening-night-* is part of the pipeline: never frozen, even when added later.
const NEVER_FREEZE_PATTERN = /^opening-night/;

const MAX_FREEZE_HOURS = 24;

// Filenames listed in check-cron-health.yml's CRITICAL_CRONS="file|hours|name" entries.
function parseCriticalCrons(checkCronHealthYaml) {
  const out = new Set();
  for (const m of String(checkCronHealthYaml).matchAll(/^\s*"([\w.-]+\.ya?ml)\|\d+\|/gm)) out.add(m[1]);
  return out;
}

// workflows: output of workflow-dependency-graph.loadWorkflows. state: Map file -> 'active'|...
function planFreeze(workflows, criticalCrons, stateByFile) {
  const targets = [];
  const skipped = [];
  for (const w of workflows) {
    if (!w.triggers.schedule && w.triggers.workflowRun.length === 0) continue;
    if (NEVER_FREEZE.has(w.file) || NEVER_FREEZE_PATTERN.test(w.file)) { skipped.push({ file: w.file, why: 'never-freeze' }); continue; }
    if (criticalCrons.has(w.file)) { skipped.push({ file: w.file, why: 'critical-cron' }); continue; }
    const st = stateByFile ? stateByFile.get(w.file) : 'active';
    if (st !== 'active') { skipped.push({ file: w.file, why: `state:${st || 'unknown'}` }); continue; }
    targets.push(w.file);
  }
  return { targets, skipped };
}

function clampHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.min(n, MAX_FREEZE_HOURS);
}

function buildLedger({ disabled, hours, now, by }) {
  const start = now instanceof Date ? now : new Date(now);
  return {
    status: 'frozen',
    frozenAt: start.toISOString(),
    expiresAt: new Date(start.getTime() + clampHours(hours) * 3600e3).toISOString(),
    by: by || 'unknown',
    disabled: [...disabled].sort(),
  };
}

// What `unfreeze` / `auto` should re-enable. Auto only acts once the ledger has expired.
function planUnfreeze(ledger, { now, auto }) {
  if (!ledger || ledger.status !== 'frozen') return { enable: [], reason: 'not-frozen' };
  if (auto && new Date(now).getTime() < new Date(ledger.expiresAt).getTime()) {
    return { enable: [], reason: 'not-expired' };
  }
  return { enable: [...ledger.disabled], reason: auto ? 'expired' : 'manual' };
}

module.exports = { NEVER_FREEZE, NEVER_FREEZE_PATTERN, MAX_FREEZE_HOURS, parseCriticalCrons, planFreeze, clampHours, buildLedger, planUnfreeze };
