'use strict';
/**
 * Has main's Test Suite been red too long, with nobody paged?
 *
 * On 2026-08-17, main's Test Suite failed continuously from 04:05 to ~15:40 —
 * roughly eight hours across dozens of pushes by many sessions — and nothing
 * alarmed. checkCronHealth()'s existing test.yml check only asks "did the
 * newest run pass, or has ANY run succeeded in the last 48h?" — an 8h streak
 * never crosses that 48h window, so it stayed silent the whole time. This
 * file answers a different question: "how long has it been since main was
 * last green?" and alarms well before the 48h staleness check would.
 *
 * Pure so it can be tested against fixtures; the caller does the `gh` calls
 * (task #1748: card explicitly requires no network in the predicate).
 *
 * `runs` must be ordered newest-first, matching `gh run list`'s default
 * order. Each run:
 *   { headSha, createdAt, conclusion, jobs?: [{ name, conclusion,
 *     steps?: [{ name, conclusion }] }] }
 * `jobs` is optional — only needed for runs the caller suspects are
 * infra-only failures (fetch it for red runs, not green ones, to keep the
 * `gh` call count down).
 */

const crypto = require('crypto');

const DEFAULT_THRESHOLD_HOURS = 2;

function parseMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// GitHub Actions always opens a job with a synthetic "Set up job" step before
// any workflow-defined step runs. If THAT is the only step that failed —
// runner allocation, a 429 fetching an action, network flake — the workflow
// never got far enough to run a single test. That is not evidence main is
// broken; counting it toward the streak is exactly the false positive that
// would train the owner to ignore the real alarm (observed on run
// 32044013575: HTTP 429 fetching actions/github-script, zero tests run).
function isSetupJobOnlyFailure(job) {
  const steps = job?.steps || [];
  const failingSteps = steps.filter((s) => s?.conclusion && !['success', 'skipped'].includes(s.conclusion));
  if (!failingSteps.length) return false; // job failed but no step says why — can't prove infra, treat as real
  return failingSteps.every((s) => /^set up job$/i.test(String(s.name || '').trim()));
}

// Absence of job-level detail must never manufacture an infra excuse — only
// classify a run as infra-only when the evidence explicitly says so.
// Jobs that report but never decide main's color (job-level continue-on-error
// in test.yml, BRO-3425). Their check run still concludes 'failure', so every
// "which job is failing" reader must skip them or it blames data drift.
const NON_BLOCKING_JOB_NAMES = new Set(['Data Validation']);
const isBlockingFailedJob = (j) => j?.conclusion && !['success', 'skipped'].includes(j.conclusion) && !NON_BLOCKING_JOB_NAMES.has(j.name);

function isInfraOnlyFailure(run) {
  if (run.conclusion === 'success') return false;
  const jobs = run.jobs || [];
  if (!jobs.length) return false;
  const failingJobs = jobs.filter(isBlockingFailedJob);
  if (!failingJobs.length) return false;
  return failingJobs.every(isSetupJobOnlyFailure);
}

// A run can only be classified 'cancelled-and-benign' with EXPLICIT job
// evidence that nothing actually failed (every job also cancelled, none
// failed). No evidence must never buy a pass — that was this function's
// original bug: it defaulted an unexplained cancellation to benign, exactly
// the "absence of evidence manufactures an excuse" mistake isInfraOnlyFailure
// above is careful to avoid. On main, test.yml's concurrency group is keyed
// per-commit with cancel-in-progress:false (see .github/workflows/test.yml,
// "On main: PER-COMMIT group... no push can ever supersede another's run") —
// routine supersession-cancellation on main is now rare, not the common case
// task #80 described when this carve-out was first written, so defaulting to
// red on missing evidence is the conservative — and now also the accurate —
// choice.
// A job that hits its `timeout-minutes` is reported by GitHub with
// conclusion 'cancelled', identically to one cancelled by supersession — but
// its STEPS still carry the failures it accumulated before the runner pulled
// the plug. Looking only at job conclusions therefore cannot tell "superseded,
// nothing ran" from "ran, failed, then timed out", and scores the second as
// benign. Observed on main 2026-09-01, three consecutive runs (33466229004,
// 33469747007, 33471909555): Data Validation ran ~35m against
// timeout-minutes: 30, conclusion 'cancelled', with
// "Validate provisional show venue+dates against Playbill" conclusion
// 'failure' inside it — and assessMainRedStreak() returned alarm:null,
// redRunCount:0 while main was failing on every push.
// Only failures that happened BEFORE the runner started cancelling count. When
// a job is cancelled mid-flight, GitHub stamps every remaining `if: always()`
// step 'failure' with zero duration even though it never ran (observed on run
// 33416106078: Data Validation cancelled during Checkout at step 2, then steps
// 13-53 all 'failure' at an identical timestamp). Counting those would alarm on
// runs where nothing actually failed and no test ever executed — the exact
// false positive isSetupJobOnlyFailure exists to prevent. A genuine pre-cancel
// failure precedes the first cancelled step; a phantom one follows it.
// Duration is NOT a usable discriminator here: legitimately fast steps are also
// 0s.
// Shared by hasFailingStep (boolean) and failingStepSignatures (needs the
// step object itself, to name it in the signature).
function firstFailingStepEntry(job) {
  const steps = job?.steps || [];
  const ordered = steps.every((s) => Number.isFinite(s?.number))
    ? [...steps].sort((a, b) => a.number - b.number)
    : steps;
  for (const s of ordered) {
    if (s?.conclusion === 'cancelled') return null; // everything after this is phantom
    if (s?.conclusion === 'failure') return s;
  }
  return null;
}

function hasFailingStep(job) {
  return !!firstFailingStepEntry(job);
}

function isBenignCancellation(run) {
  if (run.conclusion !== 'cancelled') return false;
  const jobs = run.jobs || [];
  if (!jobs.length) return false; // no evidence — do not manufacture a pass
  // An explicit step-level failure is positive evidence that something DID
  // fail, which is exactly what this function requires the absence of. A
  // superseded run has no failing steps; a timed-out one does.
  if (jobs.some(hasFailingStep)) return false;
  // Every job must have an EXPLICIT non-failure conclusion — a job with no
  // conclusion yet (or a conclusion outside this list) is not evidence of
  // "nothing failed", so it does not qualify as benign.
  return jobs.every((j) => ['success', 'skipped', 'cancelled'].includes(j?.conclusion));
}

function classify(run) {
  if (run.conclusion === 'success') return 'green';
  // Still running/queued. `gh run list --json conclusion` reports this as an
  // EMPTY STRING, not null (confirmed live: `gh run view <id> --json
  // status,conclusion` on an in-progress run returns {"conclusion":"",
  // "status":"in_progress"}) — checking only `== null` let two in-progress
  // runs get classified 'red' and fire a false alarm the moment they were
  // queued. `!run.conclusion` catches null, undefined, AND ''.
  if (!run.conclusion) return 'neutral';
  if (isInfraOnlyFailure(run)) return 'neutral';
  if (isBenignCancellation(run)) return 'neutral';
  return 'red';
}

function failingJobNames(run) {
  const jobs = run.jobs || [];
  const names = jobs
    .filter(isBlockingFailedJob)
    .map((j) => j.name)
    .filter(Boolean);
  return names.length ? names.join(', ') : (run.conclusion || 'unknown');
}

/**
 * @param {Array} runs Test Suite runs on main, newest-first.
 * @param {number} nowMs
 * @param {number} thresholdHours alarm once main has been red this long (default 2h)
 * @returns {{alarm: string|null, redStreakHours: number|null, redRunCount: number,
 *   firstRedSha: string|null, lastGreenAt: string|null}}
 */
function assessMainRedStreak(runs, nowMs = Date.now(), thresholdHours = DEFAULT_THRESHOLD_HOURS) {
  const classified = (runs || []).map((r) => ({ run: r, cls: classify(r) })).filter((x) => x.cls !== 'neutral');

  let i = 0;
  while (i < classified.length && classified[i].cls === 'red') i++;
  const redRuns = classified.slice(0, i).map((x) => x.run);

  if (!redRuns.length) {
    return { alarm: null, redStreakHours: 0, redRunCount: 0, firstRedSha: null, lastGreenAt: null };
  }

  const lastGreenRun = classified[i]?.run || null; // undefined = no green found in the window we were given
  const firstRedRun = redRuns[redRuns.length - 1]; // oldest of the consecutive reds — the FIRST red commit
  const anchorMs = lastGreenRun ? parseMs(lastGreenRun.createdAt) : parseMs(firstRedRun.createdAt);
  const redStreakHours = anchorMs === null ? null : (nowMs - anchorMs) / 3600000;

  if (redStreakHours === null || redStreakHours <= thresholdHours) {
    return {
      alarm: null,
      redStreakHours,
      redRunCount: redRuns.length,
      firstRedSha: firstRedRun.headSha || null,
      lastGreenAt: lastGreenRun ? lastGreenRun.createdAt : null,
    };
  }

  const sha = firstRedRun.headSha ? String(firstRedRun.headSha).slice(0, 9) : 'unknown commit';
  const job = failingJobNames(firstRedRun);
  // No green found in the queried window means the true streak may predate the
  // oldest run we looked at — say so rather than reporting a duration that
  // reads as exact when it is really a floor.
  // "since last green", not "continuously red for" — the gap between the
  // last confirmed-green run and now may include a period before it actually
  // broke (no run in that window would still say the same thing). That is
  // the honest claim: nobody has SEEN main pass in this long, not a precise
  // clock on when it broke.
  const durationClause = lastGreenRun
    ? `has had no confirmed-green run in ${redStreakHours.toFixed(1)}h`
    : `has had no confirmed-green run in AT LEAST ${redStreakHours.toFixed(1)}h (no green run found in the runs checked — actual gap may be longer)`;
  const alarm = `main's Test Suite ${durationClause} ` +
    `(${redRuns.length} failing run${redRuns.length === 1 ? '' : 's'}) — ` +
    `first red commit ${sha}, job "${job}". Nobody has looked; every session keeps pushing onto a red trunk.`;

  return {
    alarm,
    redStreakHours,
    redRunCount: redRuns.length,
    firstRedSha: firstRedRun.headSha || null,
    lastGreenAt: lastGreenRun ? lastGreenRun.createdAt : null,
  };
}

// Converts a GitHub Actions `needs` context object (job name -> { result })
// into the same comma-joined failing-job-name string failingJobNames()
// computes for gh-API-sourced runs — so test.yml's push-triggered
// "test-summary" job (which already has every sibling job's result for free
// via `needs`, no extra API call) and the gh-API-sourced backstop in
// health-check.js (checkMainRedStreak) describe an incident identically.
// Returns '' when nothing in `needsObj` failed (mirrors run.conclusion
// 'success' rather than falling back to failingJobNames()'s "no names found"
// branch, which would otherwise return the literal string 'success').
function failingJobsFromNeeds(needsObj) {
  const jobs = Object.entries(needsObj || {}).map(([name, v]) => ({ name, conclusion: v && v.result }));
  const anyFailing = jobs.some((j) => j.conclusion && !['success', 'skipped'].includes(j.conclusion));
  if (!anyFailing) return '';
  return failingJobNames({ conclusion: 'failure', jobs });
}

// ── per-breakage signature (BRO-3865) ───────────────────────────────────────
//
// The push-triggered dispatch below used to file every red push under ONE
// conditionKey ('test-yml:main-streak') regardless of which job/step/test
// was actually failing. While main stayed red for any reason, routeAlert's
// cooldown/dedup collapsed every NEW, unrelated breakage into that same
// stale condition — main was red 2026-08-12 through today (63 notifications,
// one card) while at least four independent failures came and went under it.
// Keying on a signature of WHAT is failing, not just THAT main is failing,
// gives each distinct breakage its own ledger entry and its own card.

const RED_SIGNATURE_PREFIX = 'test-yml:red:';

function sha1Short(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 8);
}

/**
 * conditionKey for one distinct breakage. Two different bugs in the SAME
 * step (job+step alone can't tell them apart — batched `node --test` runs
 * dozens of files in one step) still hash to different keys as long as
 * `testName` differs; the same bug recurring on a later push hashes
 * identically, so routeAlert's existing cooldown/dedup still collapses
 * re-notifies for it rather than re-filing.
 */
function stepFailureSignature(jobName, stepName, testName) {
  const hash = sha1Short(`${stepName || ''}::${testName || ''}`);
  return `${RED_SIGNATURE_PREFIX}${jobName || 'unknown'}:${hash}`;
}

// node --test's TAP reporter prints `not ok N - <name>` for each failing
// test; the first one found is treated as the test that defines the
// signature. A step with no TAP line (a non-test step, e.g. actionlint or a
// data-validation script) falls back to job+step alone, which still
// separates it from every OTHER distinct step/job.
//
// This scans ONE JOB's raw log at a time (caller fetches per-job via `gh api
// repos/{owner}/{repo}/actions/jobs/{jobId}/logs`) rather than the whole
// run's `gh run view --log-failed` dump: `--log-failed` REFUSES to return
// anything while the RUN is still in progress ("run <id> is still in
// progress; logs will be available when it is complete", live-verified
// 2026-09-20 against run 35530177910) — and the run calling this script is,
// by construction, always still in progress at the moment it calls this
// (test-summary is one of the LAST jobs to start, via `needs:`, but the
// overall run doesn't conclude until test-summary itself finishes). The
// per-job REST logs endpoint has no such restriction — it only requires the
// INDIVIDUAL job to be done, which `needs:` already guarantees for every
// sibling by the time test-summary runs.
const TAP_NOT_OK_RE = /^\s*not ok \d+ - (.+?)\s*$/;

/**
 * @param {string} jobLogText - raw text from `gh api .../actions/jobs/{id}/logs`
 *   (GitHub-Actions-timestamp-prefixed lines, e.g. "2026-09-20T18:38:38.233Z msg")
 * @returns {string|null} the first TAP failing test name in this job's log, or null
 */
function firstFailingTestNameInJobLog(jobLogText) {
  for (const raw of String(jobLogText || '').split('\n')) {
    // Strip the leading GH Actions timestamp the same way trunk-status.js's
    // parseFailedLog does for its differently-shaped (tab-framed) input —
    // `\S*Z ` matches "2026-09-20T18:38:38.2331444Z ". A line that starts
    // with something else first (e.g. an ANSI-colored echoed comment
    // containing the literal substring "not ok N - <name>" as documentation
    // text — this repo's own run_batch() shell function does exactly that)
    // is left untouched and correctly fails the anchored TAP_NOT_OK_RE match
    // below, since it no longer starts with "not ok" after whitespace.
    const line = raw.replace(/^\S*Z\s?/, '').replace(/\r$/, '');
    const m = TAP_NOT_OK_RE.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * One entry per job that failed on a REAL step in `run` (excludes setup-
 * job-only infra hiccups and benign supersessions/phantom-cancel steps —
 * same exclusions classify()/isBenignCancellation() apply, so a run this
 * function is called on should already be known-red at the run level).
 * @param {{jobs?: Array}} run
 * @param {Map<string,string>} [testNameByJob] job name -> firstFailingTestNameInJobLog() result, from the caller's per-job log fetch
 * @returns {Array<{job:string, step:string, testName:string|null, conditionKey:string}>}
 */
function failingStepSignatures(run, testNameByJob) {
  const jobs = (run && run.jobs) || [];
  const out = [];
  for (const job of jobs) {
    if (!job?.conclusion || ['success', 'skipped'].includes(job.conclusion)) continue;
    if (isSetupJobOnlyFailure(job)) continue;
    const step = firstFailingStepEntry(job);
    if (!step) continue; // no real failing step — nothing to attribute
    const testName = testNameByJob?.get(job.name || '') || null;
    out.push({
      job: job.name || 'unknown',
      step: step.name || 'unknown',
      testName,
      conditionKey: stepFailureSignature(job.name, step.name, testName),
    });
  }
  return out;
}

/**
 * Which currently-OPEN 'test-yml:red:*' ledger keys should resolve given
 * this run's job results. A key resolves ONLY when its own job is
 * CONFIRMED green (conclusion === 'success') on THIS run — never merely
 * because the job is absent, skipped, or its conclusion is otherwise
 * undetermined here. Resolving on absence would treat "we have no evidence"
 * as "it passed": e.g. a job skipped by a path filter, or a job that's
 * STILL failing but now on a different step than the one the open
 * condition names (only its CURRENT failing step appears in
 * `currentSignatures` — an older signature for a step that failed on a
 * prior push, then got skipped because the job never got past an even
 * earlier step, must not read as resolved). This is the same "absence of
 * evidence must not manufacture an excuse" principle classify()/
 * isBenignCancellation() apply elsewhere in this file (adversarial review,
 * BRO-3865) — independent of whether OTHER signatures or the overall run
 * are still red, so one job going fully green doesn't have to wait for
 * every OTHER job to go green too.
 * @param {Array<string>} openConditionKeys currently-open ledger keys (any prefix; non-red keys are ignored)
 * @param {{jobs?: Array}} run this run's job data (same shape failingStepSignatures() takes)
 * @param {Array<{conditionKey:string}>} currentSignatures failingStepSignatures(run, ...) output for THIS run
 */
function signaturesToResolve(openConditionKeys, run, currentSignatures) {
  const currentSet = new Set((currentSignatures || []).map((s) => s.conditionKey));
  const confirmedGreenJobPrefixes = ((run && run.jobs) || [])
    .filter((j) => j?.conclusion === 'success')
    .map((j) => `${RED_SIGNATURE_PREFIX}${j.name || ''}:`);
  return (openConditionKeys || [])
    .filter((k) => typeof k === 'string' && k.startsWith(RED_SIGNATURE_PREFIX))
    .filter((k) => !currentSet.has(k))
    .filter((k) => confirmedGreenJobPrefixes.some((prefix) => k.startsWith(prefix)));
}

module.exports = {
  NON_BLOCKING_JOB_NAMES,
  assessMainRedStreak,
  DEFAULT_THRESHOLD_HOURS,
  failingJobNames,
  hasFailingStep,
  failingJobsFromNeeds,
  RED_SIGNATURE_PREFIX,
  stepFailureSignature,
  firstFailingTestNameInJobLog,
  failingStepSignatures,
  signaturesToResolve,
};
