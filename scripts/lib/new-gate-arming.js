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

// ---------------------------------------------------------------------------
// BRO-7949: new hard-fail checks ADDED INSIDE a validator that test.yml runs
// blocking. A new `error(...)` in validate-data.js turns test.yml red and writes
// the .skip-push-core-data sentinel (BRO-7929 near-miss 2026-11-21), exactly like
// a new --strict step, but the step-level audit above never sees it.
// ---------------------------------------------------------------------------

// Validators test.yml runs blocking, and the hard-fail helpers each defines.
const VALIDATORS = {
  'scripts/validate-data.js': ['error', 'reviewFileError', 'reviewRowError', 'exitWithError'],
  'scripts/validate-market-expansion.js': ['error'],
};

// Blank out string/template literals and comments so `error(` inside a message
// or a comment is not mistaken for a call. Line-local (good enough for diffs).
function maskStrings(line) {
  return line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}
// Strings first (so `"https://x"` is not read as a comment), then comments.
function stripLiterals(line) {
  return maskStrings(line).replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

// Number of `name(` calls on a line, for the given helper names.
function countCalls(line, helpers) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return 0;
  const code = stripLiterals(line);
  if (/\bfunction\s+\w+\s*\(/.test(code)) return 0; // definition, not a call
  let n = 0;
  for (const h of helpers) n += (code.match(new RegExp(`(?<![\\w.$])${h}\\s*\\(`, 'g')) || []).length;
  return n;
}

function hardErrorCall(line, helpers) { return countCalls(line, helpers) > 0; }

// Real comment token only (a string literal containing the marker must not count).
function hasProofMarker(line) {
  return /(\/\/|#)\s*gate-arm-ok:\s*\S/.test(maskStrings(line));
}

// Text of a call line with the helper name erased, so warn(`x`) -> error(`x`)
// (the sanctioned advisory -> blocking promotion) pairs with its removed twin.
const HELPER_ANY = /(?<![\w.$])(error|warn|reviewFileError|reviewRowError|exitWithError)\s*\(/;
const norm = l => l.trim().replace(/\s+/g, ' ');

// Parse a unified diff of ONE file into hunks: { added:[], removed:[], all:[] }.
function parseHunks(diff) {
  const hunks = [];
  let cur = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('@@')) { cur = { added: [], removed: [], all: [] }; hunks.push(cur); continue; }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line[0] === '+') { cur.added.push(line.slice(1)); cur.all.push(line.slice(1)); }
    else if (line[0] === '-') cur.removed.push(line.slice(1));
    else if (line[0] === ' ') cur.all.push(line.slice(1));
  }
  return hunks;
}

/**
 * @param {{files:{path:string, diff:string, headText?:string}[], changedFiles:string[], contextTexts?:string[]}} input
 *   contextTexts: head text of other changed scripts/ files (a baseline loaded by a helper lib).
 * @returns {{violations:{file:string, line:string}[]}}
 *
 * A violation = an added hard-fail call that is NET new in its file (rewording or
 * moving an existing call pairs with its removed twin and is not flagged), with
 * no `gate-arm-ok: <proof>` marker in the same hunk and no changed baseline file
 * that the validator (or a changed helper) actually references.
 */
function findUnprovenNewValidatorErrors({ files, changedFiles, contextTexts }) {
  const baselines = (changedFiles || []).filter(isBaselineFile);
  const violations = [];
  for (const f of files || []) {
    const helpers = VALIDATORS[f.path];
    if (!helpers) continue;
    const hunks = parseHunks(f.diff);
    // Pair each added call with a removed twin so rewording/moving is not "new":
    // identical text anywhere in the file first (a move), then any leftover removed
    // call in the SAME hunk (a reword). Unpaired added calls are net-new. The
    // marker must sit on an ADDED line of the same hunk (context lines do not count).
    const added = [];
    const removed = [];
    hunks.forEach((h, i) => {
      const marked = h.added.some(hasProofMarker);
      for (const l of h.removed) {
        const n = countCalls(l, helpers);
        for (let k = 0; k < n; k++) removed.push({ line: norm(l), hunk: i, used: false });
      }
      // removed warn() calls count for promotion pairing only (identical-text pass)
      for (const l of h.removed) if (countCalls(l, ['warn']) > 0) removed.push({ line: norm(l), hunk: i, used: false, warnOnly: true });
      for (const l of h.added) {
        const n = countCalls(l, helpers);
        for (let k = 0; k < n; k++) added.push({ line: norm(l), hunk: i, marked, paired: false });
      }
    });
    const key = (l) => l.replace(HELPER_ANY, '(');
    const pair = (match) => {
      for (const a of added) {
        if (a.paired) continue;
        const r = removed.find(x => !x.used && match(a, x));
        if (r) { r.used = true; a.paired = true; }
      }
    };
    pair((a, r) => a.line === r.line);
    pair((a, r) => key(a.line) === key(r.line)); // warn -> error promotion
    pair((a, r) => !r.warnOnly && a.hunk === r.hunk);
    const unmatched = added.filter(a => !a.paired);
    // A baseline exempts only if the diff itself, or a changed helper file, names it.
    const refText = [f.diff || '', ...(contextTexts || [])].join('\n');
    const baselined = baselines.some(b => refText.includes(b.split('/').pop()));
    for (const a of unmatched) {
      if (a.marked || baselined) continue;
      violations.push({ file: f.path, line: a.line });
    }
  }
  return { violations };
}

module.exports = { parseSteps, stepArmsGate, isBaselineFile, findUnprovenNewGates, findUnprovenNewValidatorErrors, VALIDATORS };
