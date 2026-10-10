/**
 * Lint check: flags a GitHub Actions workflow STEP that (a) runs `node
 * scripts/<x>.js` where <x>.js writes to data/audit/ (heuristic: the script's
 * source text contains the literal substring 'data/audit/' — intentionally
 * loose/over-inclusive per task #1073 W5.1's spec, same "grep the script"
 * heuristic check_core_data_pairing() uses for CORE_WRITER_SCRIPTS elsewhere
 * in lint-workflow-guards.sh), AND (b) that step swallows its own failure via
 * `continue-on-error: true` or a `|| true` anywhere in the step body.
 *
 * That combination is exactly the class of bug found in task #1073's root-
 * cause investigation: opening-night-checklist.yml's "Run opening night
 * checklist" step had BOTH `continue-on-error: true` AND `2>&1 || true` on
 * the `node scripts/opening-night-checklist.js` line, so a MODULE_NOT_FOUND
 * crash inside the script (missing `npm ci` in the workflow) silently
 * discarded every write to data/audit/opening-night-history.json for 100+
 * days while the workflow itself kept reporting green. See the diagnosis
 * comment above appendToHistory() in scripts/opening-night-checklist.js.
 *
 * Deliberately text/regex-based (no YAML parser dependency), matching the
 * style of the other checks in lint-workflow-guards.sh — steps are split on
 * the repo's consistent step-list convention (`      - name: ...` marks the
 * start of each step under `steps:`).
 *
 * Step-level (not line-level) detection: a `node scripts/x.js \` invocation
 * with `|| true` on a *different* physical line via `\` continuation (a real,
 * common pattern in this repo — see opening-night-checklist.yml's "Run
 * latency report" step) still counts. This is intentionally coarser than
 * "the exact line with the node call has `|| true`" — a step swallowing ANY
 * part of a multi-line command that includes an audit-writing script counts.
 *
 * Suppression: a step containing `# lint-allow-swallow: <reason>` anywhere in
 * its body is exempt (same "one documented, reviewed exemption per site"
 * pattern as scraping-fallback/scrapingdog-pairing's EXEMPT lists, but
 * inline on the step itself since the exemption is step-scoped, not
 * workflow-scoped).
 */

const STEP_START_RE = /^\s*-\s+name:/;
const CONTINUE_ON_ERROR_RE = /^\s*continue-on-error:\s*true\s*$/;
const OR_TRUE_RE = /\|\|\s*true\b/;
const ALLOWLIST_RE = /#\s*lint-allow-swallow:\s*(.+)/;
const NODE_SCRIPT_RE = /\bnode\s+([A-Za-z0-9_\-./]*scripts\/[A-Za-z0-9_\-./]+\.js)\b/g;
const STEP_NAME_RE = /^\s*-\s+name:\s*(.+)\s*$/m;
// Full-line YAML comments only (`      # explains the pattern below`) — same
// convention as alert-ledger-commit-check.js's COMMENT_LINE_RE. Deliberately
// does NOT strip a trailing `# comment` off an otherwise-real line (e.g.
// `continue-on-error: true  # why`), matching that file's scope too — this
// check only needs to stop matching PROSE that happens to mention
// `continue-on-error: true` or `` || true `` while explaining/documenting the
// pattern (this file's own header comments do exactly that), not handle
// trailing-comment stripping on real config/command lines.
const COMMENT_LINE_RE = /^\s*#/;

/**
 * splitSteps(workflowYamlText) -> string[][]
 * Splits a workflow file's text into one array of lines per step, using
 * `      - name:` as the step boundary (the convention every workflow in
 * this repo follows for named steps). A leading run of lines before the
 * first `- name:` (job/on/permissions header, unnamed steps) is dropped —
 * unnamed steps can't run a meaningful `node scripts/...` command relevant
 * to this check without a `- run:`/`- uses:` sibling that also starts a new
 * "step" for our purposes, so this is a non-issue in practice for this repo.
 */
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
 * findSwallowedAuditWriters(workflowYamlText, isAuditWriterScript) -> string[]
 *
 * isAuditWriterScript(scriptPath) -> boolean is injected so this function
 * stays pure and unit-testable without touching the filesystem — the real
 * caller (lint-workflow-guards.sh's check_swallowed_audit_writers) greps the
 * actual script file on disk for 'data/audit/'.
 *
 * Returns one human-readable violation string per (step, script) pair found.
 * Empty array = clean (or no matching steps).
 */
function findSwallowedAuditWriters(workflowYamlText, isAuditWriterScript) {
  const violations = [];
  const steps = splitSteps(workflowYamlText);

  for (const stepLines of steps) {
    const stepText = stepLines.join('\n');
    if (ALLOWLIST_RE.test(stepText)) continue; // lint-allow-swallow: <reason>

    // Full-line comments (including explanatory prose that itself mentions
    // `continue-on-error: true` or `|| true` while documenting the pattern —
    // this file's own YAML edits do exactly that) must not count as real
    // config/command lines.
    const codeLines = stepLines.filter((l) => !COMMENT_LINE_RE.test(l));
    const codeText = codeLines.join('\n');

    const hasContinueOnError = codeLines.some((l) => CONTINUE_ON_ERROR_RE.test(l));
    const hasOrTrue = codeLines.some((l) => OR_TRUE_RE.test(l));
    if (!hasContinueOnError && !hasOrTrue) continue;

    const scripts = new Set();
    let m;
    NODE_SCRIPT_RE.lastIndex = 0;
    while ((m = NODE_SCRIPT_RE.exec(codeText))) {
      scripts.add(m[1]);
    }
    if (scripts.size === 0) continue;

    const nameMatch = stepText.match(STEP_NAME_RE);
    const stepName = nameMatch ? nameMatch[1].trim() : '(unnamed step)';
    const swallowKind = hasContinueOnError ? 'continue-on-error: true' : "'|| true'";

    for (const script of scripts) {
      if (!isAuditWriterScript(script)) continue;
      violations.push(
        `step '${stepName}' runs ${script} (writes data/audit/) with ${swallowKind} — failures are silently swallowed`
      );
    }
  }

  return violations;
}

module.exports = { findSwallowedAuditWriters, splitSteps };
