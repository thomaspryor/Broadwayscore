#!/usr/bin/env node
/**
 * cloud-worker-pick.js — print the one P0/P1 card a scheduled cloud worker
 * session should take on this firing (BRO-4535). Read-only: it claims
 * nothing. Selection rules and their reasons: scripts/lib/cloud-worker-pick.js.
 *
 * Usage:
 *   node scripts/cloud-worker-pick.js           JSON: { pick, eligible, skipped, historySkipped }
 *   node scripts/cloud-worker-pick.js --list=N  JSON: { picks: [up to N], eligible, ... } for the
 *                                               daily Codex runner (BRO-4745): same rules, no
 *                                               resume entries (those stay with the Claude worker).
 *
 * `pick` is null when nothing is eligible; the worker then ends with no
 * changes. Exit 0 on a completed pick (null or not), 1 when Linear can't be read.
 *
 * Before a new pick, a card whose land/ ref Land refused and nobody came back
 * to is handed back with `pick.resume` (BRO-4565). The routine prompt can't be
 * edited from outside its own thread, so `pick.resume.instructions` carries
 * the steps. If git or the GitHub API can't be read, resume is skipped with a
 * warning on stderr and the normal pick runs.
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv)) {
  console.log('Usage: node scripts/cloud-worker-pick.js [--list=N]\nPrints {pick, eligible, skipped} for the cloud worker routine, or {picks: [up to N]} with --list. Read-only.');
  process.exit(0);
}

require('./lib/load-env').loadEnv();

const REPO = 'thomaspryor/broadwayscore';
// BRO-4653: the slot-aware retry. It re-runs only while the landing slot is free,
// so a resume never spends an attempt evicting (or being evicted by) another landing.
const RERUN_LAND = (run) => `node scripts/land-retry-cancelled.js --run=${run.id}`;
const RESUME_INSTRUCTIONS = (ref, run, kind) => [
  kind === 'evicted'
    ? `RESUME, not a new card: this card is already yours (In Progress) and its landing ${ref} was evicted from the shared landing slot (run ${run.id} cancelled), not refused.`
    : `RESUME, not a new card: this card is already yours (In Progress) and Land refused its landing ${ref}.`,
  'Step 3 claim is a no-op on it. Do NOT start a new branch.',
  'First run the card\'s verify command (pick.verify) on up-to-date origin/main: if it already passes, the work landed another way, so skip to step 7.',
  ...(kind === 'evicted' ? [
    `Nothing to fix: run ${RERUN_LAND(run)}. "re-run requested" → follow it. "landing slot busy" → spend nothing: land-retry-cancelled.yml re-runs it when the slot frees, so follow the ref. "skip (attempts-exhausted)" → merge origin/main into the ref and push to the SAME ref (a fresh run). Any other skip (already re-running, landed, superseded) → follow the ref, never push on top of a live landing. Without gh: re-run the failed jobs of run ${run.id} through the GitHub MCP tools, only when no other Land run is waiting for the landing slot.`,
  ] : [
  `Check it out: git worktree remove --force .claude/worktrees/resume 2>/dev/null; git fetch origin ${ref} && git worktree add --detach .claude/worktrees/resume FETCH_HEAD.`,
  `Read why Land refused run ${run.id}${run.url ? ` (${run.url})` : ''}: list its failed jobs (gh api repos/${REPO}/actions/runs/${run.id}/jobs --jq '.jobs[] | select(.conclusion=="failure") | .id'), then each job's annotations (gh api repos/${REPO}/check-runs/<job id>/annotations) or log (gh api repos/${REPO}/actions/jobs/<job id>/logs).`,
  'Fix it there (merge origin/main first if it conflicts), then push to the SAME ref:',
  `git push origin HEAD:refs/heads/${ref}`,
  ]),
  'Follow that Land run to its verdict in this same turn: wait until the ref disappears (landed) or the run fails (fix and push again). Never end the turn while it runs.',
  'Then continue at step 6 (verify on main, then close or pause the card).',
].join(' ');

function listLandRefs() {
  const { execFileSync } = require('child_process');
  const out = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/land/*'], { encoding: 'utf8', timeout: 60_000 });
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, ref] = line.split('\t');
    return { sha, ref: ref.replace(/^refs\/heads\//, '') };
  });
}

function latestLandRun(ref) {
  const { execFileSync } = require('child_process');
  const out = execFileSync('gh', ['api', `repos/${REPO}/actions/runs?branch=${encodeURIComponent(ref)}&per_page=1`,
    '--jq', '.total_count as $n | .workflow_runs[0] // empty | {id, status, conclusion, headSha: .head_sha, updatedAt: .updated_at, url: .html_url, attempts: $n, runAttempt: .run_attempt}'],
  { encoding: 'utf8', timeout: 60_000 }).trim();
  return out ? JSON.parse(out) : null;
}

/** True while any dispatched Land run is queued or running (its head_branch is main, not the ref). */
function landDispatchInFlight() {
  const { execFileSync } = require('child_process');
  const out = execFileSync('gh', ['api', `repos/${REPO}/actions/workflows/land.yml/runs?event=workflow_dispatch&per_page=10`,
    '--jq', '[.workflow_runs[] | select(.status != "completed")] | length'], { encoding: 'utf8', timeout: 60_000 }).trim();
  return Number(out) > 0;
}

/** Stranded landings to resume, best first. Never throws: resume is best-effort. */
function findResume(issues, nowMs) {
  const { findResumeCandidates, landRefCardNumber, resumableCardsByNumber } = require('./lib/cloud-worker-pick.js');
  try {
    // Only refs naming a started P0/P1 card need a run lookup (one API call each).
    const cards = resumableCardsByNumber(issues);
    const refs = listLandRefs().filter((r) => cards.has(landRefCardNumber(r.ref)));
    for (const r of refs) r.lastRun = latestLandRun(r.ref);
    if (!refs.length) return [];
    return findResumeCandidates(issues, refs, { nowMs, landDispatchInFlight: landDispatchInFlight() });
  } catch (err) {
    console.error(`[cloud-worker-pick] resume check skipped: ${err && err.message ? err.message.split('\n')[0] : err}`);
    return [];
  }
}

// Comment reads per firing (one Linear call each). Past this, take the next card unchecked.
const MAX_HISTORY_CHECKS = 15;

/**
 * First candidate an earlier worker didn't pause on (BRO-4574). Counts each skip
 * in `historySkipped`. A failed comment read keeps the card: pause memory is advisory.
 */
async function firstUnpaused(queue, nowMs, historySkipped) {
  const { getIssue } = require('./lib/linear-client.js');
  const { pausedHistorySkipReason } = require('./lib/cloud-worker-pick.js');
  for (let i = 0; i < queue.length; i++) {
    if (i >= MAX_HISTORY_CHECKS) {
      console.error(`[cloud-worker-pick] ${MAX_HISTORY_CHECKS} history checks used; ${queue[i].issue.identifier} taken unchecked`);
      return queue[i];
    }
    let reason = null;
    try {
      const full = await getIssue(queue[i].issue.identifier);
      const nodes = full && full.comments ? full.comments.nodes : [];
      // getIssue reads 50 comments; past that the latest report may be cut off.
      if (nodes.length >= 50) console.error(`[cloud-worker-pick] ${queue[i].issue.identifier}: 50+ comments, pause history may be incomplete`);
      reason = pausedHistorySkipReason(nodes, nowMs);
    } catch (err) {
      console.error(`[cloud-worker-pick] history check skipped for ${queue[i].issue.identifier}: ${err && err.message ? err.message.split('\n')[0] : err}`);
    }
    if (!reason) return queue[i];
    historySkipped[reason] = (historySkipped[reason] || 0) + 1;
    console.error(`[cloud-worker-pick] skip ${queue[i].issue.identifier}: ${reason}`);
  }
  return null;
}

async function main() {
  const { listOpenIssuesWithDescriptions, listIssueComments } = require('./lib/linear-client.js');
  const { verifyCommand } = require('./lib/linear-drain-parked.js');
  const { pickCloudCard, skipReason, isStartNow } = require('./lib/cloud-worker-pick.js');
  const issues = await listOpenIssuesWithDescriptions();
  const nowMs = Date.now();
  // A VERIFY posted as a comment arms a card, and a newer one corrects the
  // description's (BRO-4642). The list query has no comments, so read them for
  // every P0/P1 card, parked and started (resume) ones included: one request
  // per 50 cards.
  const candidates = issues.filter((iss) => !/^(malformed|not-p0-p1)$/.test(skipReason(iss, nowMs) || ''));
  let commentsRead = true;
  if (candidates.length) {
    try {
      const comments = await listIssueComments(candidates.map((iss) => iss.identifier));
      for (const iss of candidates) if (comments.has(iss.identifier)) iss.comments = { nodes: comments.get(iss.identifier) };
    } catch (err) {
      commentsRead = false;
      console.error(`[cloud-worker-pick] comment VERIFY check skipped: ${err && err.message ? err.message.split('\n')[0] : err}`);
    }
  }
  const { ordered, eligible, skipped, startNowSkipped } = pickCloudCard(issues, { nowMs });
  const queue = [
    ...findResume(issues, nowMs).map((r) => ({ issue: r.issue, resume: r })),
    ...ordered.map((iss) => ({ issue: iss, resume: null })),
  ];
  const historySkipped = {};
  const listN = listArg(process.argv);
  if (listN) {
    // Without comments the Codex bounce marker is invisible: hand Codex nothing this time.
    if (!commentsRead) {
      console.log(JSON.stringify({ picks: [], eligible, open: issues.length, skipped, startNowSkipped, historySkipped, commentsUnavailable: true }, null, 2));
      return;
    }
    // Same queue minus resume entries: a stranded landing is the Claude worker's to finish.
    // Cards Codex already bounced go to the Claude worker, never back to Codex.
    const { codexBouncedRecently } = require('./lib/codex-runner.js');
    const rest = queue.filter((q) => !q.resume && !codexBouncedRecently(q.issue.comments && q.issue.comments.nodes, nowMs));
    const picks = [];
    while (picks.length < listN && rest.length) {
      const chosen = await firstUnpaused(rest, nowMs, historySkipped);
      if (!chosen) break;
      picks.push(pickJson(chosen.issue, null, nowMs, verifyCommand, isStartNow));
      rest.splice(0, rest.indexOf(chosen) + 1);
    }
    console.log(JSON.stringify({ picks, eligible, open: issues.length, skipped, startNowSkipped, historySkipped }, null, 2));
    return;
  }
  const chosen = await firstUnpaused(queue, nowMs, historySkipped);
  const pick = chosen && chosen.issue;
  const resume = chosen && chosen.resume;
  const out = {
    pick: pickJson(pick, resume, nowMs, verifyCommand, isStartNow),
    eligible,
    open: issues.length,
    skipped,
    startNowSkipped,
    // Resume candidates and eligible cards passed over for an earlier pause.
    historySkipped,
  };
  console.log(JSON.stringify(out, null, 2));
  if (resume) {
    // The routine prompt says "new branch"; .claude/CLOUD.md says pick.resume
    // overrides that. Repeat it where a skimming worker will see it.
    console.error(`[cloud-worker-pick] RESUME ${pick.identifier}: follow pick.resume.instructions (land ref ${resume.ref}), not a new branch.`);
  }
}

/** `--list=N` as a positive integer, 0 when absent; a malformed value is an error, never the single-pick output. */
function listArg(argv) {
  const a = argv.find((x) => x === '--list' || x.startsWith('--list='));
  if (!a) return 0;
  const n = Number(a.slice('--list='.length));
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[cloud-worker-pick] bad ${a}: want --list=N with N a positive integer`);
    process.exit(2);
  }
  return n;
}

function pickJson(pick, resume, nowMs, verifyCommand, isStartNow) {
  return pick && {
    identifier: pick.identifier,
    title: pick.title,
    priority: pick.priority,
    state: pick.state && pick.state.name,
    url: pick.url,
    verify: verifyCommand(pick),
    startNow: isStartNow(pick, nowMs),
    ...(resume && {
      resume: {
        landRef: resume.ref,
        lastRun: resume.lastRun,
        kind: resume.kind,
        instructions: RESUME_INSTRUCTIONS(resume.ref, resume.lastRun, resume.kind),
      },
    }),
  };
}

main().catch((err) => {
  console.error(`[cloud-worker-pick] ${err && err.message ? err.message : err}`);
  process.exit(1);
});
