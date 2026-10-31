'use strict';
/**
 * BRO-4461: Opening Night Express cancels in-progress orchestrator/poller
 * runs to get the data repo to itself (by design, data-race protection). That
 * silently killed the west-end orchestrator + WAOVW poller mid embargo-lift
 * window while Express ran for a different show. Cancelled runs were never
 * restored. This lib records what Express cancels and plans the redispatch.
 *
 * CLI (used by opening-night-express.yml):
 *   node scripts/lib/express-preemption.js cancel <outFile> [--show=ID] [--scoring]   # cancel + record
 *   node scripts/lib/express-preemption.js redispatch <file>  # re-dispatch recorded runs
 * Needs GH_TOKEN + GITHUB_REPOSITORY (gh CLI).
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const ORCH = 'opening-night-orchestrator.yml';
const POLLER = 'opening-night-poller.yml';
const SCORING = 'llm-ensemble-score.yml';

// BRO-5890: Express for one show cancelled a Benjamin Button scoring run and
// would cancel every targeted poller for every other show tonight. Runs scoped
// to ANOTHER show write that show's review-texts files and, on the fast path,
// rebuild/push reviews.json and deploy alongside Express: the same overlap
// BRO-4273 accepts between targeted and auto pollers (push-with-retry,
// merge-reviews-json, sync-review-texts-drift), so they are left alone.
// Orchestrators, auto pollers and unscoped scoring runs cover every show
// (including this one) and are still cancelled; orchestrators/pollers are
// re-dispatched when Express finishes.
// Title formats: poller 'Opening Night Poller — <show|auto>', scoring
// 'LLM Ensemble Score Reviews[ — <show>]' (run-name in each workflow).
function scopedShowId(displayTitle) {
  const m = String(displayTitle || '').match(/—\s*(\S+)\s*$/);
  return m && m[1] !== 'auto' ? m[1] : '';
}

function shouldCancel(workflow, displayTitle, ownShowId) {
  if (workflow === ORCH) return true;
  const scoped = scopedShowId(displayTitle);
  if (!scoped || !ownShowId) return true;
  // A scoring run may carry a comma-separated list (BRO-5851); GitHub
  // truncates a long run-name with "...", so only a listed id is matched.
  if (scoped.includes(',')) return scoped.split(',').map(s => s.trim()).includes(ownShowId);
  return scoped === ownShowId;
}

// run-name formats: 'Opening Night Orchestrator (west-end)' / 'Opening Night Poller — <show|auto>'
function planRedispatch(workflow, displayTitle) {
  const title = String(displayTitle || '');
  if (workflow === ORCH) {
    const m = title.match(/\(([a-z-]+)\)\s*$/);
    const market = m && m[1] !== 'auto' ? m[1] : '';
    return { workflow, fields: market ? { market } : {} };
  }
  if (workflow === POLLER) {
    const m = title.match(/—\s*(\S+)\s*$/);
    const showId = m && m[1] !== 'auto' ? m[1] : '';
    return { workflow, fields: showId ? { show_id: showId } : {} };
  }
  return null;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function listRuns(workflow, status) {
  try {
    return JSON.parse(gh(['run', 'list', `--workflow=${workflow}`, `--status=${status}`, '--json', 'databaseId,displayTitle']));
  } catch (e) { return []; }
}

function cancelAndRecord(outFile, ownShowId = '', { scoring = false } = {}) {
  const recorded = [];
  const workflows = scoring ? [ORCH, POLLER, SCORING] : [ORCH, POLLER];
  for (const workflow of workflows) {
    for (const status of ['in_progress', 'queued']) {
      for (const run of listRuns(workflow, status)) {
        if (!shouldCancel(workflow, run.displayTitle, ownShowId)) {
          console.log(`  Leaving ${workflow} run ${run.databaseId} (${run.displayTitle}): scoped to another show`);
          continue;
        }
        try {
          gh(['run', 'cancel', String(run.databaseId)]);
          console.log(`  Cancelled ${workflow} run ${run.databaseId} (${run.displayTitle})`);
          // Scoring runs were never re-dispatched (their next trigger rescores).
          const plan = workflow === SCORING ? null : planRedispatch(workflow, run.displayTitle);
          if (plan) recorded.push({ ...plan, runId: run.databaseId, title: run.displayTitle });
        } catch (e) { console.log(`  ⚠ Could not cancel ${run.databaseId}`); }
      }
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(recorded, null, 2));
  return recorded;
}

// Dedup so a cancel at start + re-cancel after scoring yields one dispatch each.
function redispatch(file) {
  if (!fs.existsSync(file)) return [];
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  const seen = new Set();
  const done = [];
  for (const it of items) {
    const key = it.workflow + JSON.stringify(it.fields);
    if (seen.has(key)) continue;
    seen.add(key);
    const args = ['workflow', 'run', it.workflow];
    for (const [k, v] of Object.entries(it.fields)) args.push('-f', `${k}=${v}`);
    try { gh(args); done.push(it); console.log(`  Re-dispatched ${it.workflow} ${JSON.stringify(it.fields)} (was cancelled run ${it.runId})`); }
    catch (e) { console.log(`::warning::Could not re-dispatch ${it.workflow} ${JSON.stringify(it.fields)}: ${e.message}`); }
  }
  return done;
}

module.exports = { planRedispatch, shouldCancel, scopedShowId, ORCH, POLLER, SCORING, cancelAndRecord, redispatch };

if (require.main === module) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (cmd === 'cancel') {
    // cancel <file> [--show=<express show id>] [--scoring]
    const ownShowId = (rest.find((a) => a.startsWith('--show=')) || '').slice('--show='.length);
    const scoring = rest.includes('--scoring');
    // Append to any earlier record from this job (start cancel + post-scoring re-cancel).
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const now = cancelAndRecord(file + '.new', ownShowId, { scoring });
    fs.writeFileSync(file, JSON.stringify(prev.concat(now), null, 2));
    fs.unlinkSync(file + '.new');
    console.log(`Cancelled ${now.length} competing run(s).`);
  } else if (cmd === 'redispatch') {
    const d = redispatch(file);
    console.log(`Re-dispatched ${d.length} run(s).`);
  } else { console.error('usage: cancel|redispatch <file>'); process.exit(2); }
}
