#!/usr/bin/env node
/**
 * reconcile-dead-completions — defense-in-depth for card #1144: find tasks
 * in the shared task list that are marked 'completed' even though their
 * most recent bsc-next/bsc-runner dispatch attempt is journaled dead (never
 * actually ran), and reopen them.
 *
 * The primary fix is a PreToolUse hook on TaskUpdate (~/.claude/hooks) that
 * refuses the bad write before it lands. This script exists for what still
 * slips past that hook: a cloud session with no ~/.claude/hooks (CLAUDE.md:
 * "Cloud sessions ... have no ~/.claude/"), a long-running session that
 * started before the hook was registered, or an explicit --force override.
 * Both consult the SAME decision function (scripts/lib/dispatch-dead-launch-
 * guard.js's reconcileDeadCompletions) — a task can't pass one check and
 * fail the other for the same underlying state.
 *
 *   node scripts/reconcile-dead-completions.js             report only
 *   node scripts/reconcile-dead-completions.js --fix        reopen matches
 *   node scripts/reconcile-dead-completions.js --help, -h   show this message
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { TASKS_DIR } = require('./bsc-next.js');
// loadTasksWithMtime (not bsc-next.js's loadTasks) — attachCompletedAtEstimates
// below needs each task's live-file mtime (card #1770/task #1701 incident).
// Already tested (task-store-archive.test.mjs) and already scoped to the LIVE
// TASKS_DIR only (never archive/, whose move rewrites mtime — see that file's
// header on attachCompletedAtEstimates).
const { loadTasksWithMtime } = require('./lib/task-store-archive.js');
const { readEntries } = require('./lib/dispatch-ledger.js');
const { reconcileDeadCompletions, attachCompletedAtEstimates } = require('./lib/dispatch-dead-launch-guard.js');
// BRO-2313: a dead ledger row says the JOB died, not that the WORK is missing.
// Every reopen (local/Notion pass and Linear pass, dry-run and --fix) is
// first checked against origin/main for the task's direct effect.
const { checkWorkLanded, makeGitProbe } = require('./lib/dead-completion-landed-check.js');

const USAGE = `reconcile-dead-completions — reopen tasks marked 'completed' whose latest dispatch never ran.

Usage:
  node scripts/reconcile-dead-completions.js             report only, reopen nothing
  node scripts/reconcile-dead-completions.js --fix        reopen matches (status -> pending)
  node scripts/reconcile-dead-completions.js --help, -h   show this message
`;

// Ship-check adversarial finding: a bare prepend re-run of --fix (e.g. a
// scheduled job firing twice before the reopened task is re-dispatched)
// would stack duplicate banners onto `description` forever. The marker
// prefix makes the reopen idempotent — a task already carrying it is left
// untouched on a repeat run.
//
// Card #1795: that any-marker check was too coarse — it can't tell "this
// SAME dead-dispatch event already reopened this task, don't restack" from
// "a task reopened once for an EARLIER dead event was genuinely re-
// completed via a SECOND dead dispatch and needs reopening again". A task
// stuck in the latter shape kept the marker forever and reconcileDeadCompletions()
// flagged it every run with no way to ever actually fix it (live incidents:
// tasks #1756/#1763). Fix: key idempotency to task.lastReopenedForEventTs, a
// structured field stamped with the dead ledger entry's own `ts`
// (deadAttemptTs, threaded from dispatch-dead-launch-guard.js's
// reconcileDeadCompletions -> dispatch-ledger.js's resolveDeadAttempt) —
// only a repeat of THAT EXACT event is a no-op. A structured field (not
// substring-matching prose) mirrors this file's own manuallyResolvedReason/
// manuallyResolvedAt convention rather than adding a second text-matching
// scheme. deadAttemptTs absent (malformed/legacy ledger data) falls back to
// the original any-marker guard — conservative, matches pre-fix behavior.
const REOPEN_MARKER = '[reconcile-dead-completions ';

function reopenTask(id, dir = TASKS_DIR, deadAttemptTs = null) {
  const file = path.join(dir, `${id}.json`);
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (deadAttemptTs) {
    if (task.lastReopenedForEventTs === deadAttemptTs) return; // this exact dead-dispatch event was already handled, no-op
  } else if (String(task.description || '').startsWith(REOPEN_MARKER)) {
    return; // no event id to key off of — fall back to the old any-marker no-op
  }
  const note = `${REOPEN_MARKER}${new Date().toISOString().slice(0, 10)}] `
    + `reopened — marked completed while its most recent dispatch was journaled dead in dispatch-ledger.jsonl (card #1144).\n\n`;
  task.status = 'pending';
  task.owner = null;
  task.lastReopenedForEventTs = deadAttemptTs || null;
  task.description = note + (task.description || '');
  fs.writeFileSync(file, JSON.stringify(task, null, 2));
}

// BRO-5845: the Notion leg is gone. reopenTask() above fixes the local
// task-store copy; there is no mirrored Notion card to correct any more
// (Notion retired 2026-08-20, CLAUDE.md §6), so correctNotionCard(),
// resetPushedFlag() and their digest pages (cards #1157/#1779) were removed
// rather than left calling a retired board from a live launchd job.

// BRO-3431: the Linear counterpart of the (removed, BRO-5845) Notion card
// correction. Never
// throws its own read-then-check decision — that lives in
// shouldReopenLinearIssue (read-then-check, same discipline as
// shouldCorrectNotionStatus: an issue the owner has since re-triaged by hand
// is left alone). Non-fatal on any failure, same contract as
// correctNotionCard's caller — the local reopen (not applicable here, since
// there IS no local mirror file for a linear:-only task) already happened by
// the time this runs; nothing to un-reopen.
//
// BRO-4075 (Codex adversarial review catch): the candidate list main() loops
// over is a SNAPSHOT taken once at startup (readEntries() below), but each
// correctLinearIssue() call is a slow network round-trip (getIssue + a
// spawnSync'd linear-brain.js update) — if `scripts/ack-landed.js` finishes
// acking this exact taskId in that window (writing landed-acked, which
// never itself touches Linear state), the stale candidate would still
// reopen an issue the FRESH ledger no longer considers dead. taskId is
// re-verified against a fresh readEntries() right before the Linear
// mutation, mirroring the read-then-check discipline shouldReopenLinearIssue
// already applies to the Linear side of this same decision. opts.entries is
// an injection point for tests only — production always re-reads live
// (opts.entries defaults to undefined, which falls through to readEntries()).
//
// BRO-2313: returns 'landed' (never mutating Linear) when the live issue's own
// text (description, comments: Key Files, PR links, commit shas) or the
// ledger's sha rows show the work is on origin/main. opts.git / opts.getIssue
// are test injection points; production uses a real git probe and Linear.
async function correctLinearIssue(identifier, taskId, opts = {}) {
  const { shouldReopenLinearIssue } = require('./lib/linear-dead-completion-source.js');
  let freshEntries = [];
  if (taskId) {
    const { isLatestDispatchDead } = require('./lib/dispatch-ledger.js');
    freshEntries = opts.entries || readEntries();
    if (!isLatestDispatchDead(taskId, freshEntries)) return false;
  }
  const getIssue = opts.getIssue || require('./lib/linear-client.js').getIssue;
  const issue = await getIssue(identifier);
  if (!shouldReopenLinearIssue(issue)) return false;
  const texts = [issue.title, issue.description,
    ...(((issue.comments && issue.comments.nodes) || []).map((c) => c && c.body))];
  // Own-id markers ([linear:BRO-N]) only from the description: a comment can
  // quote another card's marker.
  const landed = checkWorkLanded({ taskId: taskId || `linear:${identifier}`, texts, ownTexts: [issue.description], ownIds: [identifier], entries: freshEntries }, opts.git || makeGitProbe());
  if (landed.landed) {
    if (typeof opts.onLanded === 'function') opts.onLanded(landed);
    return 'landed';
  }
  if (opts.dryMutation) return true; // test-only: stop before spawning linear-brain.js
  const today = new Date().toISOString().slice(0, 10);
  const res = spawnSync('node', [path.join(__dirname, 'linear-brain.js'), 'update', identifier,
    '--state', 'Todo',
    '--comment', `Auto-corrected ${today} by reconcile-dead-completions: this issue's most recent dispatch attempt was journaled dead in dispatch-ledger.jsonl (card #1144/#1157's Linear counterpart, BRO-3431) — it had been incorrectly left/moved to a completed state.`,
  ], { encoding: 'utf8', timeout: 60_000 });
  if (res.status !== 0) {
    throw new Error(`linear-brain update failed: ${(res.stderr || res.stdout || '').trim().split('\n').slice(-1)[0]}`);
  }
  return true;
}

// BRO-2313: split reconcileDeadCompletions()'s flagged rows into ones to
// reopen and ones whose work demonstrably landed on origin/main anyway
// (linked commit/PR ancestor, or a named key file that exists there and
// references the task). Missing evidence => stays in `reopen`.
function partitionLandedCompletions(flagged, tasks, entries, git) {
  const byId = new Map((tasks || []).map((t) => [String(t && t.id), t]));
  const reopen = [];
  const landed = [];
  for (const f of flagged || []) {
    const task = byId.get(String(f.id)) || {};
    const ownIds = [task.linearIdentifier, task.linearId].filter(Boolean);
    const verdict = checkWorkLanded({ taskId: f.id, texts: [task.subject, task.description], ownTexts: [task.description], entries, ownIds }, git);
    if (verdict.landed) landed.push({ ...f, landedReason: verdict.reason });
    else reopen.push(f);
  }
  return { reopen, landed };
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const fix = argv.includes('--fix');

  const tasks = attachCompletedAtEstimates(loadTasksWithMtime(TASKS_DIR));
  // readEntries() already fails open (returns [] on any read error) — no
  // try/catch needed here; it can't throw.
  const entries = readEntries();

  const git = makeGitProbe();
  const { reopen: flagged, landed: landedLocal } = partitionLandedCompletions(
    reconcileDeadCompletions(tasks, entries), tasks, entries, git);
  if (landedLocal.length) {
    console.log(`Dead dispatch, work landed anyway: ${landedLocal.length} task(s) left completed (not reopened):`);
    for (const t of landedLocal) console.log(`  #${t.id}  ${t.subject || '(no subject)'}  [${t.landedReason}]`);
    console.log('');
  }
  if (!flagged.length) {
    console.log('[reconcile-dead-completions] no false completions found (local task store).');
  } else {
    console.log(`${fix ? 'Reopening' : '[dry-run] would reopen'} ${flagged.length} task(s) completed while their dispatch was dead:`);
    for (const t of flagged) {
      console.log(`  #${t.id}  ${t.subject || '(no subject)'}${t.notionId ? `  [notion:${t.notionId}]` : ''}`);
      if (fix) {
        try { reopenTask(t.id, TASKS_DIR, t.deadAttemptTs); }
        catch (e) { console.error(`    WARN reopen failed for #${t.id}: ${e.message}`); }
      }
    }
    if (!fix) console.log('\nRe-run with --fix to reopen these.');
  }

  // BRO-3431: a linear:-only dispatch has no local mirror file at all — the
  // Notion-scoped pass above can never see it. Candidates are derived from
  // the SAME ledger entries already read above (bounded by ledger activity,
  // never a query of the whole board — see linear-dead-completion-source.js
  // header for why that matters).
  const { findLinearDeadLaunchCandidates } = require('./lib/linear-dead-completion-source.js');
  const linearCandidates = findLinearDeadLaunchCandidates(entries);
  if (!linearCandidates.length) {
    console.log('[reconcile-dead-completions] no dead-launch candidates found (Linear).');
    return;
  }
  console.log(`\nChecking ${linearCandidates.length} Linear dead-launch candidate(s) live:`);
  for (const c of linearCandidates) {
    // BRO-2313: ledger-sha evidence is checkable offline, so it gates the
    // dry-run report too; --fix re-checks with the live issue's text inside
    // correctLinearIssue before any mutation.
    const offline = checkWorkLanded({ taskId: c.taskId, entries }, git);
    if (offline.landed) {
      console.log(`  ${c.identifier}  dead dispatch, work landed anyway — not reopening [${offline.reason}]`);
      continue;
    }
    try {
      let landedReason = null;
      const corrected = fix ? await correctLinearIssue(c.identifier, c.taskId, { git, onLanded: (r) => { landedReason = r.reason; } }) : false;
      if (corrected === 'landed') {
        console.log(`  ${c.identifier}  dead dispatch, work landed anyway — not reopening [${landedReason}]`);
      } else if (fix && corrected) {
        console.log(`  ${c.identifier}  reopened Todo -> was Done while its dispatch was journaled dead`);
      } else if (!fix) {
        console.log(`  ${c.identifier}  dead-launch candidate — re-run with --fix to check live and reopen if still Done`);
      }
    } catch (e) {
      console.error(`  WARN Linear correction failed for ${c.identifier}: ${e.message}`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[reconcile-dead-completions] FATAL: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { main, USAGE, reopenTask, correctLinearIssue, partitionLandedCompletions };
