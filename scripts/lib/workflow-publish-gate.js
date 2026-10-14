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
 * WHY THIS FILE EXISTS — read before weakening anything in it. This guard has
 * been defeated by adversarial reviewers FIVE times. Each round went one
 * level further out than the last:
 *
 *   1. The barrier's whole body replaced with an `echo`.
 *   2. `|| true` appended to the push line.
 *   3. Five defeats of the denylist that round 2 produced — `|| echo "..."`,
 *      `|| true  # comment`, `|| exit 0`, `&`, `set +ex` — plus a decoy step
 *      that satisfied the publishing predicate with only a COMMENT.
 *   4. Four that went AROUND the push line: swallow the `git commit` failure
 *      instead; `!cancelled()` instead of `always()`; a sibling job gated
 *      `!cancelled()`; a reusable-workflow job with no `steps`.
 *   5. Nine more, every one of which made the guard fail OPEN:
 *      - `|| true` on the CLOSING line of a multi-line commit message, which
 *        a line-scoped scan never attributes to the `git commit`.
 *      - `git -C . commit` (any pre-subcommand global option) evading a
 *        `\bgit\s+(?:commit|push)\b` matcher.
 *      - `echo "deploying" && gh workflow run ...` — dropping the whole line
 *        because its FIRST token was `echo` hid a real dispatch.
 *      - `actions/github-script` + `createWorkflowDispatch(...)` and
 *        `gh api --method PUT .../contents/...`, the two idioms this repo
 *        actually uses to publish, recognised by nothing.
 *      - `Always()`: GitHub expression functions are case-INSENSITIVE, these
 *        regexes were not, so a capitalised publisher read as fail-closed.
 *      - `shell: bash {0}`, a custom template that drops the default `-e`.
 *      - `!(steps.x.outcome == 'success')` — a condition that runs the
 *        publisher only when the barrier FAILED — accepted as correct gating.
 *      - `exit 0 # comment` and `exit 0;` escaping an anchored matcher.
 *
 * THE STANDING LESSON: every single defeat came from a predicate that matched
 * YAML or shell TEXT instead of modelling what GitHub Actions and bash will
 * actually DO. When you extend this file, ask "what runs?", not "what does the
 * source say?". Prefer an ALLOWLIST of the one correct form over a denylist of
 * ways to break it — a denylist of idioms can always be extended by one more.
 */

/** Shell operators that can stop a failing command from failing its step. */
const SWALLOWING_OPERATORS = /\|\||&&|;|\||(?:^|[^&])&(?:[^&]|$)/;

/**
 * Split a `run:` body into LOGICAL lines: newlines inside a quoted string do
 * not end a line, and a trailing backslash continues one.
 *
 * This is load-bearing. commercial-weekly's commit message opens a double
 * quote that closes three lines later; with a naive per-physical-line scan the
 * `|| true` an attacker appends lands on the message's CLOSING line, which
 * contains no `git commit` and so is never inspected. Joining the logical line
 * puts the operator back next to the command it neuters.
 */
function logicalLines(run) {
  const src = String(run || '');
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        cur += ch + (src[i + 1] || '');
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\\' && src[i + 1] === '\n') {
      i += 1;
      cur += ' ';
      continue;
    }
    if (ch === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
}

/** Physical, comment-stripped lines. Kept for callers that want raw shape. */
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
 * Remove quoted spans so an operator or token search sees only real shell
 * syntax. A commit message legitimately contains `;` and `|`.
 *
 * Replace with a SPACE, never with `""`/`''` — a quote-shaped placeholder is
 * itself found by the unmatched-quote truncation below, which then cuts the
 * line at the placeholder and hides every operator after it.
 */
function stripQuoted(line) {
  let out = String(line);
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, ' ');
  const dq = out.indexOf('"');
  const sq = out.indexOf("'");
  const cut = [dq, sq].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return cut === undefined ? out : out.slice(0, cut);
}

/** Strip a trailing `# comment` and any trailing `;` from an unquoted line. */
function bareCommand(line) {
  return stripQuoted(line).replace(/#.*$/, '').replace(/;+\s*$/, '').trim();
}

/**
 * Does this logical line INVOKE a publisher?
 *
 * Tokens are looked for OUTSIDE quotes, which is what distinguishes
 * `echo "deploying" && gh workflow run x.yml` (a real dispatch) from
 * `echo "next step will gh workflow run x.yml"` (a decoy planted purely to
 * satisfy a vacuity counter). An earlier version dropped any line whose first
 * token was `echo`, which correctly killed the decoy and incorrectly hid the
 * real one.
 *
 * `gh api` URLs are usually quoted, so the VERB is required outside quotes
 * while the path may be found anywhere on the line.
 */
function publishesOnLine(line) {
  const bare = stripQuoted(line);
  if (bare.includes('push-with-retry.sh')) return true;
  if (/\bgh\s+workflow\s+run\b/.test(bare)) return true;
  if (/\bgh\s+api\b/.test(bare)) {
    if (/\/dispatches\b/.test(line)) return true;
    if (/--method\s+(?:PUT|POST)/i.test(bare) && /\/contents\//.test(line)) return true;
  }
  // actions/github-script bodies and inline node: the REST calls this repo
  // uses to dispatch a workflow or write a file into another repo.
  if (/\bcreateWorkflowDispatch\b|\bcreateOrUpdateFileContents\b/.test(line)) return true;
  return false;
}

/**
 * Steps that publish data outside the runner, and must never run unguarded.
 */
function isPublishingStep(step) {
  const uses = String((step && step.uses) || '');
  if (uses.includes('push-core-data')) return true;
  if (uses.includes('dispatch-deploy')) return true;
  if (uses.includes('push-aggregator-archive')) return true;

  // `actions/github-script` carries its payload in `with.script`, not `run`.
  const withText = JSON.stringify((step && step.with) || {});
  if (/\bcreateWorkflowDispatch\b|\bcreateOrUpdateFileContents\b/.test(withText)) return true;

  return logicalLines(step && step.run).some(publishesOnLine);
}

/**
 * Will GitHub still run this step (or job) after an EARLIER failure?
 *
 * A reachability question, not a text question. No `if:` means `success()`,
 * which fails closed. Everything else naming a status check function can
 * survive an earlier failure. GitHub expression functions are
 * case-INSENSITIVE, so `Always()` must count exactly as `always()` does — a
 * case-sensitive matcher reported a capitalised publisher as fail-closed and
 * every rule then skipped it.
 */
function isAlwaysReachable(stepOrJob) {
  const cond = String((stepOrJob && stepOrJob.if) || '').trim();
  if (!cond) return false; // no if: === success() === fails closed
  const inner = cond.replace(/^\$\{\{/, '').replace(/\}\}$/, '').trim();
  if (/\balways\s*\(\s*\)/i.test(inner)) return true;
  if (/\bcancelled\s*\(\s*\)/i.test(inner)) return true; // covers !cancelled()
  if (/\bfailure\s*\(\s*\)/i.test(inner)) return true; // covers !failure()
  return false;
}

/**
 * Does `cond` REQUIRE `steps.<id>.outcome` to be exactly 'success'?
 *
 * `!= 'failure'` is TRUE when the step is skipped or cancelled. An `||`
 * re-opens the hole while keeping a substring check green. And a NEGATED
 * comparison — `!(steps.x.outcome == 'success')` — runs the publisher only
 * when the barrier failed, which a naive "contains the right comparison"
 * check happily accepted.
 *
 * `.outcome` and not `.conclusion`: `continue-on-error` rewrites `conclusion`
 * to 'success' while leaving `outcome` at 'failure'.
 */
function requiresOutcomeSuccess(cond, id) {
  const text = String(cond || '');
  if (/\|\|/.test(text)) return false;
  if (/!=/.test(text)) return false;
  if (/!\s*\(/.test(text)) return false; // negated group
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`steps\\.${esc}\\.outcome\\s*==\\s*'success'`, 'i').test(text);
}

/**
 * Does a JOB require `upstreamJobName` to have succeeded before it runs?
 *
 * Resolved TRANSITIVELY through the `needs` graph: a job that needs a job
 * that needs the upstream does fail closed on GitHub, and reporting it as an
 * offender is a false positive that would block a legitimate refactor.
 */
function requiresUpstreamSuccess(job, upstreamJobName, jobs, seen) {
  if (!job) return false;
  const jobIf = String(job.if || '');
  const esc = String(upstreamJobName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`needs\\.${esc}\\.result\\s*==\\s*'success'`, 'i').test(jobIf)) return true;

  // Implicit gating: a job with `needs:` runs only on upstream success UNLESS
  // its own `if` carries a status function that overrides that. "Lacks
  // always()" is NOT the test — `!cancelled()` overrides it too.
  if (isAlwaysReachable(job)) return false;

  const needs = [].concat(job.needs || []);
  if (needs.includes(upstreamJobName)) return true;
  if (!jobs) return false;

  const visited = seen || new Set();
  return needs.some((n) => {
    if (visited.has(n)) return false;
    visited.add(n);
    return requiresUpstreamSuccess(jobs[n], upstreamJobName, jobs, visited);
  });
}

/**
 * Does this JOB publish outside the runner? A job-level `uses:` (reusable
 * workflow) has NO `steps`, so a step-walking predicate is blind to it —
 * treat it as an opaque publisher.
 */
function jobPublishes(job) {
  if (job && job.uses) return true;
  return ((job && job.steps) || []).some(isPublishingStep);
}

/**
 * The one shell form the push line is allowed to take.
 *
 * Args restricted to what scripts/lib/push-with-retry.sh actually takes,
 * `[max_retries] [branch]`. A permissive arg pattern admitted
 * `push-with-retry.sh 0` (zero retries) and `... 7 HEAD:refs/heads/junk`
 * (push to a scratch ref), both of which exit 0 while publishing nothing.
 */
const ALLOWED_PUSH_LINE = /^bash scripts\/lib\/push-with-retry\.sh(?: [1-9][0-9]?)?(?: main)?$/;

/**
 * Is this logical line a git commit or push?
 *
 * Matched as "a `git` command whose subcommand is commit/push", allowing
 * pre-subcommand global options. `\bgit\s+(?:commit|push)\b` required the
 * subcommand to follow `git` directly, so `git -C . commit -m "x" || echo`
 * sailed past the rule written to catch exactly that swallow.
 */
function isGitCommitOrPush(line) {
  const bare = bareCommand(line);
  return /(^|[|&;(]\s*)git\b[^|&;]*?\b(?:commit|push)\b/.test(bare);
}

/** Lines whose failure MUST fail the step for the barrier downstream to mean anything. */
function criticalLines(step) {
  return logicalLines(step && step.run).filter(
    (l) => stripQuoted(l).includes('push-with-retry.sh') || isGitCommitOrPush(l),
  );
}

/**
 * Every way the named step's body could swallow its own failure.
 * Returns human-readable offences; empty means the body is strict.
 */
function failureSwallowOffenders(step) {
  const lines = logicalLines(step && step.run);
  const offenders = [];
  const critical = criticalLines(step);

  if (critical.length === 0) {
    // Caller asserts non-vacuity separately; nothing to judge here.
    return offenders;
  }

  // A custom `shell:` template drops bash's default `-e`, so a failed commit
  // no longer aborts the script and the push runs with nothing staged,
  // exiting 0. One added YAML line, whole bug restored.
  const shell = String((step && step.shell) || '');
  if (shell && shell.includes('{0}') && !/(?:^|\s)-\w*e/.test(shell)) {
    offenders.push(
      `shell: ${shell} is a custom template without errexit (-e), so a failed commit does not ` +
        'abort the step and its outcome stays success',
    );
  }

  for (const line of critical) {
    const trimmed = line.trim();
    if (stripQuoted(trimmed).includes('push-with-retry.sh')) {
      if (!ALLOWED_PUSH_LINE.test(bareCommand(trimmed))) {
        offenders.push(
          'the push invocation must be exactly "bash scripts/lib/push-with-retry.sh" (optionally ' +
            'a retry count 1-99 and the branch "main") with no "||", "&&", ";", pipe, "&", ' +
            'if/then wrapper or trailing comment — anything else can make a failed push exit 0, ' +
            `which leaves the step outcome 'success' and unblocks every publisher below.\n    ${trimmed}`,
        );
      }
      continue;
    }
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
  // Compared on the BARE command so `exit 0 # always clean` and `exit 0;`
  // cannot slip past an anchored matcher.
  const firstCritical = lines.findIndex((l) => critical.includes(l));
  lines.forEach((line, i) => {
    if (i >= firstCritical && /^exit\s+0$/.test(bareCommand(line))) {
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
 * Lines that actually invoke the push (comments and quoted mentions
 * excluded). Callers use this as the vacuity guard: an empty set means the
 * body no longer pushes at all, which must fail loudly rather than pass
 * silently.
 */
function pushInvocationLines(step) {
  return logicalLines(step && step.run).filter((l) =>
    stripQuoted(l).includes('push-with-retry.sh'),
  );
}

module.exports = {
  ALLOWED_PUSH_LINE,
  bareCommand,
  bodyLines,
  criticalLines,
  failureSwallowOffenders,
  isAlwaysReachable,
  isGitCommitOrPush,
  isPublishingStep,
  jobPublishes,
  logicalLines,
  publishesOnLine,
  pushInvocationLines,
  requiresOutcomeSuccess,
  requiresUpstreamSuccess,
  strippedRun,
  stripQuoted,
};
