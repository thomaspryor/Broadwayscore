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
 * explanatory comment). scrape-new-aggregators.yml's `scrape-playbill-verdict`
 * job is exactly this case today — it's only checked because of a comment
 * documenting that promote-ob-venue-candidates.js calls routeAlert(). If that
 * comment is ever reworded or removed, this job silently drops out of
 * coverage with no warning. Don't remove/reword a "calls routeAlert()"-style
 * comment without confirming the job still has an inline mention, or add a
 * one-line `# routeAlert(...)` breadcrumb if it doesn't.
 */

const JOB_KEY_RE = /^  ([A-Za-z0-9_.-]+):\s*$/;
const ROUTE_ALERT_CALL_RE = /\b(routeAlert|resolveCondition)\s*\(/;
const DIGEST_DISPOSITION_RE = /disposition:\s*'digest'/;
const LEDGER_FILE = 'alert-ledger.json';
const DIGEST_QUEUE_FILE = 'alert-digest-queue.json';

// Matches a bash `for VAR in <list>; do` on one line. A separate check below
// handles the `for VAR in <list>` / `do` split-across-two-lines form.
const FOR_LOOP_INLINE_DO_RE = /^\s*for\s+(\w+)\s+in\s+(.+?);\s*do\s*$/;
const FOR_LOOP_HEADER_RE = /^\s*for\s+(\w+)\s+in\s+(.+?)\s*$/;
const BARE_DO_RE = /^\s*do\s*$/;
const DONE_RE = /^\s*done\s*$/;
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

// True if any non-comment line both invokes `git add` (or the
// git-add-existing.sh helper) AND mentions `fileName` directly, OR a
// `for VAR in ...fileName...; do` loop's body (before the matching `done`)
// stages "$VAR". Comment lines are skipped — a commented-out `# git add
// data/audit/alert-ledger.json` (or a prose mention) must not read as real
// staging.
function jobStagesFile(jobLines, fileName) {
  for (let i = 0; i < jobLines.length; i++) {
    const line = jobLines[i];
    if (COMMENT_LINE_RE.test(line)) continue;

    if (line.includes(fileName) && (/git add\b/.test(line) || /git-add-existing\.sh/.test(line))) {
      return true;
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
    const body = job.lines.filter(l => !/^\s*-?\s*name:/.test(l)).join('\n');

    if (ROUTE_ALERT_CALL_RE.test(body) && !jobStagesFile(job.lines, LEDGER_FILE)) {
      violations.push(
        `job '${job.name}' calls routeAlert()/resolveCondition() but no step stages data/audit/${LEDGER_FILE} for commit in this job`
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
