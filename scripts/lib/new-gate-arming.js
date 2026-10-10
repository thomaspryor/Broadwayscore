'use strict';
/**
 * new-gate-arming.js (BRO-2123) — pure decision logic for the "new blocking
 * gates land non-blocking first" rule.
 *
 * Problem: ~15 parallel sessions push straight to main, so a brand-new
 * `--strict`/`--gate` step in test.yml has its FIRST live run on main against
 * a corpus nobody checked. Three reds in one morning (2026-08-16) were this.
 *
 * Rule: a step ADDED to test.yml (name absent from the base version) whose
 * run line carries `--strict` or `--gate` must be one of:
 *   - advisory:   `continue-on-error: true` on the step, OR
 *   - baselined:  the same change touches a baseline file (path matches
 *                 /baseline/i), OR
 *   - proven:     an annotation `# gate-arm-ok: <reason / run proving it clean>`
 *                 inside the step.
 * Promoting an existing advisory step to blocking is NOT flagged (that is the
 * sanctioned second commit); it is only the arming of a new step that is.
 *
 * Wrapper + CLI: scripts/audit-new-gate-arming.js. Tests:
 * tests/unit/lint-workflows.test.mjs.
 */

const ARM_FLAG = /(^|[\s"'=])--(strict|gate)(?![\w-])/;

// Split workflow text into steps: { job, name, text }. A step starts at any
// list item `<indent>- <key>:` that sits at the step indent of the current job
// (first list item under a `steps:` key sets that indent); a dedent below it
// ends the step. `job` is the last 2-space-indented `key:` seen under `jobs:`.
function parseSteps(text) {
  const steps = [];
  let job = '';
  let stepsIndent = -1;
  let cur = null;
  const flush = () => { if (cur) steps.push(cur); cur = null; };
  for (const line of String(text || '').split('\n')) {
    const jm = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (jm) { flush(); job = jm[1]; stepsIndent = -1; continue; }
    const sm = line.match(/^(\s*)steps:\s*$/);
    if (sm) { flush(); stepsIndent = -2; continue; }
    const im = line.match(/^(\s*)- (\S.*)$/);
    if (stepsIndent === -2 && im) stepsIndent = im[1].length;
    if (im && im[1].length === stepsIndent) {
      flush();
      const nm = im[2].match(/^name:\s*(.*)$/);
      cur = { job, name: nm ? nm[1].trim().replace(/^["']|["']$/g, '') : null, lines: [line] };
      continue;
    }
    if (cur) {
      const ind = line.match(/^(\s*)\S/);
      if (ind && ind[1].length < stepsIndent) { flush(); continue; }
      cur.lines.push(line);
    }
  }
  flush();
  return steps.map(s => {
    const text = s.lines.join('\n');
    // Unnamed steps (`- run:`/`- uses:` first, or `name:` further down) are
    // keyed by their first run line so they cannot bypass the check.
    let name = s.name;
    if (name === null) {
      const nm = text.match(/^\s+name:\s*(.+)$/m);
      const rm = text.match(/run:\s*(\S.*)$/m);
      name = nm ? nm[1].trim() : rm ? `run: ${rm[1].trim()}` : text.split('\n')[0].trim();
    }
    return { job: s.job, name, key: `${s.job}::${name}`, text };
  });
}

function stepArmsGate(stepText) {
  const runLines = stepText.split('\n').filter(l => !/^\s*#/.test(l));
  return runLines.some(l => ARM_FLAG.test(l));
}

// Normalised arming run lines, so a rename/move of an existing blocking step is
// not mistaken for a new gate (review 2026-10-05).
function armingRunLines(stepText) {
  return stepText.split('\n').filter(l => !/^\s*#/.test(l) && ARM_FLAG.test(l)).map(l => l.trim().replace(/\s+/g, ' '));
}

function isBaselineFile(p) {
  return /baseline/i.test(p);
}

// A changed baseline file only exempts the step it belongs to: the step text
// names the file, or the file's stem extends a script stem the step runs
// (audit-foo.js <-> audit-foo-baseline.json). An unrelated session's baseline
// commit in the same push range must not disarm the check (review 2026-10-05).
function baselineBelongsToStep(stepText, baselinePath) {
  const base = baselinePath.split('/').pop();
  if (stepText.includes(base) || stepText.includes(baselinePath)) return true;
  const stem = base.replace(/[-_.]?baseline.*$/i, '').replace(/\.[a-z]+$/i, '');
  return stem.length > 3 && new RegExp(`scripts/${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[a-z]+`).test(stepText);
}

/**
 * @param {{baseText:string, headText:string, changedFiles:string[]}} input
 * @returns {{violations:{name:string, job:string}[]}}
 */
function findUnprovenNewGates({ baseText, headText, changedFiles }) {
  const baseSteps = parseSteps(baseText);
  const baseKeys = new Set(baseSteps.map(s => s.key));
  const baseArmLines = new Set(baseSteps.flatMap(s => armingRunLines(s.text)));
  const baselines = (changedFiles || []).filter(isBaselineFile);
  const violations = [];
  for (const step of parseSteps(headText)) {
    if (baseKeys.has(step.key)) continue;
    if (!stepArmsGate(step.text)) continue;
    if (armingRunLines(step.text).every(l => baseArmLines.has(l))) continue; // renamed/moved, not new
    if (/^\s*continue-on-error:\s*true\b/m.test(step.text)) continue;
    if (/#\s*gate-arm-ok:\s*\S/.test(step.text)) continue;
    if (baselines.some(b => baselineBelongsToStep(step.text, b))) continue;
    violations.push({ name: step.name, job: step.job });
  }
  return { violations };
}

module.exports = { parseSteps, stepArmsGate, isBaselineFile, findUnprovenNewGates };
