/**
 * Derives a runnable `VERIFY: <cmd>` line for a `test-yml:red:<job>:<sig>`
 * card (scripts/lib/main-red-streak.js's per-breakage signatures) from the
 * failing step's own `run:` command in .github/workflows/test.yml.
 *
 * BRO-3907: owner-alert-router.js's buildCardNotes() only ever wrote prose
 * acceptance criteria for this condition family ("Condition X no longer
 * fires on the next check") — no backticked command, no `VERIFY:` line — so
 * linear-next.js's evaluateVerifiability() (scripts/lib/verify-gate.js)
 * refused to dispatch every one of these cards ("no runnable verify command
 * (acceptance criteria names no runnable command (prose only))"). BRO-3865
 * had already keyed each breakage to its own job+step (see
 * failingStepSignatures() in main-red-streak.js) — the failing step's own
 * `run:` command IS the natural re-verification check, this just has to be
 * extracted and safety-checked before it can be handed to a card.
 *
 * Same "one place builds the command" shape as BRO-3881's
 * health-row-check-cmd.js (the other auto-filer family that had this exact
 * bug) — kept as a separate file rather than folded into that one because the
 * two condition families (`health-check:*` rows vs `test-yml:red:*`
 * signatures) encode completely different things (a health-check row name vs
 * a job/step pair parsed out of a workflow file).
 *
 * No external YAML dependency (js-yaml is not installed for lint-workflows'
 * job — see ci-cancellation-guard.js's header) — same indentation-aware
 * line-reading approach as ci-cancellation-guard.js and
 * audit-workflow-hygiene-rules.js's job/step walkers, not a shared module
 * (each file's block-boundary needs differ enough — concurrency-group
 * lookup vs job/step/run: extraction — that a premature shared abstraction
 * seemed worse than three small, independently-readable copies; revisit if
 * a fourth caller shows up).
 */
'use strict';

const { explainUnsafeCheckCommand } = require('./autonomous-triage-core.js');

// Fallback commands for when the failing step can't be resolved to a single
// safe-form `run:` line (unknown/renamed step, or a multi-line `run: |`
// block — most of Lint Workflows' and Unit Tests' steps are the latter).
// Each entry here is pre-vetted against explainUnsafeCheckCommand() by this
// file's own tests, so a drift in SAFE_CHECK_FORMS that breaks one of these
// fails loudly in CI instead of silently degrading every card in that job to
// owner-judgment.
const JOB_PROXY_COMMANDS = {
  // scripts/run-unit-tests.js runs the identical two manifests
  // (tests/unit-test-manifest.txt / -tsx.txt) this job's own multi-line `run:`
  // block runs — see that script's header. The workflow step itself can't be
  // named directly: it's a bash block, not a single command.
  'Unit Tests': 'node scripts/run-unit-tests.js',
  // audit-workflow-concurrency.js is one of Lint Workflows' own ~50 steps and
  // is on the generic audit-/lint- safe-form allowlist — a real, always-safe
  // representative check for "something in this job broke", when the actual
  // failing step can't be named directly.
  'Lint Workflows': 'node scripts/audit-workflow-concurrency.js',
  'Data Validation': 'node scripts/validate-data.js',
};

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;
const isBlank = (line) => { const t = line.trim(); return t === '' || t.startsWith('#'); };

// First line index after `headerIdx` (skipping blanks/comments) whose indent
// is <= headerIndent — i.e. the line that closes the block `headerIdx` opens.
function blockEnd(lines, headerIdx, headerIndent) {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= headerIndent) return i;
  }
  return lines.length;
}

// Indices of the direct (immediate) children of the block headed at
// `headerIdx` — every non-blank line up to blockEnd() whose indent equals the
// FIRST such line's indent (deeper-still lines are grandchildren, skipped).
function directChildren(lines, headerIdx, headerIndent) {
  const end = blockEnd(lines, headerIdx, headerIndent);
  const out = [];
  let childIndent = null;
  for (let i = headerIdx + 1; i < end; i++) {
    if (isBlank(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (childIndent === null) childIndent = ind;
    if (ind === childIndent) out.push(i);
  }
  return out;
}

function findJobHeaderIdx(lines, jobDisplayName) {
  const jobsIdx = lines.findIndex((l) => indentOf(l) === 0 && /^jobs\s*:/.test(l.trim()));
  if (jobsIdx === -1) return -1;
  for (const jobIdx of directChildren(lines, jobsIdx, 0)) {
    const jobIndent = indentOf(lines[jobIdx]);
    const nameIdx = directChildren(lines, jobIdx, jobIndent)
      .find((ci) => /^\s*name\s*:/.test(lines[ci]));
    if (nameIdx === undefined) continue;
    const name = lines[nameIdx].slice(lines[nameIdx].indexOf(':') + 1).trim();
    if (name === jobDisplayName) return jobIdx;
  }
  return -1;
}

function findStepHeaderIdx(lines, jobHeaderIdx, stepName) {
  const jobIndent = indentOf(lines[jobHeaderIdx]);
  const stepsIdx = directChildren(lines, jobHeaderIdx, jobIndent)
    .find((ci) => /^\s*steps\s*:/.test(lines[ci]));
  if (stepsIdx === undefined) return -1;
  const stepsIndent = indentOf(lines[stepsIdx]);
  for (const si of directChildren(lines, stepsIdx, stepsIndent)) {
    const m = /^\s*-\s*name\s*:\s*(.*)$/.exec(lines[si]);
    if (!m) continue; // step with no `name:` as its first key — not addressable
    if (m[1].trim() === String(stepName || '').trim()) return si;
  }
  return -1;
}

// The step's `run:` value, only when it's a single-line scalar (`run: <cmd>`)
// — a block scalar (`run: |`, `run: >`) has no single command to extract, and
// callers treat that identically to "step not found" (fall through to the
// job-level proxy).
function findStepRunCommand(lines, stepHeaderIdx) {
  const dashIndent = indentOf(lines[stepHeaderIdx]);
  const fieldIndent = dashIndent + 2; // sibling keys align with "name" after "- "
  const end = blockEnd(lines, stepHeaderIdx, dashIndent);
  for (let i = stepHeaderIdx; i < end; i++) {
    if (indentOf(lines[i]) !== fieldIndent) continue;
    const m = /^\s*run\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let rest = m[1].trim();
    if (!rest || /^[|>][+-]?\d*$/.test(rest)) return null; // empty or block-scalar indicator
    // A YAML flow scalar (`run: "cmd"` / `run: 'cmd'`) is valid and, unlike
    // every OTHER form this repo's `run:` lines use, would otherwise reach
    // explainUnsafeCheckCommand with its quote characters still attached —
    // failing every SAFE_CHECK_FORMS regex (none anchor on a leading quote)
    // and silently degrading a perfectly safe command to owner-judgment. No
    // real step in test.yml quotes its `run:` today (bare/`|` only), but
    // nothing stops a future one from starting to. Single-quoted YAML escapes
    // `''` as a literal `'` — unescaped here since a shell command containing
    // one is rare enough that falling through to the unquoted (and then
    // safe-form-rejected) string is an acceptable degrade, not a crash.
    const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(rest);
    if (quoted) rest = quoted[1] !== undefined ? quoted[1] : quoted[2];
    return rest;
  }
  return null;
}

/**
 * @param {string} rawYmlText contents of .github/workflows/test.yml
 * @param {string} jobDisplayName the job's `name:` (e.g. "Lint Workflows") — NOT its YAML key
 * @param {string} stepName the step's `name:`
 * @returns {string|null} the step's single-line `run:` command, or null if the
 *   job/step can't be found or its `run:` is a multi-line block
 */
function findStepRunCommandInWorkflow(rawYmlText, jobDisplayName, stepName) {
  const lines = String(rawYmlText || '').split('\n');
  const jobIdx = findJobHeaderIdx(lines, jobDisplayName);
  if (jobIdx === -1) return null;
  const stepIdx = findStepHeaderIdx(lines, jobIdx, stepName);
  if (stepIdx === -1) return null;
  return findStepRunCommand(lines, stepIdx);
}

function ownerJudgment(note) {
  return { line: 'VERIFY: owner-judgment', note };
}

// Safety-checks `cmd` once and returns either an armed `{line, note}` (`note`
// is whatever the caller wants attached — null for a direct step-command hit,
// an explanation for a job-proxy fallback) or an owner-judgment `{line, note}`
// built from `unsafeNote(safe)`, where `safe` is explainUnsafeCheckCommand's
// own `{kind, reason}` — the caller supplies that message since "the step's
// own command was unsafe" and "the job's supposedly-safe proxy unexpectedly
// failed" warrant different explanations even though the check is identical.
function armOrOwnerJudgment(cmd, armedNote, unsafeNote) {
  const safe = explainUnsafeCheckCommand(cmd);
  if (safe.ok) return { line: `VERIFY: ${cmd}`, note: armedNote };
  return ownerJudgment(unsafeNote(safe));
}

/**
 * @param {{job: string, step: string}} sig one entry from failingStepSignatures()
 * @param {string} rawYmlText contents of .github/workflows/test.yml
 * @returns {{line: string, note: string|null}} `line` is either
 *   `VERIFY: <safe-form command>` or the literal `VERIFY: owner-judgment`;
 *   `note` explains the fallback/refusal when `line` isn't a direct hit, and
 *   is null when the step's own command was used as-is.
 */
function verifyForSignature({ job, step }, rawYmlText) {
  const stepCmd = findStepRunCommandInWorkflow(rawYmlText, job, step);
  if (stepCmd) {
    return armOrOwnerJudgment(stepCmd, null, (safe) =>
      `The failing step's own command (\`${stepCmd}\`) is not on the safe-form allowlist ` +
      `(${safe.kind}: ${safe.reason}) — an unattended dispatch cannot arm it, so this needs a ` +
      `human to name a safe re-verification command.`
    );
  }
  const proxy = JOB_PROXY_COMMANDS[job];
  if (proxy) {
    return armOrOwnerJudgment(
      proxy,
      `Job-level proxy — the failing step ("${step}") could not be resolved to a single safe-form ` +
      `command in test.yml (unknown/renamed step, or a multi-line \`run:\` block), so this re-runs ` +
      `the job's representative check instead of the exact failing one.`,
      (safe) =>
        `Job-level proxy command for "${job}" unexpectedly failed safe-form validation ` +
        `(${safe.kind}: ${safe.reason}) — needs a human to name a safe re-verification command.`
    );
  }
  return ownerJudgment(
    `No \`run:\` command could be resolved for step "${step}" in job "${job}", and no job-level ` +
    `proxy is registered for this job — needs a human to name a safe re-verification command.`
  );
}

module.exports = {
  verifyForSignature,
  findStepRunCommandInWorkflow,
  // Exported so a test can assert every JOB_PROXY_COMMANDS key still
  // resolves to a real job in the live workflow file — a job rename
  // silently orphans its proxy entry otherwise (ship-check finding: the
  // exact class of silent-drift bug this file exists to fix, one layer up).
  jobExistsInWorkflow: (rawYmlText, jobDisplayName) => findJobHeaderIdx(String(rawYmlText || '').split('\n'), jobDisplayName) !== -1,
  JOB_PROXY_COMMANDS,
};
