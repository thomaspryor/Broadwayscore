'use strict';

/**
 * Shared predicates for the publish-barrier guards (BRO-2907 / BRO-2912 /
 * BRO-2913).
 *
 * Two workflows carry the same fail-closed shape: a barrier step whose
 * outcome every publishing step keys off, plus a public commit step whose
 * outcome the publishers downstream of it ALSO key off. The guards live in
 * tests/unit/commercial-publish-gate.test.mjs and
 * tests/unit/update-show-status-publish-gate.test.mjs; the predicates they
 * both depend on live here, per CLAUDE.md rule 15, so that hardening one
 * hardens the other.
 *
 * WHY THIS FILE EXISTS AT ALL — read before weakening anything in it.
 * This guard has now been defeated by adversarial reviewers FOUR separate
 * times, and each round taught the same lesson one level further out.
 *
 *   Round 1: the barrier's whole body was replaced with an `echo`. Every
 *            `if:`-based assertion stayed green.
 *   Round 2: `|| true` appended to the push line. The step exits 0, its
 *            outcome stays 'success', both publishers run.
 *   Round 3: five more one-line defeats of the DENYLIST that round 2
 *            produced — `|| echo "..."` (this repo's own house style),
 *            `|| true  # comment` (the trailing comment beats a `$` anchor),
 *            `|| exit 0`, backgrounding with `&`, and `set +ex` slipping past
 *            an anchored `set +e`. Plus a decoy step that satisfied the
 *            publishing predicate with nothing but a COMMENT mentioning
 *            push-with-retry.sh.
 *   Round 4: four defeats that all went AROUND the push line rather than
 *            through it — swallow the `git commit` failure instead of the
 *            push (the allowlist only policed push lines); use `!cancelled()`
 *            instead of `always()` (the reachability test was a literal
 *            string match, so the gated tests simply skipped the step); a
 *            sibling job gated `!cancelled()` (the cross-job rule read
 *            "lacks always()" as "fails closed"); and a reusable-workflow job
 *            whose job-level `uses:` means it has NO `steps` for a
 *            step-walking predicate to see.
 *
 * THE STANDING LESSON: every defeat came from a predicate that was a STRING
 * MATCHER over YAML text rather than a model of what GitHub Actions will
 * actually RUN. When you extend this file, ask "what does GitHub do?", not
 * "what does the YAML say?". And when you add a rule, prefer an ALLOWLIST of
 * the one correct form over a denylist of ways to break it: a denylist of
 * shell idioms can always be extended by one more idiom.
 */

/** Shell operators that can stop a failing command from failing its step. */
const SWALLOWING_OPERATORS = /\|\||&&|;|\||(?:^|[^&])&(?:[^&]|$)/;

/**
 * Remove quoted spans so an operator search sees only real shell syntax.
 *
 * A commit message legitimately contains `;` and `|`, and in
 * commercial-weekly.yml the message OPENS a double quote that closes several
 * lines later. Balanced spans are removed; a trailing unmatched quote
 * truncates the line, which is the correct reading for a multi-line message.
 */
function stripQuoted(line) {
  let out = String(line);
  // Replace with a SPACE, never with `""`/`''` — a quote-shaped placeholder
  // is itself found by the unmatched-quote truncation below, which then cuts
  // the line at the placeholder and hides every operator after it. That bug
  // let `git commit -m "..." || echo "..."` through a probe that was
  // otherwise correct.
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, ' ');
  const dq = out.indexOf('"');
  const sq = out.indexOf("'");
  const cut = [dq, sq].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return cut === undefined ? out : out.slice(0, cut);
}

/**
 * Body lines with comments and blanks removed.
 *
 * Comment-stripping is load-bearing, not tidiness. A reviewer moved
 * `id: commit-public` onto an unrelated step and dropped
 * `# see scripts/lib/push-with-retry.sh` into its body; that bare comment
 * satisfied the publishing predicate and the vacuity guard at once.
 */
function bodyLines(step) {
  return String((step && step.run) || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
}

/** The step's `run` body with comment lines removed. */
function strippedRun(step) {
  return bodyLines(step).join('\n');
}

/**
 * Body lines that could actually INVOKE something, excluding lines whose
 * command is `echo`/`printf`. A reviewer padded a decoy step with
 * `run: echo "next step will gh workflow run vercel-deploy.yml"` purely to
 * satisfy a vacuity counter — the token was real, the invocation was not.
 */
function invocationLines(step) {
  return bodyLines(step).filter((l) => !/^\s*(?:echo|printf)\b/.test(l));
}

/**
 * Steps that publish data outside the runner, and must never run unguarded.
 *
 * The `run:` forms matter as much as the `uses:` ones. update-show-status.yml
 * dispatches its deploy with `run: gh workflow run vercel-deploy.yml`, not
 * with `uses: ./.github/actions/dispatch-deploy` — a uses-only predicate does
 * not see it at all.
 */
function isPublishingStep(step) {
  const uses = String((step && step.uses) || '');
  if (uses.includes('push-core-data')) return true;
  if (uses.includes('dispatch-deploy')) return true;
  if (uses.includes('push-aggregator-archive')) return true;

  const body = invocationLines(step).join('\n');
  if (body.includes('push-with-retry.sh')) return true;
  if (/\bgh workflow run\b/.test(body)) return true;
  if (/\bgh api\b[^\n]*\/dispatches\b/.test(body)) return true;
  return false;
}

/**
 * Will GitHub still run this step (or job) after an EARLIER failure?
 *
 * This is a reachability question, not a text question. A step with no `if:`
 * defaults to `if: success()` and fails closed. Everything else that
 * mentions a status check function can survive an earlier failure:
 * `always()`, `!cancelled()`, `!failure()`, `success() || failure()`, and a
 * bare `failure()`/`cancelled()` all keep running where plain `success()`
 * would not.
 *
 * The previous version tested `String(step.if).includes('always()')`, so a
 * reviewer swapped in `!cancelled()` and every downstream rule simply SKIPPED
 * the step — reading as safe while the publisher ran unguarded.
 */
function isAlwaysReachable(stepOrJob) {
  const cond = String((stepOrJob && stepOrJob.if) || '').trim();
  if (!cond) return false; // no if: === success() === fails closed
  const inner = cond.replace(/^\$\{\{/, '').replace(/\}\}$/, '').trim();
  if (/\balways\s*\(\s*\)/.test(inner)) return true;
  if (/\bcancelled\s*\(\s*\)/.test(inner)) return true; // covers !cancelled()
  if (/\bfailure\s*\(\s*\)/.test(inner)) return true; // covers !failure()
  return false;
}

/**
 * Does `cond` REQUIRE `steps.<id>.outcome` to be exactly 'success'?
 *
 * `!= 'failure'` is TRUE when the step is skipped or cancelled — the
 * reads-as-safe-while-nothing-ran shape the barrier exists to prevent — and
 * an `||` anywhere in the condition re-opens the hole while keeping a
 * substring check green.
 *
 * `.outcome` and not `.conclusion`: `continue-on-error` rewrites
 * `conclusion` to 'success' while leaving `outcome` at 'failure', so gating
 * on conclusion would be satisfied by the very thing it must catch.
 */
function requiresOutcomeSuccess(cond, id) {
  const text = String(cond || '');
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`steps\\.${esc}\\.outcome\\s*==\\s*'success'`);
  return re.test(text) && !/\|\|/.test(text) && !/!=/.test(text);
}

/** Does a JOB require its upstream job to have succeeded before it runs? */
function requiresUpstreamSuccess(job, upstreamJobName) {
  const jobIf = String((job && job.if) || '');
  const esc = String(upstreamJobName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`needs\\.${esc}\\.result\\s*==\\s*'success'`).test(jobIf)) return true;
  // Implicit gating: a job with `needs:` runs only on upstream success UNLESS
  // its own `if` carries a status function that overrides that. "Lacks
  // always()" is NOT the test — `!cancelled()` also overrides it.
  const needs = [].concat((job && job.needs) || []);
  return needs.includes(upstreamJobName) && !isAlwaysReachable(job);
}

/**
 * Does this JOB publish outside the runner? A job-level `uses:` (reusable
 * workflow) has NO `steps`, so a step-walking predicate is blind to it —
 * treat it as an opaque publisher and hold it to the same rule.
 */
function jobPublishes(job) {
  if (job && job.uses) return true;
  return ((job && job.steps) || []).some(isPublishingStep);
}

/**
 * The one shell form the push line is allowed to take.
 *
 * Args are restricted to what scripts/lib/push-with-retry.sh actually takes
 * — `[max_retries] [branch]`, defaults 7 and main. The previous permissive
 * `[\w./=@:-]+` arg pattern admitted `push-with-retry.sh 0` (zero retries)
 * and `push-with-retry.sh 7 HEAD:refs/heads/junk` (push to a scratch ref),
 * both of which exit 0 while publishing nothing.
 */
const ALLOWED_PUSH_LINE = /^bash scripts\/lib\/push-with-retry\.sh(?: [1-9][0-9]?)?(?: main)?$/;

/** Lines whose failure MUST fail the step for the barrier downstream to mean anything. */
function criticalLines(step) {
  return invocationLines(step).filter(
    (l) => l.includes('push-with-retry.sh') || /\bgit\s+(?:commit|push)\b/.test(l),
  );
}

/**
 * Every way the named step's body could swallow its own failure.
 * Returns human-readable offences; empty means the body is strict.
 */
function failureSwallowOffenders(step) {
  const lines = bodyLines(step);
  const offenders = [];

  const critical = criticalLines(step);
  if (critical.length === 0) {
    // Caller asserts non-vacuity separately; nothing to judge here.
    return offenders;
  }

  for (const line of critical) {
    const trimmed = line.trim();
    if (trimmed.includes('push-with-retry.sh')) {
      if (!ALLOWED_PUSH_LINE.test(trimmed)) {
        offenders.push(
          'the push invocation must be exactly "bash scripts/lib/push-with-retry.sh" (optionally ' +
            'a retry count 1-99 and the branch "main") with no "||", "&&", ";", pipe, "&", ' +
            'if/then wrapper or trailing comment — anything else can make a failed push exit 0, ' +
            `which leaves the step outcome 'success' and unblocks every publisher below.\n    ${trimmed}`,
        );
      }
      continue;
    }
    // git commit / git push: the failure the publishers below key off is not
    // only the PUSH's. A reviewer restored the whole bug by appending
    // `|| echo "::warning::commit failed"` to the commit line, which the
    // push-only allowlist never looked at.
    if (SWALLOWING_OPERATORS.test(stripQuoted(trimmed))) {
      offenders.push(
        'a git commit/push line must not be chained with "||", "&&", ";", a pipe or "&" — that ' +
          `makes a failed commit exit 0, so the step outcome stays 'success' and every publisher ` +
          `below runs on a commit that never landed.\n    ${trimmed}`,
      );
    }
  }

  for (const line of lines) {
    if (/^\s*set\s+\+/.test(line)) {
      offenders.push(
        `"set +..." disables errexit, so a failure stops setting the step outcome to ` +
          `failure.\n    ${line.trim()}`,
      );
    }
    if (/^\s*trap\s/.test(line)) {
      offenders.push(`a "trap" can rewrite the step's exit status.\n    ${line.trim()}`);
    }
  }

  // An `exit 0` BEFORE the first critical line is the legitimate "nothing to
  // commit" early return. One at or after it forces a zero exit regardless.
  const firstCritical = lines.findIndex((l) => critical.includes(l));
  lines.forEach((line, i) => {
    if (i >= firstCritical && /^\s*exit\s+0\s*$/.test(line)) {
      offenders.push(
        `"exit 0" at or after the commit/push forces a zero exit even when it ` +
          `failed.\n    ${line.trim()}`,
      );
    }
  });

  if (step && step['continue-on-error'] === true) {
    offenders.push(
      "continue-on-error: true — the step's failure is the signal the publishers below depend on",
    );
  }

  return offenders;
}

/**
 * Lines that actually invoke the push (comments and `echo` excluded). Callers
 * use this as the vacuity guard: an empty set means the body no longer pushes
 * at all, which must fail loudly rather than pass silently.
 */
function pushInvocationLines(step) {
  return invocationLines(step).filter((l) => l.includes('push-with-retry.sh'));
}

module.exports = {
  ALLOWED_PUSH_LINE,
  bodyLines,
  criticalLines,
  failureSwallowOffenders,
  invocationLines,
  isAlwaysReachable,
  isPublishingStep,
  jobPublishes,
  pushInvocationLines,
  requiresOutcomeSuccess,
  requiresUpstreamSuccess,
  strippedRun,
  stripQuoted,
};
