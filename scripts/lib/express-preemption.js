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
// Must match the run-name suffix in .github/workflows/llm-ensemble-score.yml (BRO-7419).
// Empty limit/max-cost render as nothing (not a word a user could also type), so
// an invalid typed value fails to parse instead of coming back uncapped.
const RESCORE_CHAIN_RE = /\(rescore chain, (\d+) left, limit (\d*), max-cost (\d+(?:\.\d+)?)?\)\s*$/;

// BRO-5890: Express for one show cancelled a Benjamin Button scoring run and
// would cancel every targeted poller for every other show tonight. Runs scoped
// to ANOTHER show write that show's review-texts files and, on the fast path,
// rebuild/push reviews.json and deploy alongside Express: the same overlap
// BRO-4273 accepts between targeted and auto pollers (push-with-retry,
// merge-reviews-json, sync-review-texts-drift), so they are left alone.
// Orchestrators, auto pollers and unscoped scoring runs cover every show
// (including this one) and are still cancelled; orchestrators/pollers, and
// needs_rescore chain batches (BRO-7419), are re-dispatched when Express finishes.
// Title formats: poller 'Opening Night Poller — <show|auto>', scoring
// 'LLM Ensemble Score Reviews[ — <show>]' (run-name in each workflow).
function scopedShowId(displayTitle) {
  const m = String(displayTitle || '').match(/—\s*(\S+)\s*$/);
  return m && m[1] !== 'auto' ? m[1] : '';
}

function shouldCancel(workflow, displayTitle, ownShowId) {
  if (workflow === ORCH) {
    // BRO-6802: a run targeted at one other show is not this show's competitor.
    const t = String(displayTitle || '').match(/Orchestrator targeted (\S+) /);
    return !(t && ownShowId && t[1] !== ownShowId);
  }
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
    const t = title.match(/Orchestrator targeted (\S+) /);
    const fields = market ? { market } : {};
    if (t) fields.show_id = t[1];
    return { workflow, fields };
  }
  if (workflow === POLLER) {
    const m = title.match(/—\s*(\S+)\s*$/);
    const showId = m && m[1] !== 'auto' ? m[1] : '';
    return { workflow, fields: showId ? { show_id: showId } : {} };
  }
  if (workflow === SCORING) {
    // BRO-7419: a chained needs_rescore batch has no later trigger, so a cancel
    // ended an owner-approved backlog chain silently. llm-ensemble-score.yml's
    // run-name carries the chain inputs for plain needs_rescore chains only;
    // every other scoring run is left to its next trigger (null).
    const m = title.match(RESCORE_CHAIN_RE);
    if (!m) {
      if (/rescore chain/.test(title)) console.log(`::warning::Rescore chain title not understood, not re-dispatched: ${title}`);
      return null;
    }
    const fields = { needs_rescore: 'true', chain: 'true', remaining_batches: m[1], run_calibration: 'false', run_validation: 'false' };
    if (m[2]) fields.limit = m[2];
    if (m[3]) fields.max_cost = m[3];
    return { workflow, fields };
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
    // A chain's next batch waits as 'pending' behind the scoring concurrency
    // group; it must be cancelled too or it starts during Express (BRO-7419).
    const statuses = workflow === SCORING ? ['in_progress', 'queued', 'pending'] : ['in_progress', 'queued'];
    for (const status of statuses) {
      for (const run of listRuns(workflow, status)) {
        if (!shouldCancel(workflow, run.displayTitle, ownShowId)) {
          console.log(`  Leaving ${workflow} run ${run.databaseId} (${run.displayTitle}): scoped to another show`);
          continue;
        }
        // A pending run is only cancelled when it can be restored; other chain
        // kinds' pending successors keep their chain alive as before.
        const plan = planRedispatch(workflow, run.displayTitle);
        if (status === 'pending' && !plan) {
          console.log(`  Leaving pending ${workflow} run ${run.databaseId} (${run.displayTitle}): cannot be restored`);
          continue;
        }
        try {
          gh(['run', 'cancel', String(run.databaseId)]);
          console.log(`  Cancelled ${workflow} run ${run.databaseId} (${run.displayTitle})`);
          // Scoring runs come back only when they are a needs_rescore chain batch
          // (BRO-7419); other scoring runs are picked up by their next trigger.
          if (plan) recorded.push({ ...plan, runId: run.databaseId, title: run.displayTitle });
        } catch (e) { console.log(`  ⚠ Could not cancel ${run.databaseId}`); }
      }
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(recorded, null, 2));
  return recorded;
}

// BRO-7419: a batch and the next batch it already dispatched are one chain.
// Restore it once, from the batch with the most batches left (the unfinished one).
// Chains with a different limit or budget cap are different chains and both come back.
function collapseRescoreChains(items) {
  const isChain = it => it.workflow === SCORING && it.fields && it.fields.chain === 'true' && it.fields.needs_rescore === 'true';
  const best = new Map();
  for (const it of items.filter(isChain)) {
    // The chain step fills an empty limit with 400 for the next batch
    // (llm-ensemble-score.yml LIMIT="${LIMIT:-400}"), so empty and 400 are one chain.
    const k = `${it.fields.limit || '400'}|${it.fields.max_cost || ''}`;
    const cur = best.get(k);
    if (!cur || Number(it.fields.remaining_batches) > Number(cur.fields.remaining_batches)) best.set(k, it);
  }
  const keep = new Set(best.values());
  return items.filter(it => !isChain(it) || keep.has(it));
}

// Dedup so a cancel at start + re-cancel after scoring yields one dispatch each.
function redispatch(file) {
  if (!fs.existsSync(file)) return [];
  const items = collapseRescoreChains(JSON.parse(fs.readFileSync(file, 'utf8')));
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

module.exports = { planRedispatch, shouldCancel, scopedShowId, ORCH, POLLER, SCORING, RESCORE_CHAIN_RE, collapseRescoreChains, cancelAndRecord, redispatch };

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
