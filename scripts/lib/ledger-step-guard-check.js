/**
 * Lint check (BRO-2243): every workflow step that calls the
 * `commit-scraper-spend-ledger` composite action MUST carry both
 * `if: always()` and `continue-on-error: true` on the CALLING step, so a
 * push race on the ledger file (many concurrent runs pushing to main) can
 * never fail the job that's using it for bookkeeping — the composite
 * action's own header comment documents this as the caller's contract, but
 * nothing previously enforced it structurally. Investigation for BRO-2243
 * found all 30 existing call sites already compliant (fixed in BRO-163,
 * 2026-08-14); this check is the regression guard so a NEW call site (or an
 * edit that drops one of the two flags) can't silently reopen the race.
 *
 * Deliberately text/regex-based over the repo's `      - name: ...` step
 * convention, matching swallowed-audit-writer-check.js's style. Owns its own
 * splitSteps() (rather than importing that file's) — every other check.js in
 * this repo (e.g. ledger-coverage-check.js's splitJobs) implements its own
 * tiny splitter instead of depending on a sibling, unrelated check module;
 * following that precedent avoids a needless coupling where an edit to
 * swallowed-audit-writer-check.js for its own reasons could break this one.
 */

const STEP_START_RE = /^\s*-\s+name:/;
const USES_LEDGER_ACTION_RE = /^\s*uses:\s*\.\/\.github\/actions\/commit-scraper-spend-ledger\s*$/;
// NOTE: matches the literal substring `always()` anywhere on the `if:` line,
// so it correctly accepts compound conditions (e.g. scrapingdog-account-
// usage.yml's `if: always() && inputs.mode == 'x'`). Theoretical false-match
// if a step's `if:` contained `always()` inside a negation/string
// (`!always()`, a `contains(..., 'always()')` guard) — not present at any of
// this repo's real call sites today; accepted as out of scope.
const IF_ALWAYS_RE = /^\s*if:\s*.*\balways\(\)/;
const CONTINUE_ON_ERROR_RE = /^\s*continue-on-error:\s*true\s*$/;
const STEP_NAME_RE = /^\s*-\s+name:\s*(.+)\s*$/m;

function splitSteps(workflowYamlText) {
  const lines = workflowYamlText.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (STEP_START_RE.test(lines[i])) starts.push(i);
  }
  return starts.map((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    return lines.slice(s, end);
  });
}

/**
 * findLedgerStepGuardIssues(workflowYamlText) -> string[]
 * Returns one human-readable violation string per step that uses the ledger
 * composite action but is missing `if: always()` and/or
 * `continue-on-error: true`. Empty array = clean (or no matching steps).
 */
function findLedgerStepGuardIssues(workflowYamlText) {
  const violations = [];
  const steps = splitSteps(workflowYamlText);

  for (const stepLines of steps) {
    if (!stepLines.some((l) => USES_LEDGER_ACTION_RE.test(l))) continue;

    const hasIfAlways = stepLines.some((l) => IF_ALWAYS_RE.test(l));
    const hasContinueOnError = stepLines.some((l) => CONTINUE_ON_ERROR_RE.test(l));
    if (hasIfAlways && hasContinueOnError) continue;

    const stepText = stepLines.join('\n');
    const nameMatch = stepText.match(STEP_NAME_RE);
    const stepName = nameMatch ? nameMatch[1].trim() : '(unnamed step)';

    const missing = [];
    if (!hasIfAlways) missing.push('if: always()');
    if (!hasContinueOnError) missing.push('continue-on-error: true');
    violations.push(
      `step '${stepName}' calls commit-scraper-spend-ledger without ${missing.join(' and ')} — a push race on the ledger file could fail this job (BRO-2243)`
    );
  }

  return violations;
}

module.exports = { findLedgerStepGuardIssues };
