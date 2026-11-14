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

// BRO-267: "writes data/audit/" now means the source both names the directory
// and calls a write primitive. A script that only reads or mentions
// data/audit/ in a comment cannot lose an audit write when its step is
// swallowed, so flagging it was noise that buried the real writers.
const WRITE_CALL_RE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|renameSync|createWriteStream|writeAuditArtifact|writeJson\w*|atomicWrite\w*|appendJsonl\w*|writeAtomic\w*)\b/;
// The directory may be named as 'data/audit/' or built with path.join('data', 'audit').
// Also path.join(DATA_DIR, 'audit', ...) and '../data/audit' with no trailing slash.
const AUDIT_DIR_RE = /data\/audit\b|\b(?:data|DATA_DIR|DATA)\w*['"]?\s*,\s*['"]audit['"]/;
function isAuditWriterSource(text) {
  return AUDIT_DIR_RE.test(text) && WRITE_CALL_RE.test(text);
}

/**
 * File-level predicate that also follows ONE level of relative requires, since
 * many scripts write through a shared helper (autonomous-ledger.js,
 * weekly-monitor-runner.js): the script names the audit path, the helper makes
 * the write call. `root` is the repo root; `script` is repo-relative.
 */
function isAuditWriterFile(root, script) {
  const fs = require('fs');
  const path = require('path');
  let text;
  try { text = fs.readFileSync(path.join(root, script), 'utf8'); } catch { return false; }
  if (isAuditWriterSource(text)) return true;
  if (!AUDIT_DIR_RE.test(text)) return false;
  const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    for (const cand of [m[1], m[1] + '.js']) {
      try {
        const f = path.resolve(path.dirname(path.join(root, script)), cand);
        if (WRITE_CALL_RE.test(fs.readFileSync(f, 'utf8'))) return true;
      } catch { /* not a file */ }
    }
  }
  return false;
}

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
function findSwallowedAuditWriters(workflowYamlText, isAuditWriterScript, opts = {}) {
  const violations = [];
  const matched = opts.matched || null; // Set of allowlist keys that suppressed a violation
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
      const hit = opts.allowlist && opts.workflow && matchAllowlist(opts.allowlist, opts.workflow, stepName, script);
      if (hit) { if (matched) matched.add(hit.key); continue; }
      violations.push(
        `step '${stepName}' runs ${script} (writes data/audit/) with ${swallowKind} — failures are silently swallowed`
      );
    }
  }

  return violations;
}

/**
 * Central, reasoned exemptions (BRO-267). Same contract as the inline
 * `# lint-allow-swallow:` comment, kept in
 * scripts/lib/swallowed-audit-writer-allowlist.json so triage does not need an
 * edit to a workflow file. An entry is {workflow, step?, script?, reason}:
 * `step` omitted covers every step of that workflow running `script`;
 * `workflow: "*"` covers the script in every workflow. `reason` is required.
 */
function allowlistKey(e) { return `${e.workflow}|${e.step || '*'}|${e.script || '*'}`; }

function validateAllowlist(entries) {
  const problems = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    if (!e || typeof e.workflow !== 'string' || !e.workflow) problems.push(`entry ${i}: missing workflow`);
    else if (!e.script && !e.step) problems.push(`entry ${i} (${e.workflow}): needs step or script`);
    if (!e || typeof e.reason !== 'string' || e.reason.trim().length < 20) problems.push(`entry ${i}: reason must be a real sentence (>=20 chars)`);
    if (e && seen.has(allowlistKey(e))) problems.push(`entry ${i}: duplicate ${allowlistKey(e)}`);
    if (e) seen.add(allowlistKey(e));
  });
  return problems;
}

function matchAllowlist(entries, workflow, step, script) {
  let best = null;
  let bestScore = -1;
  for (const e of entries) {
    if (e.workflow !== '*' && e.workflow !== workflow) continue;
    if (e.step && e.step !== step) continue;
    if (e.script && e.script !== script) continue;
    // Most specific entry wins so a narrow entry is never reported stale behind a wildcard.
    const score = (e.workflow !== '*' ? 1 : 0) + (e.step ? 1 : 0) + (e.script ? 1 : 0);
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return best ? { ...best, key: allowlistKey(best) } : null;
}

module.exports = { findSwallowedAuditWriters, splitSteps, isAuditWriterSource, isAuditWriterFile, validateAllowlist, matchAllowlist, allowlistKey };
