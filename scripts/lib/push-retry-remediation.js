/**
 * push-retry-remediation.js — proposal-only remediation for the call sites
 * scripts/audit-push-retry-budgets.js flags (BRO-2801).
 *
 * It never edits a workflow. For each flagged push-with-retry.sh call it
 * proposes numbers (MAX_RETRIES per call, PUSH_DEADLINE_SEC and
 * PUSH_API_FALLBACK_AFTER_ATTEMPTS per step, the job's timeout-minutes) and
 * proves them by re-running the audit's own evaluateStep on the proposed
 * values. Each real workflow edit still gets its own rule-18 review.
 *
 * Two answers per step, kept apart on purpose (second-opinion review):
 *   - clearsFlags: the smallest change that silences the audit. The audit's
 *     own header says fundableAttempts is an UPPER bound, so a step sitting
 *     exactly on the threshold is not proven funded — this is reported for
 *     information, never as the fix.
 *   - recommended: the smallest change that also leaves margin —
 *     fundableAttempts >= max(F'+1, MIN_RECOMMENDED_FUNDABLE) at the step's
 *     OWN GIT_NET_TIMEOUT_SEC — and still clears the audit's flags.
 *
 * Never shrinks a configured retry count or deadline. Sites a number cannot
 * judge are marked for a human instead of getting a proposal:
 *   - soft-fail calls (`|| echo`/`|| true` on the call line or its `\`
 *     continuation, or continue-on-error) — failing fast may be the point;
 *   - a PUSH_DEADLINE_SEC with a comment right above it — someone chose it;
 *   - a call inside a quoted string (PUSH_CMD="...") — run by another script;
 *   - files the audit itself under-parses.
 * mixed-safety-bundle is structural (split the step, BRO-2435): listed, no numbers.
 */
'use strict';

const audit = require('./audit-push-retry-budgets.js');

const SIZING_FLAGS = new Set([
  'retries-undersized-vs-deadline',
  'deadline-cannot-fund-retries',
  'fallback-early-trigger-unreachable',
  'job-timeout-margin-undersized',
]);
const STEP_FLAGS = ['retries-undersized-vs-deadline', 'deadline-cannot-fund-retries', 'fallback-early-trigger-unreachable'];
const MIN_RECOMMENDED_FUNDABLE = 4;
const MAX_RETRIES_CANDIDATE = 40;
const DEADLINE_GRID = Array.from({ length: (1800 - 300) / 60 + 1 }, (_, k) => 300 + k * 60);
const MAX_JOB_TIMEOUT_MIN = 360; // GitHub-hosted runner ceiling
const HUGE_JOB_TIMEOUT_MIN = 100000; // isolates per-step flags from the job margin

function stepFlagsFor({ maxRetries, deadlineSec, fallbackAfter, fallbackDisabled }) {
  const ev = audit.evaluateStep({
    maxRetries, deadlineSec, jobTimeoutMinutes: HUGE_JOB_TIMEOUT_MIN,
    fallbackAfterAttemptsOverride: fallbackAfter, fallbackDisabled,
  });
  return ev.flags.filter((f) => STEP_FLAGS.includes(f));
}

/**
 * Search the (R', D', F') space for one step. `retries` holds every call's
 * current MAX_RETRIES in this step (they share the step's env knobs); one R'
 * floor is applied to all of them (never lowering any).
 * @returns {{clearsFlags: object|null, recommended: object|null}}
 */
function searchStep({ retries, deadlineSec, fallbackOverride, fallbackDisabled, gitNetSec }) {
  const attemptSec = 2 * gitNetSec;
  const rMin = Math.max(...retries);
  const fOptions = fallbackDisabled ? [fallbackOverride] : [...new Set([fallbackOverride, 3])];
  const dOptions = [deadlineSec, ...DEADLINE_GRID.filter((d) => d > deadlineSec)];
  let clears = null;
  let rec = null;
  const better = (a, b) => !b
    || a.changed < b.changed
    || (a.changed === b.changed && (a.deadlineSec < b.deadlineSec
      || (a.deadlineSec === b.deadlineSec && a.maxRetries < b.maxRetries)));
  for (let r = rMin; r <= Math.max(rMin, MAX_RETRIES_CANDIDATE); r++) {
    for (const d of dOptions) {
      for (const f of fOptions) {
        const proposedRetries = retries.map((x) => Math.max(x, r));
        const flagsClear = proposedRetries.every((pr) => stepFlagsFor({
          maxRetries: pr, deadlineSec: d, fallbackAfter: f, fallbackDisabled,
        }).length === 0);
        if (!flagsClear) continue;
        const effF = audit.computeEffectiveFallbackAfter(r, f);
        const changed = (r !== rMin ? 1 : 0) + (d !== deadlineSec ? 1 : 0) + (f !== fallbackOverride ? 1 : 0);
        const cand = {
          maxRetries: r, retries: proposedRetries, deadlineSec: d,
          fallbackAfterOverride: f, effectiveFallbackAfter: effF, changed,
          fundableAtOwnTimeout: audit.computeFundableAttempts(r, d, attemptSec),
          fundableAtAuditDefault: audit.computeFundableAttempts(r, d),
        };
        if (better(cand, clears)) clears = cand;
        const margin = Math.max(effF + 1, MIN_RECOMMENDED_FUNDABLE);
        // Every call in the step must keep the margin, not just the smallest.
        const allMargin = proposedRetries.every((pr) => audit.computeFundableAttempts(pr, d, attemptSec) >= Math.min(margin, pr));
        if (allMargin && cand.fundableAtOwnTimeout >= margin && better(cand, rec)) rec = cand;
      }
    }
  }
  return { clearsFlags: clears, recommended: rec };
}

function lineIsCommentNear(lines, idx, span = 3) {
  for (let k = idx - 1; k >= Math.max(0, idx - span); k--) {
    const t = lines[k].trim();
    if (!t) continue;
    if (t.startsWith('#')) return true;
  }
  return false;
}

// The deadline env line inside a step's block (startIdx .. next sibling), or -1.
function deadlineLineIdx(lines, step) {
  for (let k = step.startIdx; k < lines.length; k++) {
    if (k > step.startIdx && /^\s*-\s/.test(lines[k]) && lines[k].search(/\S/) <= step.fieldIndent - 2) break;
    if (/^\s*PUSH_DEADLINE_SEC\s*:/.test(lines[k])) return k;
  }
  return -1;
}

/** Per-call shape details the audit's same-line regex cannot see. */
function callShapes(runText) {
  const lines = runText.split('\n');
  const shapes = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line.trim().startsWith('#')) continue;
    const re = /(?<=\/)push-with-retry\.sh/g;
    let m;
    while ((m = re.exec(line))) {
      const before = line.slice(0, m.index);
      const quoted = /=\s*["'][^"']*$/.test(before) || /(^|\s)["'][^"']*$/.test(before);
      const rest = line.slice(m.index);
      const continued = /\\\s*$/.test(rest) && k + 1 < lines.length && /\|\|\s*(echo|true)\b/.test(lines[k + 1]);
      shapes.push({ quoted, softFailContinuation: continued });
    }
  }
  return shapes;
}

function concurrencyNote(text) {
  if (!/^concurrency\s*:/m.test(text) && !/^\s{2,4}concurrency\s*:/m.test(text)) return 'no concurrency group: a long run can overlap the next cron run';
  return /cancel-in-progress\s*:\s*false/.test(text)
    ? 'cancel-in-progress: false — the next cron run queues and later queued runs are replaced'
    : 'cancel-in-progress: true — the next cron run cancels this one mid-push';
}

/**
 * Proposals for one workflow file. Rows align 1:1 with auditWorkflowText's
 * results (same job → step → call order).
 */
function proposeForWorkflow(text, file) {
  const results = audit.auditWorkflowText(text, file);
  const rawCount = audit.countRawCallSites(text);
  const underParsed = results.length < rawCount;
  const parsed = audit.parseWorkflow(text);
  const lines = text.split('\n');
  const cron = results.length ? results[0].cronIntervalMinutes : null;

  // Rebuild the same call enumeration auditWorkflowText walks.
  const entries = [];
  for (const job of parsed.jobs) {
    for (const step of job.steps) {
      const calls = audit.findPushRetryCalls(step.runText);
      const shapes = callShapes(step.runText);
      calls.forEach((call, i) => entries.push({ job, step, call, shape: shapes[i] || { quoted: false, softFailContinuation: false } }));
    }
  }
  if (entries.length !== results.length) {
    return results.map((r) => ({ ...baseRow(r), status: 'no-proposal', reason: 'internal: call enumeration did not match the audit' }));
  }

  // Step-level search, once per step.
  const stepPlans = new Map();
  for (const e of entries) {
    if (stepPlans.has(e.step)) continue;
    const stepCalls = entries.filter((x) => x.step === e.step).map((x) => x.call.maxRetries);
    const deadlineSec = e.step.envDeadlineSec ?? audit.DEFAULT_DEADLINE_SEC;
    const gitNetSec = e.step.envGitNetTimeoutSec ?? audit.GIT_NET_TIMEOUT_SEC;
    stepPlans.set(e.step, {
      deadlineSec, gitNetSec,
      ...searchStep({
        retries: stepCalls, deadlineSec,
        fallbackOverride: e.step.envFallbackAfterAttempts,
        fallbackDisabled: e.step.envFallbackDisabled === true,
        gitNetSec,
      }),
    });
  }

  // Job timeout needed under the recommended values of every push step in the job.
  const jobNeeds = new Map();
  for (const job of parsed.jobs) {
    const jobEntries = entries.filter((x) => x.job === job);
    if (!jobEntries.length) continue;
    const pushCalls = jobEntries.map((x) => {
      const plan = stepPlans.get(x.step);
      const pick = plan.recommended || plan.clearsFlags;
      const idx = jobEntries.filter((y) => y.step === x.step).indexOf(x);
      const r = pick ? pick.retries[idx] : x.call.maxRetries;
      const d = pick ? pick.deadlineSec : plan.deadlineSec;
      return { step: x.step, stepBudgetSec: Math.max(d, audit.computeBackoffSum(r)) };
    });
    let neededSec = 0;
    for (const pc of pushCalls) {
      const others = audit.computeOtherStepsBudgetSec(job.steps, pushCalls, pc);
      neededSec = Math.max(neededSec, (pc.stepBudgetSec + others) / (1 - audit.MARGIN_THRESHOLD));
    }
    const neededMin = Math.ceil(neededSec / 60 / 5) * 5;
    jobNeeds.set(job, { currentMin: job.timeoutMinutes, neededMin: Math.max(job.timeoutMinutes, neededMin) });
  }

  return entries.map((e, i) => {
    const r = results[i];
    const row = baseRow(r);
    const sizing = r.flags.filter((f) => SIZING_FLAGS.has(f));
    if (r.advisoryFlags.includes('job-timeout-margin-estimated-undersized')) {
      sizing.push('job-timeout-margin-estimated-undersized');
    }
    const plan = stepPlans.get(e.step);
    const job = jobNeeds.get(e.job);
    row.gitNetTimeoutSec = plan.gitNetSec;
    row.structural = r.flags.includes('mixed-safety-bundle')
      ? `split the step: ${r.mixedSafetyBundleDisqualifyingFiles.join(', ')} disqualifies the API fallback for ${r.mixedSafetyBundleSafeFiles.length} safe file(s) (BRO-2435 pattern)`
      : null;
    if (!sizing.length) return { ...row, status: row.structural ? 'structural-only' : 'clean' };
    const deliberate = [];
    if (underParsed) deliberate.push('file is under-parsed by the audit');
    if (r.softFail || e.shape.softFailContinuation) deliberate.push('soft-fail call (failing fast may be intended)');
    if (e.shape.quoted) deliberate.push('call inside a quoted string run by another script');
    const dIdx = deadlineLineIdx(lines, e.step);
    if (dIdx >= 0 && lineIsCommentNear(lines, dIdx)) deliberate.push('PUSH_DEADLINE_SEC carries a comment (deliberate choice)');
    if (deliberate.length) return { ...row, status: 'review-by-hand', reason: deliberate.join('; ') };
    const pick = plan.recommended;
    if (!pick) return { ...row, status: 'no-proposal', reason: 'no candidate within R<=40, D<=1800 keeps margin' };
    const idx = entries.filter((y) => y.step === e.step).indexOf(e);
    const cautions = [];
    if (plan.gitNetSec !== audit.GIT_NET_TIMEOUT_SEC) cautions.push(`step sets GIT_NET_TIMEOUT_SEC=${plan.gitNetSec}; the audit models ${audit.GIT_NET_TIMEOUT_SEC}s`);
    if (job.neededMin > job.currentMin) cautions.push(`raises job timeout-minutes ${job.currentMin}→${job.neededMin}`);
    if (job.neededMin > MAX_JOB_TIMEOUT_MIN) cautions.push(`needs ${job.neededMin} min, above GitHub's ${MAX_JOB_TIMEOUT_MIN}-min ceiling — split the job`);
    if (cron != null && job.neededMin > cron) cautions.push(`job may outlast its ${cron}-min cron (${concurrencyNote(text)})`);
    return {
      ...row,
      status: 'proposal',
      proposed: {
        maxRetries: pick.retries[idx],
        deadlineSec: pick.deadlineSec,
        fallbackAfterOverride: pick.fallbackAfterOverride,
        jobTimeoutMinutes: job.neededMin,
      },
      thresholdOnly: plan.clearsFlags ? {
        maxRetries: plan.clearsFlags.retries[idx], deadlineSec: plan.clearsFlags.deadlineSec,
        fallbackAfterOverride: plan.clearsFlags.fallbackAfterOverride,
      } : null,
      fundableAtOwnTimeout: pick.fundableAtOwnTimeout,
      flagsBefore: sizing,
      cautions,
    };
  });
}

function baseRow(r) {
  return {
    file: r.file, job: r.job, step: r.step,
    current: {
      maxRetries: r.maxRetries, deadlineSec: r.deadlineSec,
      fallbackAfter: r.fallbackAfterAttempts, jobTimeoutMinutes: r.jobTimeoutSec / 60,
    },
    flags: r.flags, contentionScore: r.contentionScore, cronIntervalMinutes: r.cronIntervalMinutes,
  };
}

/**
 * Re-audit proof: does applying `proposed` to every proposal row of a file
 * clear its sizing flags under the audit's own evaluateStep? Pure.
 */
function verifyProposal(row) {
  if (row.status !== 'proposal') return null;
  const ev = audit.evaluateStep({
    maxRetries: row.proposed.maxRetries,
    deadlineSec: row.proposed.deadlineSec,
    jobTimeoutMinutes: HUGE_JOB_TIMEOUT_MIN,
    fallbackAfterAttemptsOverride: row.proposed.fallbackAfterOverride,
  });
  return ev.flags.filter((f) => STEP_FLAGS.includes(f));
}

module.exports = {
  SIZING_FLAGS,
  MIN_RECOMMENDED_FUNDABLE,
  searchStep,
  callShapes,
  proposeForWorkflow,
  verifyProposal,
  concurrencyNote,
};
