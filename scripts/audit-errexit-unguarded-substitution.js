#!/usr/bin/env node
/**
 * Advisory guard (task #97, follow-up to #676/#678): flag composite-action
 * steps that can silently crash their whole script under `bash -e`.
 *
 * GitHub Actions runs a composite-action step declared `shell: bash` as
 * `bash --noprofile --norc -e -o pipefail {0}` — errexit is ON. Two shapes
 * of command in that context can exit non-zero for a perfectly legitimate
 * reason, and an unguarded one doesn't just fail its own line — errexit
 * aborts the ENTIRE script immediately, silently defeating whatever
 * multi-attempt retry loop the step was inside:
 *
 *   (1) `VAR=$(...)` — a command substitution assigned to a bare variable.
 *       If the substituted command exits non-zero, the assignment itself
 *       trips errexit (`x=$(false)` kills a `set -e` script even though
 *       `$(false)` alone, unassigned, would not). Real incident: #676's
 *       `DECISION=$(... node -e ...)` rate-limit check crashed the Opening
 *       Night Poller's 5-attempt push-retry loop on iteration 1, almost
 *       every run, for a week — the loop never even got a second attempt.
 *   (2) `git commit --amend` — refuses and exits 1 if the amend would
 *       produce a commit identical to its own parent ("would make it
 *       empty"). This was the ACTUAL #676 crash trigger: post-rebase JSON
 *       reconciliation converging to content already on origin/main.
 *
 * Both were found and fixed reactively, one incident at a time: #676 fixed
 * push-core-data/action.yml; a /what-else pattern-recognition pass on that
 * same session found the identical unguarded `VAR=$(...)` shape in 4 more
 * composite actions (#678) that had NOT yet caused a visible failure
 * streak. This script exists so a 6th instance doesn't need a human to
 * notice a nightly cron dying before it gets fixed.
 *
 * Scope (v1): composite actions only (`.github/actions/<name>/action.yml`)
 * — every real instance so far has been a composite action's push/checkout
 * retry loop, and scoping to this small, high-precision surface (rather
 * than every `shell: bash`
 * step across 200+ top-level workflow files, which default to bash even
 * without an explicit `shell:` key) keeps false positives low without
 * chasing indirection. Extending to `.github/workflows/*.yml` is a known
 * gap, not attempted here — see header note in
 * audit-push-core-data-audit-gap.js for the same scoping tradeoff.
 *
 * Detection, per step block (split on `- name:` boundaries) that contains
 * an explicit `shell: bash` line:
 *   (a) A line matching `VAR=$(` starts a command substitution. Parens are
 *       balance-tracked forward (naive char count, NOT quote-aware — same
 *       "heuristic, not a parser" tradeoff as this repo's other regex-based
 *       audits) until the substitution closes. Flagged only if the
 *       substituted command invokes `node` (word boundary) — matching the
 *       shape of every real incident so far (`node -e`/`node script.js`,
 *       which can throw for an application-logic reason) — AND no `||`
 *       appears anywhere across the whole substitution's span (inside or
 *       after). Deliberately NOT flagging every `VAR=$(...)`: an earlier
 *       draft did, and on this repo's own composite actions it buried the
 *       real signal under ~40 hits on `mktemp`, `date +%s`, `basename`,
 *       arithmetic `$(( ))`, and already-internally-guarded `git`/`jq`/
 *       `python3 ... || echo` calls that don't realistically throw — the
 *       exact noisy-gate failure mode `memory/feedback_test_yml_data_gates_
 *       flap_and_shortcircuit.md` warns about. `node` is the narrow,
 *       precise proxy for "runs arbitrary logic that can fail for a data
 *       reason," not "any subprocess."
 *   (b) A line matching `git commit --amend` (word boundary, so
 *       `--amend --no-edit` etc. all match) is flagged unless the SAME
 *       line contains `--allow-empty` or `|| true` or `|| <ANYTHING>` — any
 *       `||` fallback is accepted, matching how #676/#678 were actually
 *       fixed (`2>/dev/null || true` for cosmetic stderr suppression too).
 *
 * A step with `continue-on-error: true` is exempt from both checks — a
 * failing step there can't take the rest of the job down with it, which is
 * exactly the property (a)/(b) exist to protect.
 *
 * Always exits 0 — advisory only, same posture as
 * audit-push-core-data-audit-gap.js: this needs a period of human-reviewed
 * findings before it's trustworthy enough to fail CI.
 *
 * Exemption (add inside the action.yml file — anywhere):
 *   # hygiene-errexit-guard-ok: <reason>
 *
 * No external deps. Parsed with plain regex/line-scanning, consistent with
 * audit-workflow-hygiene.js / audit-push-core-data-audit-gap.js.
 */
const fs = require('fs');
const path = require('path');

const ACTIONS_DIR = path.join(__dirname, '..', '.github', 'actions');

const ASSIGN_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)=\$\(/;
const AMEND_RE = /\bgit\s+commit\s+--amend\b/;

/** Split an action.yml's raw text into per-step chunks, each starting at a `- name:` line. */
function splitIntoSteps(raw) {
  const lines = raw.split('\n');
  const steps = [];
  let current = null;
  for (const line of lines) {
    if (/^\s*-\s+name:/.test(line)) {
      if (current) steps.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) steps.push(current.join('\n'));
  return steps;
}

function stepName(stepText) {
  const m = stepText.match(/^\s*-\s+name:\s*(.+)$/m);
  return m ? m[1].trim() : '(unnamed step)';
}

/**
 * Scan one step's text for unguarded `VAR=$(...)` assignments whose
 * substituted command invokes `node`. Returns an array of { lineNum, text }
 * for each offender (1-indexed within the step). See header comment for
 * why this is scoped to `node` rather than every command substitution.
 */
function findUnguardedAssignments(stepText) {
  const lines = stepText.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ASSIGN_RE);
    if (!m) continue;
    // `VAR=$((` is arithmetic expansion, not a command substitution — the
    // extra '(' makes ASSIGN_RE's single `\(` match the arithmetic form's
    // first paren, which this check must not treat as a subprocess call.
    if (/=\$\(\(/.test(lines[i])) continue;

    // Balance-track parens forward from the `$(` on this line until they
    // close, across as many lines as needed (the composite actions in this
    // repo commonly embed multi-line `node -e "..."` blocks here).
    let depth = 0;
    let seenOpen = false;
    let closeLineIdx = -1;
    let closeCharIdx = -1;
    outer: for (let j = i; j < lines.length; j++) {
      const startCol = j === i ? lines[j].indexOf('$(') + 1 : 0;
      for (let k = startCol; k < lines[j].length; k++) {
        const ch = lines[j][k];
        if (ch === '(') {
          depth++;
          seenOpen = true;
        } else if (ch === ')') {
          depth--;
          if (seenOpen && depth === 0) {
            closeLineIdx = j;
            closeCharIdx = k;
            break outer;
          }
        }
      }
    }
    if (closeLineIdx === -1) continue; // unbalanced — give up silently, heuristic limitation

    // The full substitution's span, from the `$(` through its matching
    // `)`, plus whatever trails on the closing line — a `||` fallback
    // ANYWHERE in that span (an internal `node ... || echo x`, not just a
    // trailing `) || true`) makes the assignment safe: the substituted
    // command can no longer exit non-zero.
    const spanLines = lines.slice(i, closeLineIdx + 1);
    const span = spanLines.join('\n');
    if (span.includes('||')) continue; // guarded, somewhere

    if (!/\bnode\b/.test(span)) continue; // not the risk class this check targets

    hits.push({ lineNum: i + 1, text: lines[i].trim() });
  }
  return hits;
}

/** Scan one step's text for `git commit --amend` calls with no `||` fallback on the same line. */
function findUnguardedAmends(stepText) {
  const lines = stepText.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!AMEND_RE.test(lines[i])) continue;
    if (lines[i].includes('||') || lines[i].includes('--allow-empty')) continue;
    hits.push({ lineNum: i + 1, text: lines[i].trim() });
  }
  return hits;
}

/** Returns an offender record for `file`, or null if it's clean/exempt/not applicable. */
function checkActionFile(file, raw) {
  if (raw.includes('hygiene-errexit-guard-ok:')) return null;

  const offenders = [];
  for (const stepText of splitIntoSteps(raw)) {
    if (!/^\s*shell:\s*bash\s*$/m.test(stepText)) continue;
    if (/^\s*continue-on-error:\s*true\s*$/m.test(stepText)) continue;

    const assignments = findUnguardedAssignments(stepText);
    const amends = findUnguardedAmends(stepText);
    if (assignments.length === 0 && amends.length === 0) continue;

    offenders.push({ step: stepName(stepText), assignments, amends });
  }

  if (offenders.length === 0) return null;
  return { file, offenders };
}

function main() {
  if (!fs.existsSync(ACTIONS_DIR)) {
    console.log('ℹ️  errexit-unguarded-substitution check: no .github/actions directory — skipping.');
    return;
  }

  const dirs = fs.readdirSync(ACTIONS_DIR).filter((d) => fs.statSync(path.join(ACTIONS_DIR, d)).isDirectory());

  const results = [];
  for (const dir of dirs) {
    const actionFile = path.join(ACTIONS_DIR, dir, 'action.yml');
    if (!fs.existsSync(actionFile)) continue;
    const raw = fs.readFileSync(actionFile, 'utf8');
    const result = checkActionFile(`.github/actions/${dir}/action.yml`, raw);
    if (result) results.push(result);
  }

  if (results.length === 0) {
    console.log(
      `✅ errexit-unguarded-substitution check: no offenders found (${dirs.length} composite action(s) checked, advisory).`,
    );
    return;
  }

  console.log(
    `⚠️  ${results.length} composite action(s) have a command that can silently crash a bash -e step (advisory).\n`,
  );
  console.log('An unguarded `VAR=$(...)` assignment or `git commit --amend` trips errexit on');
  console.log('any non-zero exit, killing the WHOLE script — not just that retry attempt. Real');
  console.log('incident: #676 (Opening Night Poller push-retry loop dead on iteration 1, every');
  console.log('run, for a week). Fix: append `|| true` / `|| VAR=<fallback>` (or `--allow-empty`');
  console.log('for the amend case).\n');
  for (const { file, offenders } of results) {
    console.log(`  • ${file}`);
    for (const { step, assignments, amends } of offenders) {
      console.log(`      step "${step}":`);
      for (const h of assignments) console.log(`        line ${h.lineNum}: ${h.text}`);
      for (const h of amends) console.log(`        line ${h.lineNum}: ${h.text}`);
    }
  }
  console.log(
    '\nExempt (reviewed and deliberately left unguarded): add  # hygiene-errexit-guard-ok: <reason>  anywhere in the file.',
  );
  // Advisory only — never fails the gate. See header comment for why.
}

module.exports = {
  splitIntoSteps,
  stepName,
  findUnguardedAssignments,
  findUnguardedAmends,
  checkActionFile,
};

if (require.main === module) {
  // Advisory-only means "never fails the gate" — that promise only held on
  // the happy path (an unreadable/malformed action.yml would otherwise
  // crash main() with a nonzero exit, silently breaking the guarantee this
  // check exists to keep). Caught here, not per-file, since a scan that hit
  // an unexpected error partway through has an incomplete offender list
  // anyway — better to say so once than print a partial "clean" report.
  try {
    main();
  } catch (err) {
    console.log(`ℹ️  errexit-unguarded-substitution check crashed (advisory, not failing CI): ${err.message}`);
  }
}
