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
function isInfraOnlyFailure(run) {
  if (run.conclusion === 'success') return false;
  const jobs = run.jobs || [];
  if (!jobs.length) return false;
  const failingJobs = jobs.filter((j) => j?.conclusion && !['success', 'skipped'].includes(j.conclusion));
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
function isBenignCancellation(run) {
  if (run.conclusion !== 'cancelled') return false;
  const jobs = run.jobs || [];
  if (!jobs.length) return false; // no evidence — do not manufacture a pass
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
    .filter((j) => j?.conclusion && !['success', 'skipped'].includes(j.conclusion))
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

module.exports = { assessMainRedStreak, DEFAULT_THRESHOLD_HOURS };
