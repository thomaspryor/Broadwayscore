#!/usr/bin/env node
/**
 * route-main-streak-signatures.js — BRO-3865: file/resolve per-breakage
 * alert-router conditions for main's test.yml, keyed by WHICH job/step/test
 * is failing rather than just "main is red".
 *
 * Before this, test.yml's push-triggered dispatch filed every red push under
 * ONE conditionKey ('test-yml:main-streak'). While main stayed red for ANY
 * reason, routeAlert's cooldown/dedup collapsed every NEW, unrelated
 * breakage into that same stale condition — main was red 2026-08-12 through
 * 2026-09-20 (63 notifications, one card) while at least four independent
 * failures came and went under it, none getting its own card.
 *
 * Invoked from test.yml's test-summary job on every push to main (success or
 * failure, never on cancelled runs — see the workflow step's `if:`).
 * Resolution always runs; dispatch/escalation only when the caller passes
 * the matching flag (it already gated should_dispatch/should_escalate on the
 * consecutive-failure streak before invoking this script).
 *
 * gh CLI for job/step data (`gh run view --json jobs`), same choice as
 * produce-trunk-snapshot.js — `gh` already carries the runner's GITHUB_TOKEN
 * auth. But `gh run view --log-failed` / `--json jobs --log` refuse to
 * return ANYTHING while the overall RUN is still in progress ("run <id> is
 * still in progress; logs will be available when it is complete",
 * live-verified 2026-09-20 against run 35530177910) — and this script's own
 * run is BY CONSTRUCTION always still in progress when it executes
 * (test-summary is one of the last jobs via `needs:`, but the run only
 * concludes once test-summary itself finishes). So per-job LOG text comes
 * from `GET /repos/{owner}/{repo}/actions/jobs/{jobId}/logs` via a raw
 * fetch() call instead — that endpoint only requires the INDIVIDUAL job to
 * be done, which `needs:` already guarantees for every sibling by the time
 * this runs. Raw fetch(), not `gh api`, for this ONE call specifically:
 * `gh api` refuses to print output containing terminal escape sequences
 * (raw job logs are full of them — this repo's own ::group:: output uses
 * ANSI color codes) unless its stdout is a TTY, and live-verified
 * 2026-09-20 (run 35532058380) that even redirecting to a real file
 * descriptor — not just a captured pipe — still hit this guard on the
 * GitHub-hosted runner's gh version, despite working around it locally.
 * fetch() has no concept of terminal rendering at all, so the whole class
 * of guard doesn't apply.
 *
 * Never lets a `gh` hiccup flip an otherwise-green run red (adversarial
 * review, BRO-3865): every `gh` call is try/caught and degrades to "skip
 * this run's dispatch/resolution, try again next push" rather than throwing
 * — the whole point of this script is to make main-red visibility MORE
 * reliable, not to become a new way for main to go red on its own.
 *
 *   node scripts/route-main-streak-signatures.js --run-id=$GITHUB_RUN_ID --dispatch --streak=2
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  failingStepSignatures, firstFailingTestNameInJobLog, signaturesToResolve, RED_SIGNATURE_PREFIX,
  trackSignatureAbsence, STALE_ABSENT_RUN_THRESHOLD,
} = require('./lib/main-red-streak.js');
const { routeAlert, loadLedger, resolveCondition, patchCondition } = require('./lib/owner-alert-router.js');
// BRO-3907: every card this script files used to carry prose-only acceptance
// criteria ("Condition X no longer fires") — linear-next.js's dispatch gate
// refuses that outright, so every one of these cards sat undispatchable. This
// resolves the failing step's own `run:` command out of test.yml (or a
// job-level proxy) into a `VERIFY:` line dispatch can actually arm.
const { verifyForSignature, findStepRunCommandInWorkflow } = require('./lib/red-signature-verify-cmd.js');

const TEST_YML_PATH = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');

const USAGE = `route-main-streak-signatures.js — BRO-3865 per-breakage alert routing for main's test.yml
  node scripts/route-main-streak-signatures.js --run-id=<id> [--dispatch] [--escalate] [--prev-url=<url>] [--streak=<n>] [--exclude-job=<name> ...]
    --run-id       required — the workflow run to inspect (gh run view --json jobs; raw fetch() for job logs)
    --exclude-job  a job NAME to drop before computing signatures; repeatable (test.yml passes its own
                   "Test Summary" and the non-blocking "Data Validation")
    --dispatch     file an 'auto' card for each currently-failing signature (caller gates this on streak>=2)
    --escalate     also raise 'test-yml:main-streak-escalation' (caller gates this on streak>=4; digest-only since BRO-4141)
    --prev-url     previous failed run's URL, folded into the escalation email's fields
    --streak       consecutive-failure count, folded into alert fields/description
  Resolution (closing signatures whose job went green on THIS run) always runs, independent of the flags above.
  Stale resolution (BRO-4054) also always runs: an open signature whose job failed on ${STALE_ABSENT_RUN_THRESHOLD}
  consecutive runs WITHOUT that signature appearing is resolved with resolveReason 'stale-signature'.
  Cards filed here are dispatch-at-filing (no PARKED sentinel; the Mac-side red-first pass in
  bsc-reconcile's 5-min tick dispatches them — scripts/red-first-dispatch.js runs that pass by hand).
  Any gh/API failure degrades to "do nothing this run" rather than throwing — never fails the calling job.
  --help, -h     print this usage and exit — no reads/writes
`;

function gh(args, { maxBuffer = 32 * 1024 * 1024, timeout = 120000 } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer, timeout });
}

function parseArgs(argv) {
  const out = { dispatch: false, escalate: false, runId: null, prevUrl: '', streak: '?', excludeJobs: [] };
  for (const arg of argv) {
    if (arg === '--dispatch') out.dispatch = true;
    else if (arg === '--escalate') out.escalate = true;
    else if (arg.startsWith('--run-id=')) out.runId = arg.slice('--run-id='.length);
    else if (arg.startsWith('--prev-url=')) out.prevUrl = arg.slice('--prev-url='.length);
    else if (arg.startsWith('--streak=')) out.streak = arg.slice('--streak='.length);
    else if (arg.startsWith('--exclude-job=')) out.excludeJobs.push(arg.slice('--exclude-job='.length));
  }
  return out;
}

// Never throws: a transient `gh` failure (rate-limit, network blip, auth
// hiccup) here must degrade to "no job data this run", not crash the
// calling step and flip an otherwise-green push to red (adversarial review
// finding — the ORIGINAL version of this function had no try/catch, unlike
// every other gh() call in this file).
function fetchCurrentRunJobs(runId) {
  try {
    const jobsJson = JSON.parse(gh(['run', 'view', String(runId), '--json', 'jobs']));
    return jobsJson.jobs || [];
  } catch (err) {
    console.error(`::warning::[route-main-streak-signatures] gh run view --json jobs failed (${err.message}); skipping this run's dispatch/resolution — the next push will retry.`);
    return null;
  }
}

// Best-effort per job: a huge log or a transient API error must not block
// dispatch for the OTHER signatures, and must not throw up to main().
// Raw fetch(), not `gh api` — see the file header for why `gh api` cannot
// be made to work for this specific call.
async function fetchJobLogText(jobId) {
  const { GITHUB_REPOSITORY, GH_TOKEN, GITHUB_TOKEN } = process.env;
  const token = GH_TOKEN || GITHUB_TOKEN;
  // null = "could not look" (BRO-4054: the stale tracker must then NOT count
  // an absence for this job); '' = looked, found no TAP line.
  if (!GITHUB_REPOSITORY || !jobId || !token) return null;
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/jobs/${jobId}/logs`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'route-main-streak-signatures',
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[route-main-streak-signatures] job log fetch failed for job ${jobId} (HTTP ${res.status}); this signature falls back to job+step only.`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.error(`[route-main-streak-signatures] job log fetch failed for job ${jobId} (${err.message}); this signature falls back to job+step only.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function runUrlFor(runId) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY) return '';
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${runId}`;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.runId) { console.error('[route-main-streak-signatures] --run-id is required'); process.exitCode = 1; return; }

  // The job THIS script runs inside (test-summary / "Test Summary") is
  // excluded: its own "Check results" step fails whenever ANY sibling job
  // fails (that's its entire job — `contains(needs.*.result, 'failure')`),
  // so including it would manufacture a signature that names the aggregator,
  // not a root cause, on every single red push. Matched by display NAME
  // (`--exclude-job`, passed literally from test.yml) because `gh run view
  // --json jobs` exposes no YAML-job-id equivalent to `github.job` to match
  // on instead — second-opinion-reviewed (BRO-3865) and accepted as the only
  // option this API offers, with this loud check as the mitigation: if the
  // name we were told to exclude doesn't match ANY job in this run, a rename
  // silently broke the exclusion and every push would start filing a
  // spurious "Test Summary" card — fail loudly instead of guessing.
  const allJobsFetched = fetchCurrentRunJobs(opts.runId);
  if (allJobsFetched === null) return; // gh failure already logged; do nothing this run
  for (const excludeJob of opts.excludeJobs.filter((name) => !allJobsFetched.some((j) => j?.name === name))) {
    console.error(`::warning::[route-main-streak-signatures] --exclude-job="${excludeJob}" matched no job on this run (jobs seen: ${allJobsFetched.map((j) => j?.name).join(', ')}) — the aggregator job may have been renamed; update the --exclude-job value in test.yml or every red push will file a spurious signature for it.`);
  }
  const jobs = allJobsFetched.filter((j) => !opts.excludeJobs.includes(j?.name));
  const run = { jobs };

  const ledger = loadLedger();
  const openRedConditions = Object.fromEntries(Object.entries(ledger.conditions || {})
    .filter(([key, c]) => c && c.status === 'open' && key.startsWith(RED_SIGNATURE_PREFIX)));
  const openRedKeys = Object.keys(openRedConditions);

  // BRO-4151: read test.yml up front (moved from the --dispatch-only block
  // below) so failingStepSignatures() can check each failing step's own
  // `run:` command — the reliable way to tell a bash-integration step (never
  // prints TAP output) from a `node --test` batch, instead of trusting the
  // "(bash integration)" step-name suffix convention alone, which a live
  // scan of THIS repo's own test.yml found several real steps don't follow
  // (e.g. "... (bash unit)", "... (task #819)"). Best-effort: a missing/
  // unreadable test.yml (should be impossible in a checkout that just ran
  // it) must not block dispatch — failingStepSignatures() falls back to the
  // step-name heuristic, and verifyForSignature's --dispatch use below falls
  // back to VERIFY: owner-judgment.
  let testYmlText = '';
  try {
    testYmlText = fs.readFileSync(TEST_YML_PATH, 'utf8');
  } catch (err) {
    console.error(`[route-main-streak-signatures] could not read ${TEST_YML_PATH} (${err.message}); bash-integration step detection falls back to the step-name heuristic, and (if --dispatch) every signature this run falls back to VERIFY: owner-judgment.`);
  }
  const resolveStepRunCommand = (jobName, stepName) => findStepRunCommandInWorkflow(testYmlText, jobName, stepName);

  // Test names matter for --dispatch (sharpening which card gets filed/
  // titled) AND, since BRO-4054, for judging whether an OPEN signature is
  // still present — a job+step-only signature never equals a job+step+test
  // key. Skip the per-job log fetch() calls only when neither applies (a
  // green run with nothing open, or a red run under the streak-2 gate with
  // no open red condition to re-judge).
  let testNameByJob = new Map();
  const unreliableJobs = new Set();
  if (opts.dispatch || openRedKeys.length) {
    for (const job of jobs) {
      if (!job?.conclusion || ['success', 'skipped'].includes(job.conclusion)) continue;
      if (!job.databaseId) { unreliableJobs.add(job.name || ''); continue; }
      const logText = await fetchJobLogText(job.databaseId);
      if (logText === null) { unreliableJobs.add(job.name || ''); continue; }
      const testName = firstFailingTestNameInJobLog(logText);
      if (testName) testNameByJob.set(job.name || '', testName);
    }
  }
  const currentSignatures = failingStepSignatures(run, testNameByJob, resolveStepRunCommand);

  // Resolve first, independent of --dispatch: a signature whose job is
  // CONFIRMED green must close even on a run where the streak dropped below
  // the dispatch threshold and --dispatch was never passed — the ledger
  // must not hold a stale open condition just because nothing new was filed
  // this run.
  const toResolve = signaturesToResolve(openRedKeys, run, currentSignatures);
  for (const key of toResolve) {
    resolveCondition(key, { reason: 'job-green' });
    console.log(`[route-main-streak-signatures] resolved ${key} — its job is confirmed green on this run`);
  }

  // BRO-4054 stale resolution: the signature's job is STILL failing, but on
  // something else, for STALE_ABSENT_RUN_THRESHOLD consecutive runs. The
  // Linear card itself is left to the Mac-side red-first follow-up sweep
  // (scripts/lib/red-first-dispatch.js), which knows whether a job is live;
  // CI only knows the ledger.
  const stillOpen = Object.fromEntries(Object.entries(openRedConditions).filter(([key]) => !toResolve.includes(key)));
  const stale = trackSignatureAbsence(stillOpen, currentSignatures, run, opts.runId, { unreliableJobs });
  for (const [key, absentRunIds] of Object.entries(stale.updates)) {
    patchCondition(key, { absentRunIds });
  }
  for (const key of stale.toResolve) {
    resolveCondition(key, { reason: 'stale-signature' });
    console.log(`[route-main-streak-signatures] resolved ${key} — stale: absent from ${STALE_ABSENT_RUN_THRESHOLD} consecutive failed runs (${(stale.updates[key] || []).join(', ')}) while its job kept failing elsewhere`);
  }

  if (!opts.dispatch) return;

  const runUrl = runUrlFor(opts.runId);
  for (const sig of currentSignatures) {
    const label = sig.testName ? `${sig.job} / ${sig.step} — "${sig.testName}"` : `${sig.job} / ${sig.step}`;
    const verify = verifyForSignature({ job: sig.job, step: sig.step }, testYmlText);
    await routeAlert({
      conditionKey: sig.conditionKey,
      title: `main test.yml red: ${label}`,
      description: `main's Test Suite is failing on ${label} (${opts.streak} consecutive push${opts.streak === '1' ? '' : 'es'} red). Direct pushes to main are not gated by required checks, so broken code is landing on the production branch. This card is scoped to THIS specific breakage — a different job/step/test failing at the same time gets its own card instead of deduping into this one.`,
      severity: 'error',
      disposition: 'auto',
      cardAction: 'Fix',
      fields: [
        { name: 'Job', value: sig.job },
        { name: 'Step', value: sig.step },
        { name: 'First failing test', value: sig.testName || 'n/a (non-test step, or no TAP line found)' },
        { name: 'This failed run', value: runUrl ? `[View logs](${runUrl})` : 'n/a' },
      ],
      url: runUrl || undefined,
      verify,
      // BRO-4054: file in dispatch mode (Todo, no PARKED sentinel) and stamp
      // the request on the condition — see owner-alert-router.js dispatchCard.
      dispatchAtFiling: { runId: String(opts.runId), runUrl: runUrl || null },
    }).catch((e) => console.error(`[route-main-streak-signatures] dispatch failed for ${sig.conditionKey}: ${e.message}`));
  }

  if (opts.escalate) {
    const failingJobsLabel = currentSignatures.length
      ? [...new Set(currentSignatures.map((s) => s.job))].join(', ')
      : 'unknown (job-set lookup unavailable)';
    await routeAlert({
      conditionKey: 'test-yml:main-streak-escalation',
      title: 'main test.yml STILL red — auto-dispatch did not resolve it',
      description: `main test.yml is STILL red after ${opts.streak} consecutive pushes — the auto-dispatch card(s) filed at the 2nd failure have not resolved it. Currently failing: ${failingJobsLabel}. Direct pushes to main are not gated by required checks, so broken code is landing on the production branch. Investigate and fix now.`,
      severity: 'error',
      disposition: 'human',
      model: 'opus',
      fields: [
        { name: 'This failed run', value: runUrl ? `[View logs](${runUrl})` : 'n/a' },
        { name: 'Previous failed run', value: opts.prevUrl ? `[View logs](${opts.prevUrl})` : 'n/a' },
        { name: 'Consecutive failures', value: opts.streak },
        { name: 'Currently failing job(s)', value: failingJobsLabel },
      ],
      url: runUrl || undefined,
      cooldownHours: 24,
    }).catch((e) => console.error(`[route-main-streak-signatures] escalation dispatch failed: ${e.message}`));
  }
}

main().catch((err) => {
  // Last-resort net: should be unreachable now that fetchCurrentRunJobs
  // never throws, but a bug here must still degrade rather than propagate a
  // non-zero exit that would fail the calling GitHub Actions step/job.
  console.error(`::warning::[route-main-streak-signatures] unexpected error: ${err.message} — this run's dispatch/resolution was skipped, next push will retry.`);
});
