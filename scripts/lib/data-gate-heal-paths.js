'use strict';

/**
 * Pure decision logic for the "every strict/gated Data Validation audit must
 * have a heal path" ratchet (scripts/audit-data-gate-heal-paths.js).
 *
 * BRO-3425 measured 23 run lines in test.yml's `data-validation` job carrying
 * --strict (8) or --gate (15). Two of them (audit-cv-flag-contradiction.js,
 * audit-orphan-show-ids.js) already have a heal path — a baseline-diff mode
 * or a scheduled --fix workflow — and nothing else does, so gates accumulate
 * faster than anyone drains them and main stays red on drift, not on real
 * regressions. A gate qualifies as healed if ANY of:
 *   1. Baseline-diff: the invoked script's own source references a
 *      `data/audit/*baseline*.json` path (freezes today's backlog, only new
 *      hits fail).
 *   2. Scheduled self-heal: some OTHER workflow (not test.yml) has a
 *      `schedule:` trigger and a real (non-comment) run line invoking the
 *      same script with --fix / --update-baseline / --heal.
 *   3. `# heal-exempt: <reason>` comment directly above the step's `run:`
 *      line — for gates where auto-healing is unsafe by design (contamination
 *      guards that need a human to judge each hit) or that are intentionally
 *      a hard floor, not a drift signal.
 * No external deps (js-yaml is not guaranteed installed when this runs before
 * `npm ci` finishes in CI) — same plain-text scan approach as
 * scripts/lib/ci-cancellation-guard.js.
 *
 * Known limitation (adversarial review, BRO-3507): RUN_LINE_RE only matches
 * a single-line `run: node scripts/X.js --flag`, which is how all 23 gates
 * in the data-validation job are written today. A future gate written as a
 * multi-line `run: |` block, or with the flag on a folded/quoted line, would
 * silently evade detection and ship with no heal path required. Matches this
 * codebase's existing regex-scan convention for workflow parsing (see the
 * module comment above) rather than adding a YAML parser; if gates start
 * using multi-line run blocks, this scanner needs a matching update.
 */

const FIX_FLAG_RE = /--fix\b|--update-baseline\b|--heal\b|--write\b/;
// Matches either a literal path (`data/audit/foo-baseline.json`) or a bare
// filename (`'foo-baseline.json'`) — many scripts build the path via
// `path.join(__dirname, '..', 'data', 'audit', 'foo-baseline.json')`, which
// splits the directory off from the filename, so a path-shaped regex alone
// misses them.
const BASELINE_PATH_RE = /[\w./-]*baseline[\w-]*\.json/i;
const HEAL_EXEMPT_RE = /#\s*heal-exempt:\s*(.+?)\s*$/i;
const RUN_LINE_RE = /^\s*run:\s*node\s+scripts\/([\w.-]+)\.js\s+(.*)$/;
const STEP_START_RE = /^\s*-\s*name:/;

/** Slice out one job's lines from a workflow file's raw text, by top-level (2-space) key. */
function extractJobLines(workflowContent, jobName) {
  const lines = workflowContent.split('\n');
  const startRe = new RegExp(`^  ${jobName}:\\s*$`);
  const anyJobRe = /^  [a-zA-Z][\w-]*:\s*$/;
  const start = lines.findIndex((l) => startRe.test(l));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyJobRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

/**
 * Finds every `run: node scripts/X.js ... --strict|--gate` line in the given
 * job lines and any `# heal-exempt:` reason found between the enclosing
 * step's `- name:` line and the run line.
 */
function findStrictGateSteps(jobLines) {
  const gates = [];
  let lastStepStart = 0;
  for (let i = 0; i < jobLines.length; i++) {
    const line = jobLines[i];
    if (STEP_START_RE.test(line)) lastStepStart = i;
    const m = RUN_LINE_RE.exec(line);
    if (!m) continue;
    const [, script, rest] = m;
    if (!/--strict\b|--gate\b/.test(rest)) continue;

    let healExemptReason = null;
    for (let j = lastStepStart; j <= i; j++) {
      const exemptMatch = HEAL_EXEMPT_RE.exec(jobLines[j]);
      if (exemptMatch) {
        healExemptReason = exemptMatch[1];
        break;
      }
    }
    gates.push({ script, flags: rest.trim(), healExemptReason });
  }
  return gates;
}

/** Does the script's own source reference a baseline-diff JSON path? */
function hasBaselineDiffPath(scriptSource) {
  return BASELINE_PATH_RE.test(scriptSource || '');
}

/**
 * Does some OTHER (non-test.yml) workflow schedule this script with a fix flag?
 * `workflowFiles`: [{ filename, content }].
 *
 * Known limitation (/code-review catch): this checks that the file has A
 * `schedule:` trigger and A fix-flag invocation ANYWHERE in the file — it
 * does not verify the fix step is actually reachable FROM that schedule (a
 * multi-job workflow could gate its schedule-triggered job on something
 * unrelated and only run --fix on workflow_dispatch, e.g. `if:
 * github.event_name == 'workflow_dispatch'` on the job containing the fix
 * step). Verified this does not affect any of today's 24 gates — every
 * scheduled-fix-workflow match is a workflow whose fix job runs
 * unconditionally on its schedule trigger — but a future workflow with that
 * split-job shape would be wrongly marked healed. Same class of accepted gap
 * as the single-line RUN_LINE_RE limitation above: fixing it properly needs
 * per-job trigger-reachability analysis, which this deliberately dependency-
 * free line-scanner doesn't attempt.
 */
function hasScheduledFixWorkflow(scriptName, workflowFiles) {
  return (workflowFiles || []).some(({ filename, content }) => {
    if (filename === 'test.yml') return false;
    if (!/^\s{0,2}schedule:\s*$/m.test(content)) return false;
    return content.split('\n').some((line) => {
      const stripped = line.replace(/#.*$/, '');
      return stripped.includes(`scripts/${scriptName}.js`) && FIX_FLAG_RE.test(stripped);
    });
  });
}

/**
 * @param {{script: string, flags: string, healExemptReason: string|null}} gate
 * @param {{scriptSource: string, workflowFiles: Array<{filename: string, content: string}>}} ctx
 * @returns {{...gate, compliant: boolean, healPath: string|null}}
 */
function evaluateGate(gate, { scriptSource, workflowFiles }) {
  if (hasBaselineDiffPath(scriptSource)) {
    return { ...gate, compliant: true, healPath: 'baseline-diff' };
  }
  if (hasScheduledFixWorkflow(gate.script, workflowFiles)) {
    return { ...gate, compliant: true, healPath: 'scheduled-fix-workflow' };
  }
  if (gate.healExemptReason) {
    return { ...gate, compliant: true, healPath: `heal-exempt: ${gate.healExemptReason}` };
  }
  return { ...gate, compliant: false, healPath: null };
}

/**
 * @param {string} testYmlContent
 * @param {(scriptName: string) => string} readScriptSource
 * @param {Array<{filename: string, content: string}>} workflowFiles
 * @param {string} jobName
 */
function auditDataValidationGates(testYmlContent, readScriptSource, workflowFiles, jobName = 'data-validation') {
  const jobLines = extractJobLines(testYmlContent, jobName);
  const rawGates = findStrictGateSteps(jobLines);
  const gates = rawGates.map((gate) =>
    evaluateGate(gate, { scriptSource: readScriptSource(gate.script), workflowFiles })
  );
  return {
    gates,
    violations: gates.filter((g) => !g.compliant),
  };
}

/**
 * BRO-3535: the same "every strict/gated audit needs a heal path" contract,
 * applied to scripts/check-corpus-drift.js's `AUDITS` array — the destination
 * for gates moved out of test.yml's blocking data-validation job. Text-scanning
 * check-corpus-drift.js's source the way findStrictGateSteps() scans YAML
 * would be unreliable (AUDITS entries are multi-line JS object literals with
 * no stable comment-adjacency convention — a `//` comment could belong to the
 * entry above or below it), so this reads the array as DATA (already
 * `require()`d and passed in) rather than re-parsing source text, and reuses
 * `evaluateGate()` unchanged as the shared evaluator.
 *
 * Unlike test.yml's --strict/--gate text filter, AUDITS entries can't be
 * scoped by flag alone: ~20 pre-existing entries here are permanent, by-design
 * MONITOR-mode audits (no --strict/--gate at all, e.g. `false-balance`,
 * `aggregator-truth`) or the already-correctly-split FULL companion to a
 * narrower test.yml gate (e.g. `review-contamination` --strict here is
 * intentionally the exhaustive report, never meant to need its own heal
 * path — the narrow catastrophe floor in test.yml is the thing that's gated).
 * Requiring a heal path from all of them fails the ratchet on ~18
 * pre-existing, working-as-designed entries with no actionable fix. So this
 * only evaluates entries opted in via `healPathRequired: true` — the set
 * MOVED here from test.yml's blocking gate (BRO-3535), where a heal path was
 * already a real requirement before the move. A future PR moving MORE gates
 * here should mark them the same way.
 *
 * @param {Array<{name: string, script: string, args?: string[], healExempt?: string, healPathRequired?: boolean}>} audits
 * @param {(scriptName: string) => string} readScriptSource
 * @param {Array<{filename: string, content: string}>} workflowFiles
 */
function auditCorpusDriftGates(audits, readScriptSource, workflowFiles) {
  const rawGates = (audits || [])
    .filter((a) => a.healPathRequired)
    .map((a) => ({
      script: a.script.replace(/\.js$/, ''),
      flags: (a.args || []).join(' '),
      healExemptReason: a.healExempt || null,
    }));
  const gates = rawGates.map((gate) =>
    evaluateGate(gate, { scriptSource: readScriptSource(gate.script), workflowFiles })
  );
  return {
    gates,
    violations: gates.filter((g) => !g.compliant),
  };
}

module.exports = {
  extractJobLines,
  findStrictGateSteps,
  hasBaselineDiffPath,
  hasScheduledFixWorkflow,
  evaluateGate,
  auditDataValidationGates,
  auditCorpusDriftGates,
};
