/**
 * always-commit-after-validate.js (BRO-5293) — pure decision logic.
 *
 * Finds workflow jobs where a step that runs scripts/validate-data.js is
 * followed by a commit/push step that still runs after that validation FAILED
 * (`if: always()` / `failure()` / `!cancelled()`, or any commit step when the
 * validate step itself is `continue-on-error: true` / `|| true`), never looks
 * at the validate step's outcome, and stages data/ files. That shape publishes
 * data validate-data.js rejected. BRO-3511 fixed generate-theater-tips.yml by
 * giving the validate step an id and gating the protected `git add` on
 * VALIDATE_OUTCOME (= steps.validate.outcome); that form passes here.
 *
 * Many always() commits are intentional (partial scrape progress). Annotate the
 * commit step (inside it, or on the comment lines directly above it) with
 * `# always-commit-ok: <reason>` to exempt it.
 *
 * Line-based parser, same approach as the other workflow audits (the repo has
 * no YAML dependency): jobs are keys at indent 2 under `jobs:`, steps are list
 * items under a job's `steps:` key.
 */
'use strict';

// An actual invocation, not a mention in an echo/comment.
const VALIDATE_RE = /\bnode\s+(?:[\w./-]*\/)?validate-data\.js\b/;
const INLINE_HANDLED_RE = /\bif\s+node\s+(?:[\w./-]*\/)?validate-data\.js\b/;
// A non-zero exit inside the step (e.g. the else branch of an inline if).
const HARD_EXIT_RE = /\bexit\s+(?:[1-9]|"?\$)/;

/**
 * True when the shell text really runs validate-data.js: a command segment
 * (split on && || ; |) that is not an echo/printf message mentioning it.
 */
function invokesValidate(text) {
  for (const line of String(text).split('\n')) {
    for (const seg of line.split(/&&|\|\||[;|]/)) {
      const t = seg.trim().replace(/^(?:-\s+)?(?:run:\s*)?/, '');
      if (/^(?:echo|printf)\b/.test(t)) continue;
      if (VALIDATE_RE.test(t)) return true;
    }
  }
  return false;
}
const ALWAYS_IF_RE = /\b(?:always|failure)\s*\(\s*\)|!\s*cancelled\s*\(\s*\)/;
const EXEMPT_RE = /#\s*always-commit-ok:\s*\S/;
const COMMIT_RE = /\bgit\s+(?:commit|push)\b|push-with-retry\.sh\b/;

const indentOf = (l) => l.length - l.trimStart().length;
const isComment = (l) => l.trimStart().startsWith('#');

/** Split workflow text into jobs: [{ name, steps: [{ name, id, startLine, lines, leadComments }] }]. */
function parseJobs(text) {
  const lines = String(text).split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*(?:#.*)?$/.test(l));
  if (jobsIdx === -1) return [];
  const jobs = [];
  let job = null;
  let stepsIndent = -1; // indent of the job's `steps:` key, -1 when not inside it
  let step = null;
  const closeStep = (end) => {
    if (!step) return;
    step.lines = lines.slice(step.startLine, end);
    // Trailing comment lines at the step-marker indent belong to the NEXT
    // step's lead comments; deeper-indented ones stay in this step's body.
    const last = () => step.lines[step.lines.length - 1];
    while (step.lines.length > 1 && (last().trim() === '' || (isComment(last()) && indentOf(last()) <= step.markerIndent))) step.lines.pop();
    const body = step.lines.filter((l) => !isComment(l));
    const nm = body.join('\n').match(/^\s*(?:- )?name:\s*(.+?)\s*$/m);
    step.name = nm ? nm[1].replace(/^['"]|['"]$/g, '') : '(unnamed)';
    const id = body.join('\n').match(/^\s*(?:- )?id:\s*['"]?([\w-]+)['"]?\s*$/m);
    step.id = id ? id[1] : null;
    job.steps.push(step);
    step = null;
  };
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || isComment(l)) continue;
    const ind = indentOf(l);
    if (ind === 0) { closeStep(i); break; } // left the jobs: map
    if (ind === 2) {
      closeStep(i);
      const m = l.match(/^ {2}([\w-]+)\s*:/);
      job = m ? { name: m[1], steps: [] } : null;
      if (job) jobs.push(job);
      stepsIndent = -1;
      continue;
    }
    if (!job) continue;
    if (stepsIndent === -1) {
      if (/^\s*steps\s*:\s*$/.test(l)) stepsIndent = ind;
      continue;
    }
    if (ind <= stepsIndent && !/^\s*- /.test(l)) { closeStep(i); stepsIndent = /^\s*steps\s*:\s*$/.test(l) ? ind : -1; continue; }
    if (/^\s*- /.test(l) && ind >= stepsIndent && ind <= stepsIndent + 2) {
      closeStep(i);
      // Comment lines directly above the step marker (annotation slot).
      const lead = [];
      for (let k = i - 1; k > jobsIdx && (lines[k].trim() === '' || isComment(lines[k])); k--) {
        if (lines[k].trim() === '') break;
        if (indentOf(lines[k]) > ind) break; // belongs to the previous step's body
        lead.unshift(lines[k]);
      }
      step = { startLine: i, markerIndent: ind, leadComments: lead };
    }
  }
  closeStep(lines.length);
  return jobs;
}

/**
 * The step's `if:` expression, or ''. A block scalar (`if: >-`, `if: |`, ...)
 * or a value continued on more-indented lines is joined into one expression.
 */
function stepIf(step) {
  const lines = step.lines;
  for (let i = 0; i < lines.length; i++) {
    if (isComment(lines[i])) continue;
    const m = lines[i].match(/^(\s*)(?:- )?if:\s*(.*?)\s*$/);
    if (!m) continue;
    const keyIndent = indentOf(lines[i]) + (lines[i].trimStart().startsWith('- ') ? 2 : 0);
    const parts = /^[|>][+-]?\d*$/.test(m[2]) ? [] : [m[2]];
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k];
      if (l.trim() === '') continue;
      if (indentOf(l) <= keyIndent) break;
      if (!isComment(l)) parts.push(l.trim());
    }
    return parts.join(' ').trim();
  }
  return '';
}

/** Non-comment shell lines, with `\` continuations joined. */
function shellText(step) {
  return step.lines.filter((l) => !isComment(l)).join('\n').replace(/\\\n\s*/g, ' ');
}

/**
 * Data files validate-data.js reads (and so "protects"): a commit of one of
 * these after validation failed publishes data the validator rejected. Several
 * are gitignored core data in this repo (they reach the private repo through
 * push-core-data, which already refuses via validate-data.js's
 * ${RUNNER_TEMP}/.skip-push-core-data sentinel); listing them is harmless.
 * theater-metadata.json is not read by validate-data.js itself but BRO-3511
 * gated it on the validate outcome, so it is treated as protected too.
 */
const PROTECTED_FILES = [
  'shows.json', 'reviews.json', 'grosses.json', 'grosses-history.json', 'show-schedules.json',
  'commercial.json', 'actor-images.json', 'awards.json', 'awards-confirmed-ties.json',
  'critic-consensus.json', 'lottery-rush.json', 'outlet-registry.json', 'outlet-tiers.json',
  'tony-nominations.json', 'audience-buzz.json', 'todaytix-showtimes.json', 'image-sources.json',
  'retired-show-ids.json', 'theater-metadata.json',
];
const PROTECTED_DIRS = ['review-texts', 'cast', 'aggregator-archive'];
// Composite actions that commit protected data. push-core-data is NOT listed:
// it reads the validate-data.js refusal sentinel and skips on failure.
const PROTECTED_PUSH_ACTIONS = {
  'push-review-texts': 'data/review-texts/',
  'push-aggregator-archive': 'data/aggregator-archive/',
};

const STAGE_CMD_RE = /\b(?:git\s+add|git-add-existing\.sh|git-add-safe\.sh|stage-data-changes\.sh)\b(.*)/;

/** Which protected path a single `git add`-style operand stages, or null. */
function protectedOperand(arg) {
  const a = arg.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
  if (a === 'data' || a === 'data/' || a === 'data/*' || a === 'data/*.json') return a;
  if (!a.startsWith('data/')) return null;
  const rest = a.slice(5).replace(/\/+$/, '');
  if (PROTECTED_FILES.includes(rest)) return a;
  const top = rest.split('/')[0];
  if (PROTECTED_DIRS.includes(top)) return a;
  return null;
}

/**
 * Protected data paths a step's shell text stages (deduped), [] when none.
 * Every stage command on a line is considered (`git add a && git add b`).
 * Whole-tree adds (`git add -A` / `.` / `--all`, or `-u`/`--update` with no
 * pathspec), a bare stage-data-changes.sh (= all of data/), and an operand
 * that is a shell variable (`git add "$FILE"`, paths unknown statically) all
 * count as staging protected data. `${{ }}` expressions are not shell vars.
 */
function protectedStaged(text) {
  const out = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s#.*$/, '').replace(/\$\{\{[^}]*\}\}/g, 'EXPR');
    for (const seg of line.split(/&&|\|\||[;|]/)) {
      const m = seg.match(STAGE_CMD_RE);
      if (!m) continue;
      const isStageData = /stage-data-changes\.sh/.test(m[0]);
      const args = m[1].trim().split(/\s+/).filter(Boolean)
        .filter((a) => !/^\d?>/.test(a) && a !== '/dev/null');
      const flags = args.filter((a) => a.startsWith('-') && a !== '--');
      const paths = args.filter((a) => !a.startsWith('-'));
      if (isStageData && paths.length === 0) { out.add('data/ (stage-data-changes.sh)'); continue; }
      if (!isStageData && paths.length === 0 && flags.some((a) => a === '-A' || a === '--all')) { out.add('-A (whole tree)'); continue; }
      if (!isStageData && paths.length === 0 && flags.some((a) => a === '-u' || a === '--update')) { out.add('-u (all tracked files)'); continue; }
      if (!isStageData && paths.length === 1 && paths[0] === '.') { out.add('. (whole tree)'); continue; }
      for (const a of paths) {
        const p = protectedOperand(a);
        if (p) out.add(p);
        else if (/\$/.test(a)) out.add(`${a.replace(/^['"]|['"]$/g, '')} (unknown paths)`);
      }
    }
  }
  return [...out];
}

/** Back-compat boolean form. */
const stagesData = (text) => protectedStaged(text).length > 0;

/** For a `uses:` step, the protected data path its composite action commits, or null. */
function protectedAction(step) {
  for (const l of step.lines) {
    const m = l.match(/^\s*(?:- )?uses:\s*\.\/\.github\/actions\/([\w-]+)/);
    if (m && PROTECTED_PUSH_ACTIONS[m[1]]) return { action: m[1], path: PROTECTED_PUSH_ACTIONS[m[1]] };
  }
  return null;
}

/** True when the validate step's own failure does not fail the job. */
function validateIsSoft(step) {
  const t = shellText(step);
  if (step.lines.some((l) => /^\s*(?:- )?continue-on-error:\s*true\b/.test(l))) return true;
  return t.split('\n').some((l) => invokesValidate(l) && /\|\|\s*(?:true|:|echo\b)/.test(l));
}

const idRe = (id) => id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/**
 * Ids whose result, if the commit step reads it, counts as consulting
 * validation: every validate step, plus any later "gate" step that itself reads
 * a validate step's outcome/outputs (update-show-status.yml's commit-gate).
 */
function guardIds(stepsBefore, validates) {
  const ids = new Set(validates.map((v) => v.id).filter(Boolean));
  for (const st of stepsBefore) {
    if (!st.id || ids.has(st.id)) continue;
    const t = st.lines.join('\n');
    for (const id of [...ids]) {
      if (new RegExp(`steps\\.${idRe(id)}\\.(?:outcome|conclusion|outputs)\\b`).test(t)) { ids.add(st.id); break; }
    }
  }
  return ids;
}

/** True when the commit step consults validation (an outcome ref, VALIDATE_OUTCOME-style env, or the refusal sentinel). */
function referencesOutcome(commitStep, ids) {
  const t = commitStep.lines.filter((l) => !isComment(l)).join('\n');
  for (const id of ids) {
    if (new RegExp(`steps\\.${idRe(id)}\\.(?:outcome|conclusion|outputs)\\b`).test(t)) return true;
  }
  return /\bVALIDAT\w*_(?:OUTCOME|RESULT|STATUS|OK)\b|\.skip-push-core-data\b/.test(t);
}

function isExempt(step) {
  return step.lines.concat(step.leadComments || []).some((l) => EXEMPT_RE.test(l));
}

/**
 * Offenders in one workflow's text.
 * Returns [{ job, validateStep, validateLine, commitStep, commitLine, staged, reason }] (lines 1-based).
 */
function findAlwaysCommitAfterValidate(text) {
  const out = [];
  for (const job of parseJobs(text)) {
    const validates = [];
    job.steps.forEach((step, idx) => {
      const body = shellText(step);
      const isCommit = COMMIT_RE.test(body);
      if (invokesValidate(body) && !isCommit) {
        // `if node scripts/validate-data.js; then` handles a failure inline, so
        // the step itself never fails on bad data: not a gate this rule tracks.
        // An inline if whose else branch exits non-zero is still a hard gate.
        if (!INLINE_HANDLED_RE.test(body) || HARD_EXIT_RE.test(body)) validates.push(step);
        return;
      }
      if (!validates.length) return;
      const act = protectedAction(step);
      if (!isCommit && !act) return;
      const staged = act ? [act.path] : protectedStaged(body);
      if (!staged.length) return;
      const last = validates[validates.length - 1];
      const cond = stepIf(step);
      const runsAfterFailure = ALWAYS_IF_RE.test(cond);
      const soft = validateIsSoft(last);
      if (!runsAfterFailure && !soft) return;
      if (isExempt(step) || referencesOutcome(step, guardIds(job.steps.slice(0, idx), validates))) return;
      out.push({
        job: job.name,
        validateStep: last.name,
        validateLine: last.startLine + 1,
        commitStep: step.name,
        commitLine: step.startLine + 1,
        staged,
        reason: runsAfterFailure
          ? `runs on \`if: ${cond}\` without checking the validate step's outcome`
          : 'validate step is soft (continue-on-error / || true) and this step does not check its outcome',
      });
    });
  }
  return out;
}

/** Run over a directory of workflow files. Returns [{ file, ...finding }]. */
// Files that mention validate-data.js but parse to no step: the line parser
// does not understand their layout, so "no finding" would be a silent pass.
function unscannableWorkflows(dir, fs = require('fs'), path = require('path')) {
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  return files.filter((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/validate-data\.js/.test(text)) return false;
    return !parseJobs(text).some((j) => j.steps && j.steps.length);
  });
}

function auditWorkflowDir(dir, fs = require('fs'), path = require('path')) {
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    for (const hit of findAlwaysCommitAfterValidate(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      out.push({ file: f, ...hit });
    }
  }
  return out;
}

module.exports = {
  parseJobs,
  stagesData,
  protectedStaged,
  PROTECTED_FILES,
  PROTECTED_DIRS,
  findAlwaysCommitAfterValidate,
  auditWorkflowDir,
  unscannableWorkflows,
  EXEMPT_RE,
};
