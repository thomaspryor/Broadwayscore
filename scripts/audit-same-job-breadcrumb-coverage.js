#!/usr/bin/env node
/**
 * Advisory guard (BRO-250 / Notion 3b9637c5): flag scripts that clear a
 * PROTECTED_FIELDS field via safeWriteReview(..., {force: true}) — delete or
 * null it — without a matching scripts/lib/review-write-guard.js
 * CLEAR_BREADCRUMBS entry, when that script runs in a CI job that ALSO calls
 * push-review-texts later.
 *
 * Same bug class fixed reactively three times now: task #97
 * (staleScoredBeforeOpening, strip-stale-single-model-scores.js --before-
 * opening, opening-night-express.yml), task #1237 (fullTextWrongAuthor,
 * apply-audit-flags.js, rebuild-reviews.yml), task #1259 (stuckRescoreCleared,
 * audit-stuck-rescore-flags.js --fix, enrich-reviews.yml). The shape: the
 * clearing script writes locally (uncommitted) against a checkout taken
 * BEFORE it ran; push-review-texts's restore step later in the SAME job
 * compares local vs committed HEAD and treats the now-empty field as data
 * loss, resurrecting it — unless review-write-guard.js's isIntentionalClear()
 * recognizes a breadcrumb the script also stamped. Each instance above was
 * only caught by a human noticing symptoms (stuck queues, resurrected flags)
 * months later; this script is the mechanical check that ties "clears field X
 * in a same-job-as-restore script" to "CLEAR_BREADCRUMBS has an entry for X."
 *
 * This is a heuristic, not a parser — false positives AND false negatives are
 * expected (same disclaimer as scripts/audit-run-budget-coverage.js, whose
 * job/step YAML parser this script's is a trimmed copy of — consistent with
 * that file's own precedent of duplicating the parser locally rather than
 * factoring a shared lib, which audit-workflow-hygiene.js and
 * audit-workflow-concurrency.js also do independently).
 *
 * Non-blocking by design: always exits 0. Wired into test.yml's Lint
 * Workflows job as advisory, per the Notion card's own sequencing ("wire in
 * non-blocking first, promote to blocking once the backlog it surfaces is
 * drained").
 *
 * Exemption (add anywhere in the workflow YAML):
 *   # breadcrumb-coverage-ok: <reason>
 *
 * No external deps. Parsed with plain regex + brace-matching.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const SCRIPTS_DIR = path.join(__dirname);
const ANNOTATION = 'breadcrumb-coverage-ok';
const PUSH_REVIEW_TEXTS_RE = /uses:\s*\.\/\.github\/actions\/push-review-texts/;
const SCRIPT_INVOCATION_RE = /\bnode\s+scripts\/([A-Za-z0-9_\-/]+\.js)/g;
// How far back a delete/null of a field can be attributed to a given
// safeWriteReview(..., {force:true}) call. Every real call site found in this
// repo (grep `safeWriteReview(.*force: *true` across scripts/*.js) stamps and
// clears fields within a few lines of the call — 3000 chars is generous
// headroom while still stopping short of bleeding into an unrelated function
// earlier in a large file like rebuild-all-reviews.js.
const CLEAR_LOOKBACK_CHARS = 3000;

// KEEP IN SYNC with .github/actions/push-review-texts/action.yml's own
// ACTION_EXTRA array (adversarial ship-check review, 2026-08-14): fields
// intentionally excluded from review-write-guard.js's PROTECTED_FIELDS
// because clearFailureFlags() clears them on a SUCCESS path, but which the
// push-review-texts action still restores at push time (unions them with
// PROTECTED_FIELDS before its own restore loop). A force:true clear of one of
// these with no CLEAR_BREADCRUMBS entry is exactly the same bug class this
// script exists to catch — importing only PROTECTED_FIELDS made it
// structurally blind to this set.
const ACTION_EXTRA_PROTECTED = [
  'serpRetryCount',
  'serpDiscoveryAbandoned',
  'rescoreBlockedReason',
  'rescoreBlockedAt',
  'rescoreBlockedTextLength',
  'rescoreBlockedHadExcerpt',
];

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;

/** Direct (one-level-deeper) non-blank child lines of the header at `startIdx`. */
function directChildren(lines, startIdx) {
  const headerIndent = indentOf(lines[startIdx]);
  let childIndent = null;
  const out = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const ind = indentOf(line);
    if (ind <= headerIndent) break;
    if (childIndent === null) childIndent = ind;
    if (ind === childIndent) out.push({ idx: i, line });
  }
  return out;
}

/** Split a job's `steps:` list into per-step {bodyText}, in step order. */
function getStepBlocks(lines, jobHeaderIdx) {
  const stepsEntry = directChildren(lines, jobHeaderIdx).find((c) => /^steps\s*:/.test(c.line.trim()));
  if (!stepsEntry) return [];
  const stepHeaders = directChildren(lines, stepsEntry.idx);
  const jobHeaderIndent = indentOf(lines[jobHeaderIdx]);
  let stepsEnd = lines.length;
  for (let i = stepsEntry.idx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= jobHeaderIndent) { stepsEnd = i; break; }
  }
  return stepHeaders.map((h, i) => {
    const endIdx = i + 1 < stepHeaders.length ? stepHeaders[i + 1].idx : stepsEnd;
    return { bodyText: lines.slice(h.idx, endIdx).join('\n') };
  });
}

/** Split the `jobs:` block into per-job {name, steps}. */
function getJobBlocks(raw) {
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l) && indentOf(l) === 0);
  if (jobsIdx === -1) return [];
  const jobHeaders = directChildren(lines, jobsIdx);
  let jobsEnd = lines.length;
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= indentOf(lines[jobsIdx])) { jobsEnd = i; break; }
  }
  return jobHeaders.map((h, i) => {
    const name = h.line.trim().replace(/:.*$/, '');
    return { name, steps: getStepBlocks(lines, h.idx) };
  });
}

/**
 * Index of the char matching src[openIdx] ('(' → matching ')'), skipping over
 * '...'/"..."/`...` string literals and //, /* comments so a stray paren
 * inside a string or comment can't desync the depth count.
 */
function findMatchingParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length + 1 : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j++;
        j++;
      }
      i = j;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Split a call's argument text on TOP-LEVEL commas only — depth-aware so a
 * first argument like `path.join(showDir, file)` isn't mistaken for two
 * arguments (adversarial ship-check review, 2026-08-14: the earlier `[^,]+`
 * regex for the first argument silently produced zero matches on exactly this
 * shape, live at 7 of rebuild-all-reviews.js's 16 safeWriteReview(force:true)
 * call sites).
 */
function splitTopLevelArgs(argsText) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < argsText.length && argsText[i] !== quote) {
        if (argsText[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(argsText.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(argsText.slice(start));
  return parts;
}

/**
 * Find safeWriteReview(..., {force: true}) call sites in `src`, and for each
 * one, the PROTECTED fields cleared via `delete dataVar.field` or
 * `dataVar.field = <empty value>` in the source immediately preceding the
 * call (bounded by CLEAR_LOOKBACK_CHARS or the previous call site, whichever
 * is closer — so two unrelated force:true calls in the same file, e.g.
 * rebuild-all-reviews.js's many sites, don't cross-attribute each other's
 * clears — verified against the real corpus: findForceTrueClearSites on
 * rebuild-all-reviews.js's ~4700 lines correctly resolves 5 separate call
 * sites to their own local fields with zero cross-contamination).
 *
 * "Empty value" here deliberately mirrors review-write-guard.js's own
 * _isEmptyValue (undefined/null/''/[]) — the SAME definition the restore
 * step's data-loss check uses (isEmpty in restore-protected-fields.js /
 * .github/actions/push-review-texts/action.yml). `false` and `0` are
 * intentionally NOT treated as clears: a write of `field = false` is not
 * "empty" under that shared definition, so the restore step never resurrects
 * it regardless of CLEAR_BREADCRUMBS — e.g. rebuild-all-reviews.js's
 * `d.wrongProduction = false` auto-clear passes straight through the
 * restore's own data-loss check unaffected, breadcrumb or not (the
 * *deletions* alongside it, like wrongProductionNote, ARE `delete`s and are
 * still caught below).
 *
 * @returns {{ fields: string[], line: number }[]}
 */
function findForceTrueClearSites(src, protectedFieldsSet) {
  const callNameRe = /safeWriteReview\s*\(/g;
  const sites = [];
  let lastMatchEnd = 0;
  let m;
  while ((m = callNameRe.exec(src)) !== null) {
    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingParen(src, openParenIdx);
    if (closeParenIdx === -1) continue;
    const args = splitTopLevelArgs(src.slice(openParenIdx + 1, closeParenIdx));
    const dataVarMatch = args.length >= 2 && args[1].trim().match(/^([A-Za-z_$][\w$]*)$/);
    const hasForceTrue = args.length >= 3 && /\bforce\s*:\s*true\b/.test(args[2]);
    if (!dataVarMatch || !hasForceTrue) { lastMatchEnd = closeParenIdx + 1; continue; }
    const dataVar = dataVarMatch[1];
    const callIdx = m.index;
    const windowStart = Math.max(lastMatchEnd, callIdx - CLEAR_LOOKBACK_CHARS, 0);
    const window = src.slice(windowStart, callIdx);
    const cleared = new Set();
    const deleteRe = new RegExp(`delete\\s+${dataVar}\\.([A-Za-z_$][\\w$]*)`, 'g');
    let dm;
    while ((dm = deleteRe.exec(window)) !== null) cleared.add(dm[1]);
    // null/undefined, or empty string/array literal — matches _isEmptyValue.
    const emptyRe = new RegExp(`\\b${dataVar}\\.([A-Za-z_$][\\w$]*)\\s*=\\s*(?:null|undefined|''|""|\`\`|\\[\\s*\\])`, 'g');
    let nm;
    while ((nm = emptyRe.exec(window)) !== null) cleared.add(nm[1]);
    const fields = [...cleared].filter((f) => protectedFieldsSet.has(f));
    if (fields.length > 0) {
      const line = src.slice(0, callIdx).split('\n').length;
      sites.push({ fields, line });
    }
    lastMatchEnd = closeParenIdx + 1;
  }
  return sites;
}

/**
 * Scan every workflow for a job that (a) contains a push-review-texts step
 * and (b) runs a scripts/*.js invocation in an EARLIER step that force:true-
 * clears a PROTECTED field with no CLEAR_BREADCRUMBS entry.
 *
 * @returns {{ gaps: object[], scanned: { workflows: number, jobs: number, scripts: Set<string> } }}
 */
function auditRepo({ workflowDir, scriptsDir, protectedFields, breadcrumbKeys }) {
  const protectedSet = new Set(protectedFields);
  const files = fs.existsSync(workflowDir)
    ? fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort()
    : [];

  const scriptCache = new Map(); // scriptPath -> clear sites
  const gaps = [];
  const scanned = { workflows: files.length, jobs: 0, scripts: new Set() };

  for (const file of files) {
    const raw = fs.readFileSync(path.join(workflowDir, file), 'utf8');
    if (raw.includes(`${ANNOTATION}:`)) continue;

    for (const job of getJobBlocks(raw)) {
      // LAST occurrence, not first: some jobs call push-review-texts twice
      // (e.g. opening-night-express.yml — once after gather, once after
      // scoring). A clear between the two restores is still at risk from the
      // SECOND one, so every step before the LAST restore is in scope.
      let pushIdx = -1;
      job.steps.forEach((s, i) => { if (PUSH_REVIEW_TEXTS_RE.test(s.bodyText)) pushIdx = i; });
      if (pushIdx === -1) continue; // job never restores in-line — not the same-job risk shape
      scanned.jobs++;

      const scripts = new Set();
      for (const step of job.steps.slice(0, pushIdx)) {
        for (const sm of step.bodyText.matchAll(SCRIPT_INVOCATION_RE)) scripts.add(sm[1]);
      }

      for (const script of scripts) {
        const scriptPath = path.join(scriptsDir, script);
        if (!fs.existsSync(scriptPath)) continue;
        scanned.scripts.add(script);
        if (!scriptCache.has(scriptPath)) {
          const src = fs.readFileSync(scriptPath, 'utf8');
          scriptCache.set(scriptPath, findForceTrueClearSites(src, protectedSet));
        }
        for (const site of scriptCache.get(scriptPath)) {
          for (const field of site.fields) {
            if (!breadcrumbKeys.has(field)) {
              gaps.push({ workflow: file, job: job.name, script, field, line: site.line });
            }
          }
        }
      }
    }
  }

  // Dedupe by (script, field) — the same script can be invoked by more than
  // one workflow/job, and each occurrence would otherwise repeat the gap.
  const seen = new Set();
  const deduped = gaps.filter((g) => {
    const key = `${g.script}::${g.field}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { gaps: deduped, scanned };
}

function main() {
  // Non-blocking is a hard contract (test.yml's step has no continue-on-error
  // — see header). An uncaught exception here (a review-write-guard.js
  // require failure, an unanticipated workflow YAML shape) must not fail the
  // "Lint Workflows" job (adversarial ship-check review, 2026-08-14).
  try {
    const { PROTECTED_FIELDS, CLEAR_BREADCRUMBS } = require('./lib/review-write-guard');
    const breadcrumbKeys = new Set(Object.keys(CLEAR_BREADCRUMBS));

    const { gaps, scanned } = auditRepo({
      workflowDir: WORKFLOW_DIR,
      scriptsDir: SCRIPTS_DIR,
      protectedFields: [...PROTECTED_FIELDS, ...ACTION_EXTRA_PROTECTED],
      breadcrumbKeys,
    });

    if (gaps.length === 0) {
      console.log(`✅ Same-job breadcrumb coverage guard: no gaps flagged (${scanned.jobs} push-review-texts job(s), ${scanned.scripts.size} script(s) scanned).`);
      return;
    }

    console.log('⚠️  Same-job breadcrumb coverage guard — force:true PROTECTED-field clears with no CLEAR_BREADCRUMBS entry:\n');
    console.log('These scripts run in a job that also calls push-review-texts LATER — its restore step reads');
    console.log('committed HEAD (checked out before the script ran) and will resurrect the field it just cleared.');
    console.log('Same bug class fixed reactively 3 times already (#97, #1237, #1259). See scripts/lib/review-write-guard.js.\n');
    console.log('This is advisory (heuristic, non-blocking) — verify manually before fixing.\n');
    for (const g of gaps) {
      console.log(`  • ${g.workflow} :: job "${g.job}" → scripts/${g.script}:${g.line} clears "${g.field}" with no CLEAR_BREADCRUMBS entry`);
    }
    console.log(`\nFix: register a CLEAR_BREADCRUMBS[field] predicate in scripts/lib/review-write-guard.js (see`);
    console.log(`staleScoredBeforeOpening / fullTextWrongAuthor / stuckRescoreCleared for the pattern), and make sure`);
    console.log(`the breadcrumb field(s) it reads are themselves in PROTECTED_FIELDS so they survive a rebase.`);
    console.log(`Exempt (false positive): add  # ${ANNOTATION}: <reason>  anywhere in the workflow file.\n`);
    // Advisory only — never fails CI (see header).
  } catch (e) {
    console.warn(`[audit-same-job-breadcrumb-coverage] non-fatal error: ${e.message} — advisory only, not failing CI.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getJobBlocks,
  getStepBlocks,
  findForceTrueClearSites,
  auditRepo,
  main,
  PUSH_REVIEW_TEXTS_RE,
  SCRIPT_INVOCATION_RE,
  ANNOTATION,
  ACTION_EXTRA_PROTECTED,
};
