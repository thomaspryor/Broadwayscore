#!/usr/bin/env node
/**
 * cloud-worker-pick.js — print the one P0/P1 card a scheduled cloud worker
 * session should take on this firing (BRO-4535). Read-only: it claims
 * nothing. Selection rules and their reasons: scripts/lib/cloud-worker-pick.js.
 *
 * Usage:
 *   node scripts/cloud-worker-pick.js           JSON: { pick, eligible, skipped }
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
  console.log('Usage: node scripts/cloud-worker-pick.js\nPrints {pick, eligible, skipped} for the cloud worker routine. Read-only.');
  process.exit(0);
}

require('./lib/load-env').loadEnv();

const REPO = 'thomaspryor/broadwayscore';
// Same call land-retry-cancelled.js makes; re-running keeps the run id, so the next pick sees its result.
const RERUN_LAND = (run) => `gh api -X POST repos/${REPO}/actions/runs/${run.id}/rerun-failed-jobs`;
const RESUME_INSTRUCTIONS = (ref, run, kind) => [
  kind === 'evicted'
    ? `RESUME, not a new card: this card is already yours (In Progress) and its landing ${ref} was evicted from the shared landing slot (run ${run.id} cancelled), not refused.`
    : `RESUME, not a new card: this card is already yours (In Progress) and Land refused its landing ${ref}.`,
  'Step 3 claim is a no-op on it. Do NOT start a new branch.',
  'First run the card\'s verify command (pick.verify) on up-to-date origin/main: if it already passes, the work landed another way, so skip to step 7.',
  ...(kind === 'evicted' ? [
    `Nothing to fix: re-run its cancelled jobs with ${RERUN_LAND(run)} (MCP fallback: re-run the failed jobs of run ${run.id}).`,
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

/** Stranded landing to resume, or null. Never throws: resume is best-effort. */
function findResume(issues, nowMs) {
  const { findResumeCard, landRefCardNumber, resumableCardsByNumber } = require('./lib/cloud-worker-pick.js');
  try {
    // Only refs naming a started P0/P1 card need a run lookup (one API call each).
    const cards = resumableCardsByNumber(issues);
    const refs = listLandRefs().filter((r) => cards.has(landRefCardNumber(r.ref)));
    for (const r of refs) r.lastRun = latestLandRun(r.ref);
    if (!refs.length) return null;
    return findResumeCard(issues, refs, { nowMs, landDispatchInFlight: landDispatchInFlight() });
  } catch (err) {
    console.error(`[cloud-worker-pick] resume check skipped: ${err && err.message ? err.message.split('\n')[0] : err}`);
    return null;
  }
}

async function main() {
  const { listOpenIssuesWithDescriptions } = require('./lib/linear-client.js');
  const { evaluateVerifiability } = require('./lib/verify-gate.js');
  const { pickCloudCard } = require('./lib/cloud-worker-pick.js');
  const issues = await listOpenIssuesWithDescriptions();
  const nowMs = Date.now();
  const resume = findResume(issues, nowMs);
  const { pick: fresh, eligible, skipped } = pickCloudCard(issues, { nowMs });
  const pick = resume ? resume.issue : fresh;
  const out = {
    pick: pick && {
      identifier: pick.identifier,
      title: pick.title,
      priority: pick.priority,
      state: pick.state && pick.state.name,
      url: pick.url,
      verify: evaluateVerifiability(pick.description || '').cmd,
      ...(resume && {
        resume: {
          landRef: resume.ref,
          lastRun: resume.lastRun,
          kind: resume.kind,
          instructions: RESUME_INSTRUCTIONS(resume.ref, resume.lastRun, resume.kind),
        },
      }),
    },
    eligible,
    open: issues.length,
    skipped,
  };
  console.log(JSON.stringify(out, null, 2));
  if (resume) {
    // The routine prompt says "new branch"; .claude/CLOUD.md says pick.resume
    // overrides that. Repeat it where a skimming worker will see it.
    console.error(`[cloud-worker-pick] RESUME ${pick.identifier}: follow pick.resume.instructions (land ref ${resume.ref}), not a new branch.`);
  }
}

main().catch((err) => {
  console.error(`[cloud-worker-pick] ${err && err.message ? err.message : err}`);
  process.exit(1);
});
