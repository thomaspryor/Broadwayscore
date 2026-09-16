/**
 * Lint check: any GitHub Actions job that calls routeAlert()/resolveCondition()
 * (scripts/lib/owner-alert-router.js) must also stage data/audit/alert-ledger.json
 * for commit in the SAME job — the ledger only exists on that job's ephemeral
 * runner disk, so a commit in a different job (or no commit at all) silently
 * resets the cooldown/dedup state every run (card #618, 5th recurrence of the
 * class first found in #394/#608/#610: audit-aggregator-gap.yml,
 * test-ugc-roundtrip.yml, ux-walkthrough.yml, check-cron-health.yml).
 *
 * Also checks the sibling file: a job using disposition:'digest' must stage
 * data/audit/alert-digest-queue.json too — queueDigestLine() writes it
 * separately from the ledger. Found broken live in update-mezzanine.yml
 * during this card's own /what-else pass (fixed same session).
 *
 * Deliberately text/regex-based (no YAML parser dependency), matching the
 * style of the other checks in lint-workflow-guards.sh — jobs are split on
 * the repo's consistent 2-space job-key indent under `jobs:`.
 *
 * KNOWN LIMITATION — subprocess-indirect callers: ROUTE_ALERT_CALL_RE only
 * sees text literally present in the workflow YAML. A job that calls an
 * external script (`node scripts/foo.js`) which itself requires
 * owner-alert-router.js is invisible to this check UNLESS the YAML happens
 * to mention "routeAlert(" or "resolveCondition(" somewhere (e.g. an
 * explanatory comment).
 *
 * CORRECTION (BRO-3662): this paragraph used to say a `# routeAlert(...)`
 * COMMENT was enough to keep such a job in coverage, and named
 * scrape-new-aggregators.yml as surviving that way. That stopped being true at
 * BRO-3051, which made findMissingLedgerCommits() strip comment lines before
 * call detection — a comment now buys NOTHING. scrape-new-aggregators.yml is
 * in fact covered by its non-comment `require('./scripts/lib/owner-alert-
 * router.js')` at :226; process-feedback.yml, which relied on the comment,
 * had silently dropped OUT of coverage until BRO-3662 gave it a real
 * (non-comment) breadcrumb. audit-aggregator-gap.yml is still uncovered for
 * exactly this reason: all six of its routeAlert mentions are `#` comments.
 * So the breadcrumb must be a REAL line (an `echo`, or the `require` itself),
 * never a comment.
 *
 * The blind spot is WIDE, not anecdotal: ~20 workflows invoke a script that
 * (transitively) requires owner-alert-router.js while their YAML contains no
 * literal call, so this checker cannot see them at all. Closing it properly
 * means resolving the require-graph one hop — tracked in BRO-3671.
 */

const JOB_KEY_RE = /^  ([A-Za-z0-9_.-]+):\s*$/;
const ROUTE_ALERT_CALL_RE = /\b(routeAlert|resolveCondition)\s*\(/;
const DIGEST_DISPOSITION_RE = /disposition:\s*'digest'/;
const LEDGER_FILE = 'alert-ledger.json';
const DIGEST_QUEUE_FILE = 'alert-digest-queue.json';
// BRO-3662: logDispatchAttempt() (owner-alert-router.js:344) REWRITES this
// tracked file on every card-dispatch attempt, success or failure. A job that
// calls routeAlert() but never stages it ends the run with a modified tracked
// file sitting unstaged in the worktree — and an unstaged tracked modification
// makes a rebase refuse OUTRIGHT ("cannot rebase: You have unstaged changes")
// before it starts. push-with-retry.sh mislabels that refusal as a conflict
// and falls through to `merge -X ours`, the path that resolves conflicting
// hunks in OUR favour and can silently discard a concurrent writer's changes.
// Observed live on process-feedback.yml run 34852355418: all 10 retry attempts
// took the merge path with ZERO conflicted files.
//
// Gated on the same trigger as the ledger (any routeAlert/resolveCondition
// caller) rather than a dispatch-specific marker, because dispatch is NOT
// statically knowable: decideDigestEscalation() can promote 'human' -> 'auto'
// at RUNTIME once notifyCount crosses its threshold, so a caller that never
// dispatches today can start tomorrow with no YAML change. Staging a file the
// run did not modify is a harmless no-op, so over-broad is the safe direction.
const ATTEMPTS_LOG_FILE = 'alert-router-attempts.jsonl';

// Matches a bash `for VAR in <list>; do` on one line. A separate check below
// handles the `for VAR in <list>` / `do` split-across-two-lines form. Tolerates
// a trailing `# comment` after `do` (valid bash) — task #763's
// `# workflow-line-length-ok:` exemption marker lives exactly there on
// audit-aggregator-gap.yml's for-loop line, and an anchored `do\s*$` silently
// stopped recognizing the loop the moment that marker was appended.
const FOR_LOOP_INLINE_DO_RE = /^\s*for\s+(\w+)\s+in\s+(.+?);\s*do\s*(?:#.*)?$/;
const FOR_LOOP_HEADER_RE = /^\s*for\s+(\w+)\s+in\s+(.+?)\s*$/;
const BARE_DO_RE = /^\s*do\s*$/;
const DONE_RE = /^\s*done\s*$/;
// KNOWN LIMITATION (BRO-3051 /ship-check pass): text-based, not YAML/JS-aware.
// A line whose first non-whitespace char is `#` inside a `script: |` block
// could in principle be data within a JS template literal rather than a real
// comment (e.g. a string starting with "# ${routeAlert(...)}"), which would
// then be wrongly skipped by both this and jobStagesFile()'s pre-existing
// comment-skip. Same class of blind spot the header above already accepts
// for subprocess-indirect callers; no workflow in this repo writes calls
// that way today, and a real parser is out of proportion to a heuristic,
// non-blocking advisory lint.
const COMMENT_LINE_RE = /^\s*#/;

// Returns { varName, list, bodyStart } if `line` (at index i in jobLines)
// starts a `for VAR in <list>; do` loop — inline or with `do` on the next
// line — else null. bodyStart is the index of the first line inside the loop.
function matchForLoopStart(jobLines, i) {
  const line = jobLines[i];
  let m = line.match(FOR_LOOP_INLINE_DO_RE);
  if (m) return { varName: m[1], list: m[2], bodyStart: i + 1 };
  m = line.match(FOR_LOOP_HEADER_RE);
  if (m && jobLines[i + 1] && BARE_DO_RE.test(jobLines[i + 1])) {
    return { varName: m[1], list: m[2], bodyStart: i + 2 };
  }
  return null;
}

function splitJobs(workflowYamlText) {
  const lines = workflowYamlText.split('\n');
  const jobsIdx = lines.findIndex(l => /^jobs:\s*$/.test(l));
  if (jobsIdx === -1) return [];

  const starts = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(JOB_KEY_RE);
    if (m) starts.push({ name: m[1], start: i });
  }

  return starts.map((job, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].start : lines.length;
    return { name: job.name, lines: lines.slice(job.start, end) };
  });
}

// A `git add`/`git-add-existing.sh` invocation line that ends in a bare
// line-continuation backslash — the multi-line form where path arguments are
// listed one per line below it (finance-ingest.yml's dmarc job, weekly-video-
// reviews.yml, opening-night-checklist.yml). Requires \b before "git" so it
// doesn't match inside an unrelated longer token.
const GIT_ADD_CONTINUATION_START_RE = /\b(?:git add|git-add-existing\.sh)\b.*\\\s*$/;
// A path-argument continuation line: just a bare path (optionally trailing
// slash for a directory), optionally ending in another continuation
// backslash. Rejects lines with quotes, `${VAR}` expansions, or trailing
// flags/redirects — those fall through to "stop scanning" below rather than
// risk a false match.
const BARE_PATH_LINE_RE = /^[\w./-]+\s*\\?\s*$/;
const TRAILING_BACKSLASH_RE = /\\\s*$/;

// True if any non-comment line both invokes `git add` (or the
// git-add-existing.sh helper) AND mentions `fileName` directly, OR a
// `for VAR in ...fileName...; do` loop's body (before the matching `done`)
// stages "$VAR", OR fileName appears on one of the bare continuation lines
// following a multi-line `git add \` / `git-add-existing.sh \` invocation.
// Comment lines are skipped — a commented-out `# git add
// data/audit/alert-ledger.json` (or a prose mention) must not read as real
// staging.
function jobStagesFile(jobLines, fileName) {
  for (let i = 0; i < jobLines.length; i++) {
    const line = jobLines[i];
    if (COMMENT_LINE_RE.test(line)) continue;

    if (line.includes(fileName) && (/git add\b/.test(line) || /git-add-existing\.sh/.test(line))) {
      return true;
    }

    if (GIT_ADD_CONTINUATION_START_RE.test(line)) {
      let continued = true;
      for (let j = i + 1; continued && j < jobLines.length; j++) {
        const contLine = jobLines[j];
        if (COMMENT_LINE_RE.test(contLine)) continue;
        const trimmed = contLine.trim();
        if (!BARE_PATH_LINE_RE.test(trimmed)) break;
        if (contLine.includes(fileName)) return true;
        continued = TRAILING_BACKSLASH_RE.test(trimmed);
      }
    }

    const loopMatch = matchForLoopStart(jobLines, i);
    if (loopMatch && loopMatch.list.includes(fileName)) {
      const stageRe = new RegExp(`git add\\b.*\\$\\{?${loopMatch.varName}\\b`);
      for (let j = loopMatch.bodyStart; j < jobLines.length && !DONE_RE.test(jobLines[j]); j++) {
        if (!COMMENT_LINE_RE.test(jobLines[j]) && stageRe.test(jobLines[j])) return true;
      }
    }
  }
  return false;
}

/**
 * findMissingLedgerCommits(workflowYamlText) -> string[]
 *
 * Returns one human-readable reason per job that:
 *  - calls routeAlert()/resolveCondition() but has no step staging
 *    data/audit/alert-ledger.json for commit, and/or
 *  - calls routeAlert()/resolveCondition() but has no step staging
 *    data/audit/alert-router-attempts.jsonl for commit (logDispatchAttempt()
 *    rewrites that tracked file on every dispatch attempt; leaving it unstaged
 *    makes a rebase refuse pre-flight and silently forces push-with-retry.sh
 *    onto the clobber-prone merge -X ours path — BRO-3662), and/or
 *  - uses disposition:'digest' but has no step staging
 *    data/audit/alert-digest-queue.json for commit (queueDigestLine() writes
 *    this file in addition to the ledger — found live-broken in
 *    update-mezzanine.yml's scrape-mezzanine job during card #618's
 *    what-else pass: the ledger was staged, the digest queue never was, so
 *    every queued digest line for mezzanine:transient-failure silently died
 *    with the runner while the ledger correctly marked it "notified").
 *
 * Empty array = clean (or no `jobs:` section / no such calls).
 */
function findMissingLedgerCommits(workflowYamlText) {
  const violations = [];
  const jobs = splitJobs(workflowYamlText);
  for (const job of jobs) {
    // Exclude `- name:` step-title lines from call detection — a step name
    // that merely describes what the lint checks for (e.g. "Check
    // routeAlert() callers commit alert-ledger.json") is not itself a call
    // and would otherwise false-positive this very check on test.yml.
    // Also exclude full `#`-comment lines (BRO-3051): test.yml's own
    // "page-worthy alert steps unreachable" audit step (BRO-2817) documents
    // that OTHER checker's blind spot with a prose example — "# routeAlert
    // (disposition:'human', conditionKey: <page-worthy>) alert" — which is
    // not a call either, but was matched anyway because only step-name
    // lines were stripped. jobStagesFile() already skips comment lines for
    // the same reason (a commented-out `git add` mustn't read as real
    // staging); call detection needs the same treatment for the same
    // reason, in the opposite direction.
    const body = job.lines
      .filter(l => !/^\s*-?\s*name:/.test(l) && !COMMENT_LINE_RE.test(l))
      .join('\n');

    if (ROUTE_ALERT_CALL_RE.test(body) && !jobStagesFile(job.lines, LEDGER_FILE)) {
      violations.push(
        `job '${job.name}' calls routeAlert()/resolveCondition() but no step stages data/audit/${LEDGER_FILE} for commit in this job`
      );
    }

    if (ROUTE_ALERT_CALL_RE.test(body) && !jobStagesFile(job.lines, ATTEMPTS_LOG_FILE)) {
      violations.push(
        `job '${job.name}' calls routeAlert()/resolveCondition() but no step stages data/audit/${ATTEMPTS_LOG_FILE} for commit in this job`
      );
    }

    if (DIGEST_DISPOSITION_RE.test(body) && !jobStagesFile(job.lines, DIGEST_QUEUE_FILE)) {
      violations.push(
        `job '${job.name}' uses disposition:'digest' but no step stages data/audit/${DIGEST_QUEUE_FILE} for commit in this job`
      );
    }
  }
  return violations;
}

module.exports = { findMissingLedgerCommits };
