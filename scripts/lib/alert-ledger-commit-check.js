/**
 * Lint check: any GitHub Actions job that calls routeAlert()/resolveCondition()
 * (scripts/lib/owner-alert-router.js) must also stage data/audit/alert-ledger.json
 * for commit in the SAME job — the ledger only exists on that job's ephemeral
 * runner disk, so a commit in a different job (or no commit at all) silently
 * resets the cooldown/dedup state every run (card #618, 5th recurrence of the
 * class first found in #394/#608/#610: audit-aggregator-gap.yml,
 * test-ugc-roundtrip.yml, ux-walkthrough.yml, check-cron-health.yml).
 *
 * Deliberately text/regex-based (no YAML parser dependency), matching the
 * style of the other checks in lint-workflow-guards.sh — jobs are split on
 * the repo's consistent 2-space job-key indent under `jobs:`.
 */

const JOB_KEY_RE = /^  ([A-Za-z0-9_.-]+):\s*$/;
const ROUTE_ALERT_CALL_RE = /\b(routeAlert|resolveCondition)\s*\(/;
const LEDGER_FILE = 'alert-ledger.json';

// Matches a bash `for VAR in <list>; do` (or `<list>\ndo` handled by callers
// scanning line-by-line) — the only for-loop shape actually used by the
// staging patterns in this repo (see audit-aggregator-gap.yml, check-cron-health.yml).
const FOR_LOOP_RE = /^\s*for\s+(\w+)\s+in\s+(.+?);\s*do\s*$/;
const DONE_RE = /^\s*done\s*$/;

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

// True if any line both invokes `git add` (or the git-add-existing.sh helper)
// AND mentions alert-ledger.json directly, OR a `for VAR in ...alert-ledger.json...; do`
// loop's body (before the matching `done`) stages "$VAR".
function jobStagesLedger(jobLines) {
  for (let i = 0; i < jobLines.length; i++) {
    const line = jobLines[i];

    if (line.includes(LEDGER_FILE) && (/git add\b/.test(line) || /git-add-existing\.sh/.test(line))) {
      return true;
    }

    const loopMatch = line.match(FOR_LOOP_RE);
    if (loopMatch) {
      const [, varName, list] = loopMatch;
      if (list.includes(LEDGER_FILE)) {
        const stageRe = new RegExp(`git add\\b.*\\$\\{?${varName}\\b`);
        for (let j = i + 1; j < jobLines.length && !DONE_RE.test(jobLines[j]); j++) {
          if (stageRe.test(jobLines[j])) return true;
        }
      }
    }
  }
  return false;
}

/**
 * findMissingLedgerCommits(workflowYamlText) -> string[]
 *
 * Returns one human-readable reason per job that calls routeAlert()/
 * resolveCondition() but has no step staging data/audit/alert-ledger.json
 * for commit. Empty array = clean (or no `jobs:` section / no such calls).
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
    if (!ROUTE_ALERT_CALL_RE.test(body)) continue;
    if (!jobStagesLedger(job.lines)) {
      violations.push(
        `job '${job.name}' calls routeAlert()/resolveCondition() but no step stages data/audit/${LEDGER_FILE} for commit in this job`
      );
    }
  }
  return violations;
}

module.exports = { findMissingLedgerCommits };
