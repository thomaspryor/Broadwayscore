#!/usr/bin/env node
/**
 * Advisory guard (#425): flag BD/SB-dependent cron scripts that plausibly need
 * scripts/lib/run-budget.js but don't have it.
 *
 * Same bug class fixed reactively three times now (#369 scrape-westendtheatre,
 * #415 scrape-lbo-audience, #421 seven more): a scheduled GitHub Actions job
 * with a tight timeout-minutes, Bright Data / ScrapingBee credentials, and an
 * unbounded per-item loop with no wall-clock budget check gets SIGKILLed
 * mid-run instead of exiting cleanly. See scripts/lib/run-budget.js header.
 *
 * Rule (only applies to SCHEDULED workflows — a workflow_dispatch-only job is
 * invoked with an explicit, human-sized input, not a growing backlog, so the
 * run-budget class of bug doesn't apply the same way):
 *   For each job with `timeout-minutes` <= 35 whose body references
 *   BRIGHTDATA_TOKEN or SCRAPINGBEE_API_KEY, for each `node scripts/X.js`
 *   it invokes: if X.js requires scripts/lib/run-budget, pass. Otherwise,
 *   heuristically look for a for/while loop whose body calls a network
 *   helper (fetchPage/fetch/fetchXxx/scraperFetchJSON/httpsGet, one level of
 *   indirection through a helper function) — if found, WARN.
 *
 * This is a heuristic, not a parser — false positives AND false negatives
 * are expected. It intentionally does NOT chase indirection beyond one
 * helper-function hop, and treats any loop whose header bounds the iterable
 * with `.slice(` as deliberately bounded (safe). Known-safe cases that still
 * trip it get an explicit exemption rather than a smarter heuristic — see
 * annotation below.
 *
 * Non-blocking by design (unlike the (a)/(b)/(c) rules in
 * audit-workflow-hygiene.js): always exits 0. #421's audit found several
 * LOW-RISK/ALREADY-SAFE scripts that a naive heuristic would flag; this
 * needs a period of human-reviewed warnings before it's trustworthy enough
 * to fail CI.
 *
 * Exemption (add inside the workflow YAML — anywhere in the file):
 *   # hygiene-run-budget-ok: <reason>
 *
 * No external deps. Parsed with plain regex + brace-matching, consistent
 * with audit-workflow-hygiene.js / audit-workflow-concurrency.js.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const SCRIPTS_DIR = path.join(__dirname);
const MAX_TIMEOUT_MIN = 35;
const BD_SB_TOKENS = ['BRIGHTDATA_TOKEN', 'SCRAPINGBEE_API_KEY'];
const ANNOTATION = 'hygiene-run-budget-ok';
const NETWORK_CALL_RE = /\b(?:await\s+)?(?:fetch\w*|scraperFetchJSON|httpsGet)\s*\(/;

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

function hasScheduleTrigger(raw) {
  const lines = raw.split('\n');
  const onIdx = lines.findIndex((l) => /^['"]?on['"]?\s*:/.test(l) && indentOf(l) === 0);
  if (onIdx === -1) return false;
  return directChildren(lines, onIdx).some((c) => /^schedule\s*:/.test(c.line.trim()));
}

/**
 * Split a job's `steps:` list into per-step {bodyText, timeoutMinutes}.
 * `timeoutMinutes` is the STEP's own `timeout-minutes:` if set, else null
 * (caller falls back to the job-level envelope) — a job can give one slow
 * step a tight cap while the overall job timeout is generous (e.g.
 * update-show-status.yml: job timeout 75, "Discover new shows" step 45).
 */
function getStepBlocks(lines, jobHeaderIdx) {
  const stepsEntry = directChildren(lines, jobHeaderIdx).find((c) => /^steps\s*:/.test(c.line.trim()));
  if (!stepsEntry) return [];
  const stepHeaders = directChildren(lines, stepsEntry.idx); // each "- name: ..." / "- uses: ..." / "- run: ..." line
  // Bound the LAST step by where this job ends (same pattern as jobsEnd in
  // getJobBlocks) — without this, the last step's bodyText ran to end-of-file,
  // swallowing every subsequent job's env vars, secrets, and script
  // invocations. Verified against the live .github/workflows/ corpus: this
  // produced 9/25 (36%) spurious warnings with wrong job/script attribution.
  const jobHeaderIndent = indentOf(lines[jobHeaderIdx]);
  let stepsEnd = lines.length;
  for (let i = stepsEntry.idx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= jobHeaderIndent) { stepsEnd = i; break; }
  }
  return stepHeaders.map((h, i) => {
    const endIdx = i + 1 < stepHeaders.length ? stepHeaders[i + 1].idx : stepsEnd;
    const bodyLines = lines.slice(h.idx, endIdx); // include the "- name:" line itself in bodyText
    const timeoutEntry = directChildren(lines, h.idx).find((c) => /^timeout-minutes\s*:/.test(c.line.trim()));
    const timeoutMinutes = timeoutEntry
      ? parseInt(timeoutEntry.line.trim().split(':')[1].trim(), 10)
      : null;
    return { bodyText: bodyLines.join('\n'), timeoutMinutes };
  });
}

/** Split the `jobs:` block into per-job {name, bodyText, timeoutMinutes, steps}. */
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
    const endIdx = i + 1 < jobHeaders.length ? jobHeaders[i + 1].idx : jobsEnd;
    const bodyLines = lines.slice(h.idx + 1, endIdx);
    const timeoutEntry = directChildren(lines, h.idx).find((c) => /^timeout-minutes\s*:/.test(c.line.trim()));
    const timeoutMinutes = timeoutEntry
      ? parseInt(timeoutEntry.line.trim().split(':')[1].trim(), 10)
      : null;
    const steps = getStepBlocks(lines, h.idx);
    return { name, bodyText: bodyLines.join('\n'), timeoutMinutes, steps };
  });
}

/** Index of the char matching the `(` at src[openIdx]. */
/**
 * Index of the char matching src[openIdx] (which must be openChar), skipping
 * over '...'/"..." string literals and //, /* comments so a stray brace or
 * paren INSIDE a log message or error string can't desync the count (a bare
 * `console.log('caught: ' + e.message + '}')` would otherwise truncate the
 * scan early). Backtick template literals are intentionally NOT skipped —
 * their `${...}` interpolations are real code and may themselves contain a
 * network call worth catching.
 */
function findMatching(src, openIdx, openChar, closeChar) {
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
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') j++;
        j++;
      }
      i = j;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) return i; }
  }
  return null;
}

function matchParen(src, openIdx) {
  return findMatching(src, openIdx, '(', ')');
}

/** Body text between the `{` at src[openBraceIdx] and its matching `}` (exclusive). */
function extractBracedBody(src, openBraceIdx) {
  const end = findMatching(src, openBraceIdx, '{', '}');
  return end == null ? null : src.slice(openBraceIdx + 1, end);
}

/** All named function bodies in a script (function decls + const-assigned arrow fns with a block body). */
function extractFunctionBodies(src) {
  const re = /(?:async\s+function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)|function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)|const\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\([^)]*\)\s*=>|const\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>)\s*\{/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] || m[2] || m[3] || m[4];
    const braceIdx = m.index + m[0].length - 1;
    const body = extractBracedBody(src, braceIdx);
    if (name && body != null) out.push({ name, body });
  }
  return out;
}

/** All for/while loops with a `{ }` block body (single-statement loops are skipped — heuristic limitation). */
function extractLoops(src) {
  const re = /\b(?:for|while)\s*\(/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const parenIdx = m.index + m[0].length - 1;
    const headerEnd = matchParen(src, parenIdx);
    if (headerEnd == null) continue;
    const header = src.slice(parenIdx + 1, headerEnd);
    let j = headerEnd + 1;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== '{') continue;
    const body = extractBracedBody(src, j);
    if (body != null) out.push({ header, body });
  }
  return out;
}

/** True if the script has an unbounded-looking loop that calls a network helper. */
function hasRiskyLoop(src) {
  const networkyNames = new Set(
    extractFunctionBodies(src).filter((f) => NETWORK_CALL_RE.test(f.body)).map((f) => f.name),
  );
  for (const loop of extractLoops(src)) {
    // Explicitly bounded: `.slice(-N)` (last N) or `.slice(A, B)` with literal
    // bounds (e.g. `maps.slice(-2)`, `candidates.slice(0, 4)`). A single
    // non-negative-literal or variable arg (`.slice(alreadyProcessed)`) means
    // "from N to end" — NOT bounded — so it must NOT match here.
    if (/\.slice\(\s*-\d+\s*\)|\.slice\(\s*\d+\s*,\s*\d+\s*\)/.test(loop.header)) continue;
    if (NETWORK_CALL_RE.test(loop.body)) return true;
    for (const name of networkyNames) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(loop.body)) return true;
    }
  }
  return false;
}

function main() {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  const warnings = [];
  const scriptCache = new Map(); // script path -> { hasRunBudget, risky }

  for (const file of files) {
    const raw = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    if (!hasScheduleTrigger(raw)) continue; // dispatch-only: not the backlog-cron shape this guards against
    if (raw.includes(`${ANNOTATION}:`)) continue;

    for (const job of getJobBlocks(raw)) {
      // Evaluate per-STEP, not per-job: a job can set a generous overall
      // envelope (e.g. 75 min) while capping one slow step at 45 — that
      // step-level cap is what actually SIGKILLs the script, so it must gate
      // this heuristic (#438 found discover-new-shows.js invisible to this
      // audit for exactly this reason: job.timeout-minutes was 75). A job-
      // wide minimum across ALL steps was tried and rejected — it wrongly
      // attributed one step's tiny timeout (e.g. a 5-min side-scrape) to
      // scripts running in sibling steps with no timeout or a generous one,
      // producing false positives. Each step's own timeout-minutes (falling
      // back to the job-level envelope when a step doesn't set one) is the
      // correct scope. Jobs with no parseable `steps:` list fall back to the
      // old whole-job-body behavior so we don't lose coverage on some
      // unanticipated YAML shape.
      const steps = job.steps.length > 0
        ? job.steps.map((s) => ({ bodyText: s.bodyText, timeoutMinutes: s.timeoutMinutes ?? job.timeoutMinutes }))
        : [{ bodyText: job.bodyText, timeoutMinutes: job.timeoutMinutes }];

      for (const step of steps) {
        if (!Number.isFinite(step.timeoutMinutes) || step.timeoutMinutes > MAX_TIMEOUT_MIN) continue;
        if (!BD_SB_TOKENS.some((t) => step.bodyText.includes(t))) continue;

        const scripts = [...new Set(
          [...step.bodyText.matchAll(/\bnode\s+scripts\/([A-Za-z0-9_\-/]+\.js)/g)].map((m) => m[1]),
        )];

        for (const script of scripts) {
          const scriptPath = path.join(SCRIPTS_DIR, script);
          if (!fs.existsSync(scriptPath)) continue;

          if (!scriptCache.has(scriptPath)) {
            const content = fs.readFileSync(scriptPath, 'utf8');
            const hasRunBudget = /require\(['"]\.\/lib\/run-budget['"]\)/.test(content);
            scriptCache.set(scriptPath, {
              hasRunBudget,
              risky: !hasRunBudget && hasRiskyLoop(content),
            });
          }

          const result = scriptCache.get(scriptPath);
          if (result.risky) {
            warnings.push({ file, job: job.name, timeoutMinutes: step.timeoutMinutes, script });
          }
        }
      }
    }
  }

  if (warnings.length === 0) {
    console.log(`✅ Run-budget coverage guard: no candidates flagged (${files.length} workflows checked).`);
    return;
  }

  console.log('⚠️  Run-budget coverage guard — possible missing scripts/lib/run-budget.js:\n');
  console.log('These jobs have timeout-minutes <= 35 on a SCHEDULED trigger, use Bright Data /');
  console.log('ScrapingBee, and invoke a script with a loop that calls a network helper but does');
  console.log('NOT require scripts/lib/run-budget — the same shape as #369/#415/#421.\n');
  console.log('This is advisory (heuristic, non-blocking) — verify manually before fixing.\n');
  for (const w of warnings) {
    console.log(`  • ${w.file} :: job "${w.job}" (timeout-minutes: ${w.timeoutMinutes}) → scripts/${w.script}`);
  }
  console.log(`\nFix: wire scripts/lib/run-budget.js into the script (see #369/#415 for the pattern).`);
  console.log(`Exempt (false positive): add  # ${ANNOTATION}: <reason>  anywhere in the workflow file.\n`);
  // Advisory only — never fails CI (see header).
}

// Advisory-only means "never fails the gate" — that promise only holds on the
// happy path. Same guard as scripts/audit-push-core-data-audit-gap.js /
// scripts/audit-push-retry-budgets.js: an unreadable workflow file or an
// unexpected parsed-shape edge case would otherwise crash main() with a
// nonzero exit, silently turning this into an accidental hard gate on
// lint-workflows (card #1918 pattern-recognition finding, 2026-08-26).
try {
  main();
} catch (err) {
  console.log(`ℹ️  run-budget coverage audit crashed (advisory, not failing CI): ${err.message}`);
}
