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
 * The first version of these predicates lived inline in the commercial test
 * and a reviewer defeated it in one line: appending `|| true` to the
 * push-with-retry.sh call inside the gated step. The step exits 0, its
 * outcome stays 'success', both publishers run, and the entire bug is
 * restored with every assertion green — because the assertions read `if:`,
 * `id` and `uses` and never the step's `run` body.
 *
 * Fixing that with a denylist (`/\|\|\s*(true|:)\s*$/`) was not enough
 * either. A second adversarial pass found five more one-line defeats of the
 * denylist form, ALL of them re-verified against the real files:
 *
 *   bash scripts/lib/push-with-retry.sh || echo "::warning::push failed"
 *   bash scripts/lib/push-with-retry.sh || true  # retry next run
 *   bash scripts/lib/push-with-retry.sh || exit 0
 *   bash scripts/lib/push-with-retry.sh &
 *   set +ex            (the anchored /^\s*set \+e\s*$/m denylist misses this)
 *
 * `|| echo` is not hypothetical here: update-show-status.yml's own deploy
 * dispatch already ships as `gh workflow run vercel-deploy.yml || echo "..."`,
 * so the defeat reads as house style in review.
 *
 * The rule that follows: for the push line, ALLOWLIST the exact invocation
 * rather than denylisting the ways to neuter it. A denylist of shell idioms
 * can always be extended by one more idiom; an allowlist cannot.
 */

/**
 * Body lines with comments and blanks removed.
 *
 * Comment-stripping is load-bearing, not tidiness. isPublishingStep() and the
 * push-line vacuity guard both test whether a body MENTIONS
 * push-with-retry.sh. A reviewer showed that a bare comment satisfies that:
 * move `id: commit-public` onto an unrelated always()-gated step, drop
 * `# see scripts/lib/push-with-retry.sh` into its body, and the id check, the
 * vacuity guard and the ordering rule all pass while the real commit gates
 * nothing.
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
 * Steps that publish data outside the runner, and must never run unguarded.
 *
 * The `run:` forms matter as much as the `uses:` ones. update-show-status.yml
 * dispatches its deploy with `run: gh workflow run vercel-deploy.yml`, not
 * with `uses: ./.github/actions/dispatch-deploy` — a uses-only predicate does
 * not see it at all, so reverting that step's `if:` would restore the hole
 * with every assertion green.
 */
function isPublishingStep(step) {
  const uses = String((step && step.uses) || '');
  const run = strippedRun(step);
  if (uses.includes('push-core-data')) return true;
  if (uses.includes('dispatch-deploy')) return true;
  if (uses.includes('push-aggregator-archive')) return true;
  if (run.includes('push-with-retry.sh')) return true;
  if (/\bgh workflow run\b/.test(run)) return true;
  if (/\bgh api\b[^\n]*\/dispatches\b/.test(run)) return true;
  return false;
}

/** A step GitHub will run even after an earlier failure in the job. */
function isAlwaysReachable(step) {
  return String((step && step.if) || '').includes('always()');
}

/**
 * Does `cond` REQUIRE `steps.<id>.outcome` to be exactly 'success'?
 *
 * `!= 'failure'` is TRUE when the step is skipped or cancelled — the
 * reads-as-safe-while-nothing-ran shape the barrier exists to prevent — and
 * an `||` anywhere in the condition re-opens the hole while keeping a
 * substring check green.
 */
function requiresOutcomeSuccess(cond, id) {
  const text = String(cond || '');
  const re = new RegExp(`steps\\.${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.outcome\\s*==\\s*'success'`);
  return re.test(text) && !/\|\|/.test(text) && !/!=/.test(text);
}

/**
 * The one shell form the push line is allowed to take.
 * Anything else — `||`, `&&`, `;`, a pipe, backgrounding, an `if`/`then`
 * wrapper, a trailing comment — is rejected.
 */
const ALLOWED_PUSH_LINE = /^bash scripts\/lib\/push-with-retry\.sh(?:\s+[\w./=@:-]+)*$/;

/**
 * Every way the named step's body could swallow its own push failure.
 * Returns a list of human-readable offences; empty means the body is strict.
 */
function failureSwallowOffenders(step) {
  const lines = bodyLines(step);
  const offenders = [];

  const pushIdx = lines.findIndex((l) => l.includes('push-with-retry.sh'));
  if (pushIdx === -1) {
    // Caller asserts non-vacuity separately; nothing to judge here.
    return offenders;
  }

  for (const line of lines) {
    if (!line.includes('push-with-retry.sh')) continue;
    if (!ALLOWED_PUSH_LINE.test(line.trim())) {
      offenders.push(
        `the push invocation must be exactly "bash scripts/lib/push-with-retry.sh" with no ` +
          `"||", "&&", ";", pipe, "&", if/then wrapper or trailing comment — anything else can ` +
          `make a failed push exit 0, which leaves the step outcome 'success' and unblocks every ` +
          `publisher below.\n    ${line.trim()}`,
      );
    }
  }

  for (const line of lines) {
    if (/^\s*set\s+\+/.test(line)) {
      offenders.push(
        `"set +..." disables errexit, so a failed push stops setting the step outcome to ` +
          `failure.\n    ${line.trim()}`,
      );
    }
    if (/^\s*trap\s/.test(line)) {
      offenders.push(
        `a "trap" can rewrite the step's exit status after the push fails.\n    ${line.trim()}`,
      );
    }
  }

  // An `exit 0` BEFORE the push is the legitimate "nothing to commit" early
  // return. One at or after the push line forces a zero exit regardless of
  // whether the push succeeded.
  lines.forEach((line, i) => {
    if (i >= pushIdx && /^\s*exit\s+0\s*$/.test(line)) {
      offenders.push(
        `"exit 0" at or after the push line forces a zero exit even when the push ` +
          `failed.\n    ${line.trim()}`,
      );
    }
  });

  if (step && step['continue-on-error'] === true) {
    offenders.push(
      'continue-on-error: true — the step\'s failure is the signal the publishers below depend on',
    );
  }

  return offenders;
}

/**
 * Lines that actually invoke the push (comments excluded). Callers use this
 * as the vacuity guard: an empty set means the body no longer pushes at all,
 * which must fail loudly rather than pass silently.
 */
function pushInvocationLines(step) {
  return bodyLines(step).filter((l) => l.includes('push-with-retry.sh'));
}

module.exports = {
  ALLOWED_PUSH_LINE,
  bodyLines,
  failureSwallowOffenders,
  isAlwaysReachable,
  isPublishingStep,
  pushInvocationLines,
  requiresOutcomeSuccess,
  strippedRun,
};
