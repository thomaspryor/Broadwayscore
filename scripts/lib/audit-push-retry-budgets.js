#!/usr/bin/env node
// scripts/lib/audit-push-retry-budgets.js — pure decision logic for
// scripts/audit-push-retry-budgets.js (card #1910, 2026-08-26).
//
// Systemic version of the bug class fixed reactively twice already:
//   task #1842 — data-health-check.yml's "Commit and push changes" step ran
//     on push-with-retry.sh's shared defaults (PUSH_DEADLINE_SEC=240,
//     MAX_RETRIES=7) under real CI contention and hard-failed.
//   card #1891 — same class hit rebuild-fast.yml/rebuild-reviews.yml. The fix
//     raised PUSH_DEADLINE_SEC + MAX_RETRIES TOGETHER (a deadline-only raise
//     doesn't help — MAX_RETRIES is usually the binding constraint, see
//     computeBackoffSum below) and, on adversarial re-review, ALSO raised
//     rebuild-reviews.yml's job timeout-minutes (30->40): stacked against the
//     "Extract pull quotes" step's own explicit timeout-minutes: 12, the new
//     900s push budget left only 180s (10%) of headroom in the 30min job.
//
// Three independent flags come out of this module:
//
//   1. retryDeadlineRatio — push-with-retry.sh's backoff loop sleeps
//      WAIT=3+i*2+jitter seconds before each retry (scripts/lib/push-with-
//      retry.sh ~line 1662); summed over N attempts that's N^2+4N seconds
//      (ignoring jitter, which only adds up to 4s/attempt). When that sum is
//      well under PUSH_DEADLINE_SEC, the loop exhausts its MAX_RETRIES and
//      falls through to the Git Data API fallback (or fails outright) long
//      before the deadline is reached — exactly the #1842/#1891 failure
//      shape. Flagged when backoffSum < RETRY_DEADLINE_RATIO_THRESHOLD *
//      deadlineSec.
//
//   2. marginRatio includes sibling push calls, explicit timeouts, script
//      --time-budget-min budgets and estimated Checkout cost (BRO-2714).
//      stepBudgetSec = max(deadlineSec, backoffSum) still omits post-deadline
//      work, which the BRO-5312 residual model reports separately. New
//      estimates are advisory first (CLAUDE.md section 19): blockingMarginRatio
//      preserves the existing hard gate's explicit-timeout/push-only model.
//
//   3. fundableAttempts — BRO-2373 (2026-09-02). Flags 1 and 2 both model an
//      attempt as costing only its backoff SLEEP. Real CI logs say an attempt
//      that hits GIT_NET_TIMEOUT_SEC costs at least 2x90s of network cap. See
//      computeFundableAttempts below for the measurement and the two runs it
//      was derived from. Flagged as deadline-cannot-fund-retries when
//      PUSH_DEADLINE_SEC funds fewer than min(MAX_RETRIES, 3) attempts.
//
// BRO-5312: residualPastDeadlineSec models the push script's documented
// post-deadline phases. Separate *WithResidual* budgets and advisoryFlags
// expose callers needing more headroom without changing the existing gate,
// ranking or remediation proposals. This is a sizing estimate, not a strict
// wall-clock bound: rebase CPU is measured, and REST blob-upload time depends
// on the outgoing files. A silent advisory does not prove a job is safe.
//
// No YAML library (none of the CI jobs that would run this npm-install first;
// same constraint scripts/lib/ci-cancellation-guard.js documents). Parsed
// with the same indentation-aware line reader that file uses.
'use strict';

const DEFAULT_MAX_RETRIES = 7; // push-with-retry.sh: MAX_RETRIES=${1:-7}
const DEFAULT_DEADLINE_SEC = 240; // push-with-retry.sh: PUSH_DEADLINE_SEC=${PUSH_DEADLINE_SEC:-240}
const DEFAULT_JOB_TIMEOUT_MIN = 360; // GitHub Actions' own default when a job omits timeout-minutes

// BRO-2714: Checkout took 569s at fetch-depth 300 on run 33410708893
// (2026-08-31), also used by tests/unit/data-validation-job-budget.test.mjs.
// Use that conservative estimate for each actions/checkout without an explicit
// timeout. It is a sizing estimate, not a guaranteed bound for every checkout.
const CHECKOUT_ESTIMATE_SEC = 569;

const MARGIN_THRESHOLD = 0.15; // job-timeout headroom flag (#1891 follow-up precedent)
const RETRY_DEADLINE_RATIO_THRESHOLD = 0.5; // retries-vs-deadline undersizing flag

// Live require of scripts/lib/core-data-merge-registry.js's
// CORE_DATA_MERGE_REGISTRY — files with many concurrent CI writers, i.e. the
// real collision risk the card asks this audit to weigh pushes against.
// SECOND-OPINION FINDING (card #1910 review): the first draft copied
// basenames into a literal list here "to stay requirable from a plain node
// invocation" — but this module (unlike scripts/lib/ci-cancellation-guard.js,
// which really does run inside a checkout-only lint-workflows CI step with no
// npm install) always runs from a full repo checkout with node available, so
// there was no actual constraint forcing a copy — and the copy had ALREADY
// drifted from the registry (missing audience-reviews-lbo.json,
// critic-consensus.json, followers.json, outlet-registry.json,
// subscribers-westend.json, subscribers.json) by the time it was reviewed.
// require() the registry directly instead; MANAGED_FILE_INFO is built once
// at module load from its live contents, keyed by basename, recording
// whether EVERY entry for that file is apiFallbackSafe (a file can appear
// under multiple `surface`s — see findEntry()'s dedupe-by-basename note in
// that file). Falls back to an empty map (touchesManagedFile always false)
// if the registry can't be loaded, rather than throwing — this module must
// stay usable even if core-data-merge-registry.js moves or breaks.
let MANAGED_FILE_INFO = new Map();
// Precise mirror of push-with-retry.sh's OWN Git Data API fallback
// disqualifier (scripts/lib/push-with-retry.sh ~L1930, via scripts/lib/
// reconcile-merged-json.js's MANAGED/API_FALLBACK_SAFE exports) — used ONLY
// by the mixed-safety-bundle flag below (BRO-2446). Deliberately a SEPARATE,
// narrower pair of lists from MANAGED_FILE_INFO above: that map folds in
// EVERY registry entry regardless of surface/status (a looser "does this
// basename appear anywhere in the registry" proxy, fine for contentionScore
// weighting) — but push-with-retry.sh's actual disqualifier only ever
// consults `activeEntriesFor('public-repo')` and
// `apiFallbackSafeEntriesFor('public-repo')`. Reusing the loose map here
// would misclassify e.g. a private-core-data-only 'special' entry as
// disqualifying a public-repo push it never touches.
let PUBLIC_REPO_MANAGED_FILES = [];
let PUBLIC_REPO_API_FALLBACK_SAFE_FILES = [];
// BRO-2413 (Codex adversarial ship-check P1 finding): classifyPushFallbackSafety
// below must mirror push-with-retry.sh's actual disqualifier EXACTLY, which
// now also exempts apiFallbackMerge-registered files (core-data-merge-
// registry.js's apiFallbackMergeEntriesFor()) even though they ARE 'active'
// (MANAGED) — a MANAGED file only still disqualifies when it lacks
// apiFallbackMerge coverage. Without this, this audit tool would report the
// 3 alert-* ledgers as still disqualifying the fallback when they no longer
// do, giving stale advice.
let PUBLIC_REPO_API_FALLBACK_MERGE_FILES = [];
try {
  // eslint-disable-next-line global-require
  const { CORE_DATA_MERGE_REGISTRY, activeEntriesFor, apiFallbackSafeEntriesFor, apiFallbackMergeEntriesFor } = require('./core-data-merge-registry.js');
  for (const entry of CORE_DATA_MERGE_REGISTRY) {
    if (entry.file.includes('*')) continue; // glob entry (BRO-2782): no basename to key by
    const base = entry.file.split('/').pop();
    const prev = MANAGED_FILE_INFO.get(base);
    const apiFallbackSafe = entry.apiFallbackSafe === true && (prev ? prev.apiFallbackSafe : true);
    MANAGED_FILE_INFO.set(base, { apiFallbackSafe });
  }
  PUBLIC_REPO_MANAGED_FILES = activeEntriesFor('public-repo').map((e) => e.file);
  PUBLIC_REPO_API_FALLBACK_SAFE_FILES = apiFallbackSafeEntriesFor('public-repo').map((e) => e.file);
  PUBLIC_REPO_API_FALLBACK_MERGE_FILES = apiFallbackMergeEntriesFor('public-repo').map((e) => e.file);
} catch {
  MANAGED_FILE_INFO = new Map();
  PUBLIC_REPO_MANAGED_FILES = [];
  PUBLIC_REPO_API_FALLBACK_SAFE_FILES = [];
  PUBLIC_REPO_API_FALLBACK_MERGE_FILES = [];
}

// NEVER_FALLBACK (data/shows.json, data/reviews.json) now lives in
// api-fallback-disqualifier-core.js alongside the predicate that consults it —
// re-exported here so any existing reader of this name keeps working.
// Requires the -core file, NOT api-fallback-disqualifier.js itself: this
// script is on AUDIT_LINT_GENERIC_FORM_ALLOWED (scripts/lib/autonomous-
// triage-core.js), which requires a zero-hazard transitive require graph
// (scripts/lib/safe-form-allowlist.test.mjs) — api-fallback-disqualifier.js's
// CLI block does a real `git diff` spawn, which pulled a hazard into this
// script's graph every run until the predicate was split out (BRO-2531
// session, unrelated fix picked up while landing that ticket).
// eslint-disable-next-line global-require
const { registryPathMatches } = require('./registry-path-match.js');
const { disqualifyingPath, NEVER_FALLBACK: NEVER_FALLBACK_FILES } = require('./api-fallback-disqualifier-core.js');

/**
 * Classify one staged repo-relative file path exactly the way push-with-
 * retry.sh's disqualifier does: `isApiFallbackSafe` mirrors its
 * isApiFallbackSafe(f); `disqualifiesFallback` mirrors the `hit` predicate
 * ((isManaged && !isApiFallbackMergeable) || isNeverFallback ||
 * unaudited-data/audit/-path). isApiFallbackSafe and isApiFallbackMerge are
 * mutually exclusive by registry construction (an apiFallbackSafe: true
 * entry is never also `status: 'active'` on the same surface, and
 * apiFallbackMerge entries ARE 'active' — see core-data-merge-registry.js's
 * apiFallbackMergeEntriesFor() header) — but isApiFallbackMerge and isManaged
 * are NOT mutually exclusive; every apiFallbackMerge entry today is also
 * MANAGED (status:'active'), which is exactly why disqualifiesFallback needs
 * the extra `!isApiFallbackMergeable` carve-out on the isManaged clause.
 */
function classifyPushFallbackSafety(filePath) {
  const isApiFallbackSafe = PUBLIC_REPO_API_FALLBACK_SAFE_FILES.some((f) => registryPathMatches(f, filePath));
  // BRO-2782: a bare directory add (`git add data/audit/triage/`) is covered
  // when a registry glob entry ('audit/triage/*.json') owns that directory.
  // Only .json children are covered; anything else the add stages is still
  // disqualified at push time by the real disqualifier, which sees file paths.
  const dirOwned = (f) => filePath.endsWith('/') && f.endsWith('/*.json') && (filePath === 'data/' + f.slice(0, -'*.json'.length) || filePath.endsWith('/' + f.slice(0, -'*.json'.length)));
  const isApiFallbackMerge = PUBLIC_REPO_API_FALLBACK_MERGE_FILES.some((f) => registryPathMatches(f, filePath) || dirOwned(f));
  // BRO-3663: `disqualifiesFallback` is no longer a hand-maintained mirror of
  // the shell's `hit` expression — that expression no longer exists. It now
  // CALLS the same module push-with-retry.sh calls, so the two cannot drift.
  // This matters beyond tidiness: push-with-retry.stranded-commit-cascade
  // .test.sh's PART B guard require()s this function and treats it as the real
  // runtime predicate, which was only true while the mirror was accurate.
  //
  // The lists here are registry-relative (`audit/x.json`); disqualifyingPath
  // strips a leading `data/` from each entry before matching, so they are
  // re-prefixed to round-trip to the identical strings. Verified equivalent
  // over all 327 registry paths plus adversarial shapes at the time of the
  // change — this is a refactor, not a behaviour change.
  const asEntries = (list) => list.map((f) => ({ file: `data/${f}` }));
  const disqualifiesFallback = disqualifyingPath([filePath], {
    MANAGED: asEntries(PUBLIC_REPO_MANAGED_FILES),
    API_FALLBACK_SAFE: asEntries(PUBLIC_REPO_API_FALLBACK_SAFE_FILES),
    API_FALLBACK_MERGE: asEntries(PUBLIC_REPO_API_FALLBACK_MERGE_FILES),
  }) !== null;
  return { isApiFallbackSafe, isApiFallbackMerge, disqualifiesFallback };
}

// Shared token filter for both extraction passes below: keeps only literal
// `data/...` path arguments, dropping flags (`-u`, `--force`), shell
// variables (`$f`, `"${arr[@]}"`), and bare directory adds (trailing `/` —
// can't be resolved to specific files statically).
function pathTokensFrom(text, into) {
  for (const tokRaw of text.trim().split(/\s+/)) {
    if (!tokRaw) continue;
    const tok = tokRaw.replace(/^['"]|['"]$/g, '');
    if (tok.startsWith('-')) continue;
    if (tok.includes('$')) continue;
    if (tok.endsWith('/')) continue;
    if (!tok.startsWith('data/')) continue;
    into.add(tok);
  }
}

// `for f in data/audit/a.json data/audit/b.json; do ... git add "$f" ...;
// done` — the loop-staged idiom used across ~9 real workflows (BRO-2446
// second-opinion review finding: both the Codex adversarial pass and the
// Claude QA subagent independently flagged this as a live blind spot,
// e.g. audit-census-recall.yml, audit-aggregator-gap.yml,
// audit-critic-coverage.yml). The `git add "$f"` line itself references a
// shell variable and is unresolvable on its own (pathTokensFrom deliberately
// drops any token containing '$'), but the literal `data/...` paths the loop
// iterates over sit on the `for ... in` header, not the git-add line. Gated
// on the loop body actually referencing `git add ... $VAR` for the SAME loop
// variable so an unrelated for-loop's arguments are never misattributed as
// staged paths. Does not handle nested loops (finds the first `done` after
// the loop body starts) — no such shape exists in this repo's push-staging
// loops today.
function extractLoopStagedPaths(cleaned, paths) {
  const forRe = /for\s+(\w+)\s+in\s+([\s\S]*?);\s*do\b/g;
  let m;
  while ((m = forRe.exec(cleaned))) {
    const varName = m[1];
    const listText = m[2].replace(/\\\s*\n/g, ' ');
    const bodyStart = forRe.lastIndex;
    const doneIdx = cleaned.indexOf('\ndone', bodyStart);
    const body = cleaned.slice(bodyStart, doneIdx === -1 ? cleaned.length : doneIdx);
    const addsVar = new RegExp(`git\\s+add\\b[^\\n]*\\$\\{?${varName}\\}?\\b`).test(body);
    if (!addsVar) continue;
    pathTokensFrom(listText, paths);
  }
}

// Extract literal `data/...` file-path arguments staged in `runText` via
// `git-add-existing.sh`, plain `git add`, or a `for f in <paths>; do git add
// "$f"; done` loop (the three shapes used across every workflow — see
// BRO-2446 evidence grep). Best-effort/advisory, matching this module's
// existing parse philosophy: flags (`-u`, `--force`, …), shell variables not
// resolved by extractLoopStagedPaths, and bare directory adds (`data/audit/`,
// trailing slash) are skipped rather than guessed at, so this only ever
// UNDER-reports staged paths, never fabricates one. Runs against the WHOLE
// runText (not one line) since real workflows stage several files across
// separate `git add` lines before a single commit+push.
//
// KNOWN, DOCUMENTED BLIND SPOTS (second-opinion review, BRO-2446) — verified
// via grep to have NO live overlap with any apiFallbackSafe file today, so
// these are structural gaps, not live false negatives, as of this writing:
//   - `bash scripts/lib/stage-data-changes.sh` bulk-stages all of `data/`
//     (minus copyrighted-content exclusions) with no literal paths in the
//     invocation itself — used by 12 workflows (e.g. commercial-weekly.yml's
//     "Commit applied data + audit" step), none of which explicitly stage an
//     apiFallbackSafe file elsewhere in the same step today.
//   - Bash globs (`git add data/audit/*.json`) are treated as one opaque,
//     non-`data/`-prefix-matching-safe literal token rather than shell-
//     expanded to the files they'd actually match.
// Resolving either would require simulating `git status` against the
// checked-out tree, not just parsing YAML/shell source text — out of scope
// for this module's static-analysis design (every other flag here works the
// same way). If a future apiFallbackSafe file is ever staged behind either
// shape, this audit will silently miss it; re-run the grep above (`git grep
// stage-data-changes.sh .github/workflows | xargs grep -l <apiFallbackSafe
// basenames>`) periodically, or when adding a new apiFallbackSafe entry.
function extractStagedPaths(runText) {
  const cleaned = stripCommentLines(runText);
  const paths = new Set();
  const patterns = [/git-add-existing\.sh\b([^\n]*)/g, /(?<![\w.-])git\s+add\b([^\n]*)/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(cleaned))) {
      let rest = m[1];
      const stopMatch = rest.match(/\|\||&&|;|(?:^|\s)#/);
      if (stopMatch) rest = rest.slice(0, stopMatch.index);
      pathTokensFrom(rest, paths);
    }
  }
  extractLoopStagedPaths(cleaned, paths);
  return [...paths];
}

// For each push-with-retry.sh call found in `runText`, IN THE SAME ORDER
// findPushRetryCalls returns them, the staged paths from ONLY the git-add
// commands between the previous call's line (or the start of the text) and
// this call's own line. NOT "every git-add hit anywhere in the step" — the
// BRO-2435 fix pattern (git-add-existing.sh ONE file -> commit ->
// push-with-retry.sh, repeated per file in the SAME step, see opening-night-
// broadcast.yml's "Commit orphan-rescore-requeue state" step) puts multiple
// independent push calls in one step's run text; attributing every git-add
// hit in the whole step to every call in it would falsely flag that
// already-fixed, correctly-split pattern as a mixed bundle, when each call
// in fact only ever stages its own single file.
function stagedPathsPerCall(runText) {
  const cleaned = stripCommentLines(runText);
  const re = /(?<=\/)push-with-retry\.sh(?:\s+\d+)?/g;
  const lineEnds = [];
  let m;
  while ((m = re.exec(cleaned))) {
    const lineEnd = cleaned.indexOf('\n', m.index);
    lineEnds.push(lineEnd === -1 ? cleaned.length : lineEnd);
  }
  const result = [];
  let segStart = 0;
  for (const lineEnd of lineEnds) {
    result.push(extractStagedPaths(cleaned.slice(segStart, lineEnd)));
    segStart = lineEnd;
  }
  return result;
}

function indentOf(line) {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

// All lines strictly more indented than the line at `startIdx`, stopping at
// the first line (blank/comment excluded) whose indent drops back to
// `<= indentOf(lines[startIdx])`. Mirrors ci-cancellation-guard.js's
// childLines(), used here to walk jobs -> steps -> step fields.
function childLines(lines, startIdx) {
  const headerIndent = indentOf(lines[startIdx]);
  const out = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) <= headerIndent) break;
    out.push({ idx: i, line });
  }
  return out;
}

// Index of the first line >startIdx whose indent is <=headerIndent (blank/
// comment lines don't count) — i.e. one past the end of startIdx's block.
function blockEnd(lines, startIdx) {
  const headerIndent = indentOf(lines[startIdx]);
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentOf(lines[i]) <= headerIndent) return i;
  }
  return lines.length;
}

// Find a direct child `key:` (scalar value on the same line, or block value
// on following more-indented lines) among a job/step's child lines. Returns
// { idx, inline } where inline is the trimmed same-line value (possibly '').
function findChildKey(kids, key) {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`);
  for (const { idx, line } of kids) {
    const m = line.trim().match(re);
    if (m) return { idx, inline: m[1].trim() };
  }
  return null;
}

// Raw text of a scalar/block value starting at `keyIdx` (a "key: ..." or
// "key: |" line) — either the inline remainder, or every more-indented line
// after it up to blockEnd. Comments/blanks inside the block are KEPT (bash
// `#` comments inside a `run:` block scalar must not be treated as YAML
// comments and stripped).
function scalarBlockText(lines, keyIdx, inline) {
  if (inline && inline !== '|' && inline !== '>' && inline !== '|-' && inline !== '>-') {
    return inline.replace(/^['"]|['"]$/g, '');
  }
  const headerIndent = indentOf(lines[keyIdx]);
  const end = blockEnd(lines, keyIdx);
  const body = [];
  for (let i = keyIdx + 1; i < end; i++) {
    if (indentOf(lines[i]) <= headerIndent && lines[i].trim() !== '') continue;
    body.push(lines[i]);
  }
  return body.join('\n');
}

function parseIntOrNull(s) {
  if (s == null) return null;
  const n = parseInt(String(s).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function budgetMinutesFrom(runText, envText = runText) {
  // Same literal and scheduled env-default forms as the BRO-2706 ratchet.
  const code = stripCommentLines(runText);
  const literal = code.match(/--time-budget-min=(\d+(?:\.\d+)?)\b/);
  if (literal) return parseFloat(literal[1]);
  const viaVar = code.match(/--time-budget-min=\$\{?([A-Z_][A-Z0-9_]*)\}?/);
  if (!viaVar) return null;
  const envDefault = stripCommentLines(envText).match(
    new RegExp(`${viaVar[1]}\\s*:\\s*\\$\\{\\{[^}]*?\\|\\|\\s*'(\\d+(?:\\.\\d+)?)'`),
  );
  return envDefault ? parseFloat(envDefault[1]) : null;
}

/**
 * Parse a workflow YAML file's text into { jobs: [{ key, timeoutMinutes,
 * steps: [{ name, runText, envDeadlineSec, timeoutMinutes, timeBudgetMinutes, checkoutEstimateSec }] }] }.
 * Returns { jobs: [] } (never throws) on unrecognized structure — callers
 * should treat that as "nothing to audit here", not an error; this is an
 * advisory tool, not a strict validator.
 */
function parseWorkflow(text) {
  const lines = text.split('\n');
  const jobsIdx = lines.findIndex((l) => indentOf(l) === 0 && /^jobs\s*:\s*$/.test(l.trim()));
  if (jobsIdx === -1) return { jobs: [] };

  const jobsKids = childLines(lines, jobsIdx);
  if (jobsKids.length === 0) return { jobs: [] };
  const jobIndent = indentOf(jobsKids[0].line);

  const jobs = [];
  for (const { idx, line } of jobsKids) {
    if (indentOf(line) !== jobIndent) continue; // not a job-key line
    const m = line.trim().match(/^([\w.-]+)\s*:\s*$/);
    if (!m) continue;
    const jobKey = m[1];
    const jobKids = childLines(lines, idx);

    const timeoutField = findChildKey(jobKids, 'timeout-minutes');
    const timeoutMinutes = timeoutField ? parseIntOrNull(timeoutField.inline) : DEFAULT_JOB_TIMEOUT_MIN;

    const stepsField = findChildKey(jobKids, 'steps');
    const steps = [];
    if (stepsField) {
      const stepsKids = childLines(lines, stepsField.idx);
      // Step list items: "  - name: ..." (or "- id:", "- uses:", etc.) — the
      // dash marks a new step; its own key/value pairs sit at indent+2 from
      // the dash. Group stepsKids by step boundary (a line starting with "-").
      let current = null;
      for (const kid of stepsKids) {
        const dashMatch = kid.line.match(/^(\s*)-\s?(.*)$/);
        if (dashMatch && indentOf(kid.line) === indentOf(stepsKids[0].line)) {
          if (current) steps.push(current);
          current = { startIdx: kid.idx, fieldIndent: dashMatch[1].length + 2, firstLineRest: dashMatch[2] };
        } else if (current) {
          current.endIdx = kid.idx;
        }
      }
      if (current) steps.push(current);

      for (const step of steps) {
        const end = blockEnd(lines, step.startIdx);
        // Re-derive this step's own direct children by scanning from
        // startIdx+1 to `end` at exactly fieldIndent (childLines() can't be
        // reused directly since the step "header" is the synthetic dash
        // line, not a real key: line).
        const kids = [];
        for (let i = step.startIdx; i < end; i++) {
          if (i === step.startIdx) continue;
          if (isBlankOrComment(lines[i])) continue;
          if (indentOf(lines[i]) === step.fieldIndent) kids.push({ idx: i, line: lines[i] });
        }
        // The dash line itself often carries the first key (e.g. "- name: x").
        const firstKeyMatch = step.firstLineRest.match(/^([\w.-]+)\s*:\s*(.*)$/);
        if (firstKeyMatch) kids.unshift({ idx: step.startIdx, line: ' '.repeat(step.fieldIndent) + step.firstLineRest });

        const nameField = findChildKey(kids, 'name');
        const runField = findChildKey(kids, 'run');
        const usesField = findChildKey(kids, 'uses');
        const envField = findChildKey(kids, 'env');
        const stepTimeoutField = findChildKey(kids, 'timeout-minutes');
        const continueOnErrorField = findChildKey(kids, 'continue-on-error');
        const ifField = findChildKey(kids, 'if');

        const runText = runField ? scalarBlockText(lines, runField.idx, runField.inline) : '';
        let envDeadlineSec = null;
        let envFallbackAfterAttempts = null;
        let envFallbackDisabled = false;
        let envGitNetTimeoutSec = null;
        let envOpMinTimeoutSec = null;
        if (envField) {
          const envKids = childLines(lines, envField.idx);
          const deadlineField = findChildKey(envKids, 'PUSH_DEADLINE_SEC');
          if (deadlineField) envDeadlineSec = parseIntOrNull(deadlineField.inline.replace(/^['"]|['"]$/g, ''));
          const fallbackAfterField = findChildKey(envKids, 'PUSH_API_FALLBACK_AFTER_ATTEMPTS');
          if (fallbackAfterField) envFallbackAfterAttempts = parseIntOrNull(fallbackAfterField.inline.replace(/^['"]|['"]$/g, ''));
          const fallbackDisableField = findChildKey(envKids, 'PUSH_API_FALLBACK_DISABLE');
          if (fallbackDisableField) envFallbackDisabled = fallbackDisableField.inline.replace(/^['"]|['"]$/g, '').trim() === '1';
          // BRO-2801: the remediation proposer uses the caller's cap. BRO-5312:
          // the advisory residual also uses it; legacy flags stay unchanged.
          const gitNetField = findChildKey(envKids, 'GIT_NET_TIMEOUT_SEC');
          if (gitNetField) envGitNetTimeoutSec = parseIntOrNull(gitNetField.inline.replace(/^['"]|['"]$/g, ''));
          const opMinField = findChildKey(envKids, 'PUSH_OP_MIN_TIMEOUT_SEC');
          if (opMinField) envOpMinTimeoutSec = parseIntOrNull(opMinField.inline.replace(/^['"]|['"]$/g, ''));
        }

        step.name = nameField ? nameField.inline.replace(/^['"]|['"]$/g, '') : null;
        step.runText = runText;
        step.timeBudgetMinutes = budgetMinutesFrom(runText, envField
          ? lines.slice(envField.idx, blockEnd(lines, envField.idx)).join('\n') : '');
        step.checkoutEstimateSec = usesField && /^['"]?actions\/checkout@/.test(usesField.inline)
          ? CHECKOUT_ESTIMATE_SEC : 0;
        step.envDeadlineSec = envDeadlineSec;
        step.envFallbackAfterAttempts = envFallbackAfterAttempts;
        step.envFallbackDisabled = envFallbackDisabled;
        step.envGitNetTimeoutSec = envGitNetTimeoutSec;
        step.envOpMinTimeoutSec = envOpMinTimeoutSec;
        step.envIdx = envField ? envField.idx : null;
        step.timeoutMinutes = stepTimeoutField ? parseIntOrNull(stepTimeoutField.inline) : null;
        // BRO-2580: `if: always()` / `if: failure()` makes this step run even after an
        // earlier step hard-failed, so that earlier step's stranded commit reaches it.
        step.runsAfterFailure = ifField ? /\b(always|failure)\s*\(/.test(ifField.inline) : false;
        step.continueOnError = continueOnErrorField ? /^true$/i.test(continueOnErrorField.inline) : false;
      }
    }

    jobs.push({ key: jobKey, timeoutMinutes, steps });
  }

  return { jobs };
}

// Strip bash comment LINES (trimmed content starting with '#') from a run
// block. SECOND-OPINION FINDING (card #1910 review): without this,
// findPushRetryCalls below matched a bash comment in opening-night-poller.yml
// that merely *mentions* "push-with-retry.sh caller" in prose, fabricating a
// phantom call site with default (wrong) MAX_RETRIES/deadline values — 106
// comment-only mentions of push-with-retry.sh exist across the workflow
// directory, enough to meaningfully inflate the audit's call-site count.
// Only whole comment LINES are dropped (a line whose trimmed text starts
// with '#') — an inline trailing `# comment` after real shell content is
// deliberately left alone, since stripping mid-line would risk cutting into
// an unrelated `#` inside a string/URL on the same line.
function stripCommentLines(text) {
  return text
    .split('\n')
    .map((line) => (line.trim().startsWith('#') ? '' : line))
    .join('\n');
}

// Extract push-with-retry.sh invocations from a step's run text. Handles the
// two shapes seen in this repo: bare `bash scripts/lib/push-with-retry.sh`
// (MAX_RETRIES defaults to 7) and `bash scripts/lib/push-with-retry.sh N
// [branch]` (positional retries arg).
//
// GHOST-CALL FIX (ship-check adversarial review, card #1910): every real
// invocation in this repo references the script by PATH — `scripts/lib/
// push-with-retry.sh` or `../../scripts/lib/push-with-retry.sh` — so the
// match REQUIRES an immediately-preceding `/`. Without that guard, this
// regex also matched plain-English mentions of the filename inside a log/
// error string on the same run: block as a real call (e.g. test.yml:4532's
// `MSG="...Check run ... for the push-with-retry.sh output."`), which
// double-counted that step as having 2 calls instead of 1 — confirmed live
// via `node scripts/audit-push-retry-budgets.js --json` before this fix.
// The `/` requirement also means an inline `PUSH_DEADLINE_SEC=900 bash
// push-with-retry.sh` env-prefix form (no current caller uses it — every
// override goes through the step-level `env:` block parsed in
// parseWorkflow) is no longer separately recognized; `inlineDeadlineSec` is
// kept in the returned shape (always null) rather than removed, so callers
// don't have to branch on its absence.
//
// Each call also reports `softFail`: true when the same physical line trails
// the invocation with `|| echo` or `|| true` — push-with-retry.sh's own exit
// code is then deliberately swallowed by the caller (e.g.
// check-push-ledger.yml: "|| echo '::warning::...next run will re-check'"),
// so a failed push there is a known, tolerated degrade-and-retry-next-run
// condition, not the same risk class as a step where the push failure fails
// the job outright.
function findPushRetryCalls(runText) {
  const cleaned = stripCommentLines(runText);
  const calls = [];
  const re = /(?<=\/)push-with-retry\.sh(?:\s+(\d+))?/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const lineEnd = cleaned.indexOf('\n', m.index);
    const restOfLine = cleaned.slice(m.index, lineEnd === -1 ? cleaned.length : lineEnd);
    calls.push({
      inlineDeadlineSec: null,
      maxRetries: m[1] ? parseInt(m[1], 10) : DEFAULT_MAX_RETRIES,
      softFail: /\|\|\s*(echo|true)\b/.test(restOfLine),
    });
  }
  return calls;
}

// Whole-file, comment-stripped count of "push-with-retry.sh" mentions —
// independent of parseWorkflow's job/step structure. SECOND-OPINION-CLASS
// FINDING (ship-check adversarial review, card #1910): parseWorkflow never
// throws on a shape it can't handle (YAML anchors, folded scalars, an `id:`
// before `name:`, etc.) — it just silently returns fewer/no steps for that
// job, which would make auditWorkflowText silently under-count real call
// sites with no error signal. This raw count is a cross-check: the CLI
// compares it against the structured call count per file and warns on
// divergence, so a parser gap surfaces as a visible warning instead of a
// quietly-incomplete audit. Deliberately coarse (can overcount a mention
// inside an unrelated string) — it only needs to catch UNDER-counting.
function countRawCallSites(fileText) {
  const cleaned = stripCommentLines(fileText);
  const matches = cleaned.match(/push-with-retry\.sh/g);
  return matches ? matches.length : 0;
}


// Parse timeout defaults out of push-with-retry.sh rather than
// copying the literal — this module's whole history (see MANAGED_FILE_INFO
// above) is of copied constants drifting from their source. Falls back to the
// last known default if a declaration moves or the source cannot be read.
function readPushTimeoutDefault(name, fallback) {
  try {
    // eslint-disable-next-line global-require
    const src = require('fs').readFileSync(require('path').join(__dirname, 'push-with-retry.sh'), 'utf8');
    const m = src.match(new RegExp(`^${name}=\\$\\{${name}:-(\\d+)\\}`, 'm'));
    if (m) return parseInt(m[1], 10);
  } catch { /* fall through */ }
  return fallback;
}

// N^2+4N: sum_{i=1..N} (3 + 2i), push-with-retry.sh's WAIT=3+i*2+jitter
// backoff formula with the 0-4s random jitter term dropped (worst-case floor,
// not ceiling — jitter only ever adds time).
function computeBackoffSum(maxRetries) {
  return maxRetries * maxRetries + 4 * maxRetries;
}

// How many of MAX_RETRIES attempts PUSH_DEADLINE_SEC can actually fund when
// every network op costs its full hard cap (BRO-2373 measurement, 2026-09-02).
//
// The two flags above model an attempt as costing only its backoff SLEEP, so a
// 240s deadline with MAX_RETRIES=7 reads "ratio 0.32, deadline is generous".
// Measured against real CI logs that is wrong by an order of magnitude: on
// 2026-09-02 five workflows went red at their push step and in EVERY one each
// `git push` ran for exactly 90.00s — GIT_NET_TIMEOUT_SEC — and was hard-killed
// by push-with-retry.sh's own `_timeout` wrapper. Evidence, two independent
// workflows:
//   run 33679833284 (rebuild-reviews.yml, deadline 900s, MAX_RETRIES=25):
//     "overall deadline 900s exceeded after 6 attempt(s)"  — 6 of 25.
//   run 33681436855 (fetch-guardian-reviews.yml, deadline 240s, retries 7):
//     "overall deadline 240s exceeded after 2 attempt(s)"  — 2 of 7.
// Both match `2 * GIT_NET_TIMEOUT_SEC + backoff` per attempt, because ONE loop
// iteration can spend the cap TWICE: the loop-top `git_push` and, after the
// fetch+rebase, the post-resolution `git_push` (push-with-retry.sh's
// "Post-resolution push (attempt N) FAILED in Ns — ..." branch). A rejected push, by
// contrast, returns in ~1s (measured against this repo's origin), so this is
// the HANG/slow-push ceiling, not the ordinary race-loss path.
//
// Counted with the loop's real control flow: push-with-retry.sh checks
// `SECONDS >= PUSH_DEADLINE_SEC` at the TOP of each iteration (~L1091), so an
// attempt that merely STARTS under the deadline still runs in full.
//
// DIRECTION OF ERROR — read before trusting a NON-flag (adversarial review,
// 2026-09-02). 2 caps per iteration is a FLOOR on a fully-timed-out iteration,
// not a ceiling. An iteration can spend the cap more than twice: the primary
// fetch (~L1334), the ancestry-widening fetch (~L1435), the one-time unshallow
// (~L1260), and verify_content_survived's own fetches (~L1055) are each
// separately capped, and the Git Data API fallback runs outside this loop
// entirely (~L1961). So `fundableAttempts` is an UPPER BOUND on attempts:
//   * the flag FIRING means the step is genuinely underfunded (no false
//     positives from this term), which is what it is used for;
//   * the flag STAYING SILENT does NOT prove the step is well funded.
// The backoff term likewise drops push-with-retry.sh's 0-4s random jitter
// (~L1769), which only ever adds time. Both omissions push the same way.
const GIT_NET_TIMEOUT_SEC = readPushTimeoutDefault('GIT_NET_TIMEOUT_SEC', 90);
const PUSH_OP_MIN_TIMEOUT_SEC = readPushTimeoutDefault('PUSH_OP_MIN_TIMEOUT_SEC', 20);
const MIN_TIMED_OUT_ATTEMPT_SEC = 2 * GIT_NET_TIMEOUT_SEC;
// Below this many fundable attempts a step cannot ride out even a short burst
// of contention on main. 3 rather than a ratio: the quantity that matters is a
// small integer count of attempts, and a ratio would hide "2 of 25".
const MIN_FUNDABLE_ATTEMPTS = 3;

// BRO-5312: follow push-with-retry.sh's "Honest residual bound" and
// push-via-git-api.sh's BRO-3125 op breakdown. Keep survival fetches UNCLAMPED.
// The fallback can still make one attempt after its deadline: ls-remote and
// up to two fetches are clamped; the first ref update keeps its full cap.
// Its success path then refreshes origin once before verifying survival.
// Conservative even for callers whose outgoing paths disable the fallback.
// Excludes per-file REST blob uploads and caller-supplied API deadline
// extensions, so do not use this estimate as a new hard gate without review.
function computeResidualPastDeadlineSec({
  gitNetTimeoutSec = GIT_NET_TIMEOUT_SEC,
  opMinTimeoutSec = PUSH_OP_MIN_TIMEOUT_SEC,
} = {}) {
  const net = Number.isFinite(gitNetTimeoutSec) && gitNetTimeoutSec > 0 ? gitNetTimeoutSec : GIT_NET_TIMEOUT_SEC;
  const floor = Number.isFinite(opMinTimeoutSec) && opMinTimeoutSec > 0 ? opMinTimeoutSec : PUSH_OP_MIN_TIMEOUT_SEC;
  const fullOpSec = net + 10; // timeout's TERM-to-KILL grace
  const clampedOpSec = Math.min(net, floor) + 10;
  const rebaseCpuSec = 180; // measured worst case, push-with-retry.sh task #458
  const survivalFetchesSec = 2 * fullOpSec;
  // REST attempt-push has its own 60s cap (push-via-git-api.sh), even when
  // GIT_NET_TIMEOUT_SEC is lower. Cover either update transport, plus the
  // parent's full-cap post-API refresh. Per-file REST uploads remain excluded.
  const refUpdateSec = Math.max(net, 60) + 10;
  const apiFallbackSec = 3 * clampedOpSec + refUpdateSec + fullOpSec;
  return fullOpSec + rebaseCpuSec + clampedOpSec + survivalFetchesSec + apiFallbackSec;
}

// push-with-retry.sh's per-attempt backoff, WAIT=3+i*2 with the 0-4s jitter
// dropped. Single source of truth shared with computeBackoffSum's closed form
// above — a test asserts the two agree, so the formula cannot drift in one
// place only (adversarial review finding, 2026-09-02).
function backoffForAttempt(i) {
  return 3 + 2 * i;
}

// push-with-retry.sh ~L594: _default_fallback_after=$(( (MAX_RETRIES + 1) / 2 )),
// floored at 3, then PUSH_API_FALLBACK_AFTER_ATTEMPTS=${PUSH_API_FALLBACK_AFTER_ATTEMPTS:-$_default_fallback_after}.
// Bash `/` on positive integers truncates toward zero, same as Math.floor here
// since maxRetries+1 is always >= 0.
function computeEffectiveFallbackAfter(maxRetries, explicitOverride) {
  if (explicitOverride != null) return explicitOverride;
  return Math.max(3, Math.floor((maxRetries + 1) / 2));
}

function computeFundableAttempts(maxRetries, deadlineSec, attemptSec = MIN_TIMED_OUT_ATTEMPT_SEC) {
  if (!(maxRetries > 0) || !(deadlineSec > 0)) return 0;
  let elapsed = 0;
  let attempts = 0;
  for (let i = 1; i <= maxRetries; i++) {
    if (elapsed >= deadlineSec) break; // the loop-top deadline check
    attempts += 1;
    elapsed += attemptSec + backoffForAttempt(i); // this attempt's ops, then its backoff
  }
  return attempts;
}

// { touches, apiFallbackSafe } — apiFallbackSafe is true only when EVERY
// MANAGED file this run text touches has a working Git Data API rescue path
// (core-data-merge-registry.js's apiFallbackSafe: true). SECOND-OPINION
// FINDING (card #1910 review): the first draft weighted every managed-file
// touch identically for contentionScore, but a file with a verified fallback
// (e.g. audit/imageless-scored-shows.json) is a materially different risk
// than one the registry documents as having NO safe fallback (shows.json,
// scraper-spend-ledger.jsonl) — raising MAX_RETRIES on the former is
// plausibly polishing a problem the fallback already covers.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches `base` only at a path/word boundary — plain substring matching
// false-positives badly here because several real managed basenames are
// themselves substrings of other real managed basenames (e.g. 'shows.json'
// inside 'diary-shows.json' and 'audit/imageless-scored-shows.json'), so
// `runText.includes(base)` corrupted apiFallbackSafe for a file matched only
// as a false substring hit on an unrelated, differently-scored sibling file.
function runTextTouchesBasename(runText, base) {
  return new RegExp(`(?<![\\w.-])${escapeRegExp(base)}(?![\\w.-])`).test(runText);
}

function managedFileInfo(runText) {
  let touches = false;
  let apiFallbackSafe = true;
  for (const [base, info] of MANAGED_FILE_INFO) {
    if (runTextTouchesBasename(runText, base)) {
      touches = true;
      if (!info.apiFallbackSafe) apiFallbackSafe = false;
    }
  }
  return { touches, apiFallbackSafe: touches ? apiFallbackSafe : false };
}

function touchesManagedFile(runText) {
  return managedFileInfo(runText).touches;
}

// Rough contention proxy from a workflow's `cron:` schedule(s): the smallest
// inferred interval (minutes) across every cron expression found. Not a full
// calendar simulation (scripts/audit-cron-health-coverage.js's worstGapHours
// does that for a different purpose) — just enough to rank "runs every 15
// minutes" above "runs once a week" for prioritization. Returns null if no
// cron trigger is present (contention from schedule frequency is then
// unknown, not zero — callers should treat null as neutral, not low-risk).
function estimateCronIntervalMinutes(text) {
  const crons = [...text.matchAll(/-?\s*cron:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (crons.length === 0) return null;
  let best = Infinity;
  for (const expr of crons) {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) continue;
    const [minute, hour] = fields;
    const minuteStep = minute.match(/^\*\/(\d+)$/);
    const hourStep = hour.match(/^\*\/(\d+)$/);
    let interval;
    if (minuteStep && hour === '*') interval = parseInt(minuteStep[1], 10);
    else if (hourStep && minute !== '*') interval = parseInt(hourStep[1], 10) * 60;
    else if (minute === '*' && hour === '*') interval = 1;
    else interval = 24 * 60; // fixed daily/weekly-ish time — treat as low-frequency
    best = Math.min(best, interval);
  }
  return best === Infinity ? null : best;
}

/**
 * Evaluate one push-with-retry step against its job. `otherStepsBudgetSec` is
 * the caller-computed sum of every OTHER step's worst-case budget in the same
 * job: explicit `timeout-minutes:` steps PLUS every sibling push-with-retry.sh
 * call's own stepBudgetSec (see auditWorkflowText below — a job with several
 * push steps can exhaust its timeout on the sum of all of them even when each
 * looks fine evaluated alone; SECOND-OPINION FINDING, card #1910 review: the
 * first draft only summed explicit-timeout siblings, silently missing this).
 *
 * @returns {{
 *   maxRetries: number, deadlineSec: number, backoffSum: number,
 *   retryDeadlineRatio: number, jobTimeoutSec: number, stepBudgetSec: number,
 *   otherStepsBudgetSec: number, marginSec: number, marginRatio: number,
 *   fallbackAfterAttempts: number, fallbackEarlyTriggerReachable: boolean,
 *   residualPastDeadlineSec: number, stepBudgetWithResidualSec: number,
 *   otherStepsBudgetWithResidualSec: number, marginWithResidualSec: number,
 *   marginRatioWithResidual: number, advisoryFlags: string[],
 *   flags: string[]
 * }}
 */
function evaluateStep({
  maxRetries, deadlineSec, jobTimeoutMinutes, otherStepsBudgetSec = 0,
  blockingOtherStepsBudgetSec = otherStepsBudgetSec,
  fallbackAfterAttemptsOverride = null, fallbackDisabled = false,
  gitNetTimeoutSec = GIT_NET_TIMEOUT_SEC, opMinTimeoutSec = PUSH_OP_MIN_TIMEOUT_SEC,
  otherStepsBudgetWithResidualSec = otherStepsBudgetSec,
}) {
  const backoffSum = computeBackoffSum(maxRetries);
  const retryDeadlineRatio = deadlineSec > 0 ? backoffSum / deadlineSec : Infinity;
  const jobTimeoutSec = (jobTimeoutMinutes == null ? DEFAULT_JOB_TIMEOUT_MIN : jobTimeoutMinutes) * 60;
  const stepBudgetSec = Math.max(deadlineSec, backoffSum);
  const marginSec = jobTimeoutSec - (stepBudgetSec + otherStepsBudgetSec);
  const marginRatio = jobTimeoutSec > 0 ? marginSec / jobTimeoutSec : -Infinity;
  const blockingMarginRatio = jobTimeoutSec > 0
    ? (jobTimeoutSec - stepBudgetSec - blockingOtherStepsBudgetSec) / jobTimeoutSec : -Infinity;
  const residualPastDeadlineSec = computeResidualPastDeadlineSec({ gitNetTimeoutSec, opMinTimeoutSec });
  const stepBudgetWithResidualSec = stepBudgetSec + residualPastDeadlineSec;
  const marginWithResidualSec = jobTimeoutSec - (stepBudgetWithResidualSec + otherStepsBudgetWithResidualSec);
  const marginRatioWithResidual = jobTimeoutSec > 0 ? marginWithResidualSec / jobTimeoutSec : -Infinity;
  const advisoryFlags = marginRatioWithResidual < MARGIN_THRESHOLD
    ? ['job-timeout-margin-with-residual-undersized'] : [];
  if (marginRatio < MARGIN_THRESHOLD && blockingMarginRatio >= MARGIN_THRESHOLD) {
    advisoryFlags.push('job-timeout-margin-estimated-undersized');
  }

  const fundableAttempts = computeFundableAttempts(maxRetries, deadlineSec);
  const fallbackAfterAttempts = computeEffectiveFallbackAfter(maxRetries, fallbackAfterAttemptsOverride);
  const fallbackEarlyTriggerReachable = fallbackDisabled || fundableAttempts >= fallbackAfterAttempts;

  const flags = [];
  if (retryDeadlineRatio < RETRY_DEADLINE_RATIO_THRESHOLD) {
    flags.push('retries-undersized-vs-deadline');
  }
  if (blockingMarginRatio < MARGIN_THRESHOLD) {
    flags.push('job-timeout-margin-undersized');
  }
  // BRO-2373: only a real undersizing when the deadline funds fewer attempts
  // than BOTH the configured retry count and the 3-attempt floor — a step that
  // deliberately configures MAX_RETRIES=1 is not undersized, it is small.
  if (fundableAttempts < Math.min(maxRetries, MIN_FUNDABLE_ATTEMPTS)) {
    flags.push('deadline-cannot-fund-retries');
  }
  // BRO-2811: same class as BRO-2370 DEFECT B, made systemic. push-with-retry.sh
  // checks its loop-top deadline BEFORE an attempt starts (~L1091, the same
  // control flow computeFundableAttempts models), so an attempt that would first
  // reach PUSH_API_FALLBACK_AFTER_ATTEMPTS (explicit override, else floor(3,
  // (MAX_RETRIES+1)/2) — mirrors push-with-retry.sh ~L594) never starts once
  // fundableAttempts attempts have already exhausted the deadline.
  //
  // CORRECTNESS NOTE (Codex adversarial ship-check finding, 2026-09-07): this
  // does NOT mean the Git Data API fallback "never engages" — push-with-
  // retry.sh's post-loop fallback block (~L2005) runs on ANY loop exit
  // (early-trigger break ~L1952 OR the deadline break ~L1255 OR full retry
  // exhaustion) as long as `_PUSH_API_FALLBACK_ELIGIBLE=true`, independent of
  // whether the early-trigger threshold itself was ever reached. What an
  // unreachable early-trigger actually costs: the fallback only gets invoked
  // LATE, after PUSH_DEADLINE_SEC is already exhausted, at which point
  // `_api_remaining_sec` (~L2200) is ~0 and push-via-git-api.sh's own retry
  // budget scales down to its minimum (2 attempts, vs up to 6 with time to
  // spare) — a real degradation, but not "never". Flag name and this comment
  // updated accordingly; see auditWorkflowText for the companion fix (this
  // flag is additionally gated off when the call's own staged files already
  // disqualify the fallback outright, in which case the trigger's
  // reachability is moot).
  if (!fallbackEarlyTriggerReachable) {
    flags.push('fallback-early-trigger-unreachable');
  }

  return {
    maxRetries, deadlineSec, backoffSum, retryDeadlineRatio,
    jobTimeoutSec, stepBudgetSec, otherStepsBudgetSec, marginSec, marginRatio,
    blockingOtherStepsBudgetSec, blockingMarginRatio,
    residualPastDeadlineSec, stepBudgetWithResidualSec, otherStepsBudgetWithResidualSec,
    marginWithResidualSec, marginRatioWithResidual, advisoryFlags,
    fundableAttempts, fallbackAfterAttempts, fallbackEarlyTriggerReachable,
    flags,
  };
}

/**
 * Sum of every OTHER step's worst-case budget in a job, for one push call
 * `pc` (see the BRO-2370 note inside auditWorkflowText for the dedupe rule).
 * Extracted (BRO-2801) so the remediation proposer reuses it instead of a copy.
 * @param {object[]} steps all steps, including script budgets and Checkout
 * @param {{step: object, stepBudgetSec: number}[]} pushCalls every push call in the job
 * @param {{step: object}} pc the call being evaluated (an element of pushCalls)
 * @param {string} budgetKey legacy or residual-inclusive budget field
 * @param {boolean} includeEstimates false only for the pre-existing hard gate
 */
function computeOtherStepsBudgetSec(steps, pushCalls, pc, budgetKey = 'stepBudgetSec', includeEstimates = true) {
  const { step } = pc;
  const otherStepInfo = new Map(); // step -> { capped, sec }
  for (const s of steps) {
    if (s !== step && s.timeoutMinutes != null) {
      otherStepInfo.set(s, { capped: true, sec: s.timeoutMinutes * 60 });
    } else if (includeEstimates) {
      // Script budgets cover the script, so a following push adds its own
      // budget. An explicit Actions timeout caps the entire sibling step.
      const sec = (s.timeBudgetMinutes || 0) * 60 + (s.checkoutEstimateSec || 0);
      if (sec) otherStepInfo.set(s, { capped: false, sec });
    }
  }
  for (const other of pushCalls) {
    if (other === pc) continue;
    // Preserve the legacy gate's same-step treatment. The advisory includes
    // sequential calls in this step too, each of which can overrun separately.
    if (other.step === step && budgetKey === 'stepBudgetSec') continue;
    const info = otherStepInfo.get(other.step);
    if (info && info.capped) continue; // explicit cap already fully bounds this step
    otherStepInfo.set(other.step, { capped: false, sec: (info?.sec || 0) + other[budgetKey] });
  }
  return [...otherStepInfo.values()].reduce((sum, v) => sum + v.sec, 0);
}

/**
 * Full per-workflow-file audit: parse, find every push-with-retry step in
 * every job, evaluate each, and attach a contention score for prioritization.
 * @param {string} text - raw workflow YAML
 * @param {string} filePath - for labeling in results (not read from disk here)
 */
function auditWorkflowText(text, filePath) {
  const parsed = parseWorkflow(text);
  const cronIntervalMinutes = estimateCronIntervalMinutes(text);
  const results = [];

  for (const job of parsed.jobs) {
    // First pass: every push-with-retry call in this job, with its own
    // stepBudgetSec, BEFORE computing any step's margin against its
    // siblings (a step's own budget doesn't depend on other steps, so this
    // can be done independently and reused as the sibling-sum input below).
    const pushCalls = [];
    for (const step of job.steps) {
      const calls = findPushRetryCalls(step.runText);
      const stagedPerCall = stagedPathsPerCall(step.runText);
      calls.forEach((call, callIdx) => {
        const deadlineSec = call.inlineDeadlineSec ?? step.envDeadlineSec ?? DEFAULT_DEADLINE_SEC;
        const stepBudgetSec = Math.max(deadlineSec, computeBackoffSum(call.maxRetries));
        const residualPastDeadlineSec = computeResidualPastDeadlineSec({
          gitNetTimeoutSec: step.envGitNetTimeoutSec,
          opMinTimeoutSec: step.envOpMinTimeoutSec,
        });
        pushCalls.push({ step, call, deadlineSec, stepBudgetSec,
          stepBudgetWithResidualSec: stepBudgetSec + residualPastDeadlineSec,
          stagedPaths: stagedPerCall[callIdx] || [] });
      });
    }

    for (let pcIdx = 0; pcIdx < pushCalls.length; pcIdx++) {
      const pc = pushCalls[pcIdx];
      const { step, call, deadlineSec, stagedPaths } = pc;
      // BRO-2370 second-opinion finding: a sibling step that BOTH declares its
      // own explicit timeout-minutes AND calls push-with-retry.sh used to be
      // counted TWICE: once via its declared cap and
      // again via pushCalls (its own computed stepBudgetSec) — inflating
      // otherStepsBudgetSec and producing false job-timeout-margin-undersized
      // flags. A step's real worst-case contribution is bounded by whichever
      // ceiling GitHub actually enforces: its own explicit timeout-minutes if
      // it declares one (that hard external kill fires regardless of what
      // push-with-retry.sh's internal deadline is doing), or its push-call
      // stepBudgetSec only when it has no explicit cap. Key each OTHER step
      // ONCE, by identity, so a capped+push-calling sibling is counted only
      // via its cap.
      const otherStepsBudgetSec = computeOtherStepsBudgetSec(job.steps, pushCalls, pc);
      const blockingOtherStepsBudgetSec = computeOtherStepsBudgetSec(
        job.steps, pushCalls, pc, 'stepBudgetSec', false,
      );
      const otherStepsBudgetWithResidualSec = computeOtherStepsBudgetSec(
        job.steps, pushCalls, pc, 'stepBudgetWithResidualSec',
      );

      const evaluation = evaluateStep({
        maxRetries: call.maxRetries,
        deadlineSec,
        jobTimeoutMinutes: job.timeoutMinutes,
        otherStepsBudgetSec,
        blockingOtherStepsBudgetSec,
        otherStepsBudgetWithResidualSec,
        gitNetTimeoutSec: step.envGitNetTimeoutSec,
        opMinTimeoutSec: step.envOpMinTimeoutSec,
        fallbackAfterAttemptsOverride: step.envFallbackAfterAttempts,
        fallbackDisabled: step.envFallbackDisabled === true,
      });

      // A push wrapped in `|| echo`/`|| true` or a `continue-on-error: true`
      // step already treats its own failure as tolerable — SECOND-OPINION
      // FINDING (card #1910 review): the first draft only checked for the
      // `|| echo` shell wrapper and missed that opening-night-poller.yml uses
      // the YAML-level `continue-on-error: true` field on 3 of its 6 push
      // steps to the same effect. Either form marks the call soft-fail.
      const softFail = call.softFail || step.continueOnError === true;

      const { touches: managed, apiFallbackSafe } = managedFileInfo(step.runText);

      // mixed-safety-bundle (BRO-2446): this call's OWN staged files (not the
      // whole step's — see stagedPathsPerCall's header comment) include at
      // least one apiFallbackSafe-eligible file AND at least one file that
      // disqualifies push-with-retry.sh's Git Data API fallback for the WHOLE
      // outgoing diff — exactly the BRO-2435 failure shape (a fixable single-
      // writer file's fallback eligibility defeated by one unaudited/multi-
      // writer path bundled into the same commit+push). Mutually exclusive by
      // classifyPushFallbackSafety's own construction, so this can only ever
      // fire with >=2 distinct staged paths.
      const mixedSafetyBundleSafeFiles = stagedPaths.filter((p) => classifyPushFallbackSafety(p).isApiFallbackSafe);
      const mixedSafetyBundleDisqualifyingFiles = stagedPaths.filter((p) => classifyPushFallbackSafety(p).disqualifiesFallback);
      const mixedSafetyBundle = mixedSafetyBundleSafeFiles.length > 0 && mixedSafetyBundleDisqualifyingFiles.length > 0;
      if (mixedSafetyBundle) evaluation.flags.push('mixed-safety-bundle');

      // BRO-2811 (Codex adversarial ship-check finding, 2026-09-07): a call
      // whose OWN known staged files already disqualify the Git Data API
      // fallback outright (classifyPushFallbackSafety's disqualifiesFallback —
      // the SAME per-call staged-path evidence mixed-safety-bundle above
      // already computes) would never get a working fallback regardless of
      // whether PUSH_API_FALLBACK_AFTER_ATTEMPTS is reachable — the trigger's
      // reachability is moot when the destination it triggers is disqualified
      // on file-safety grounds alone. Only suppresses on POSITIVE evidence of
      // disqualification (a known disqualifying path was actually staged);
      // stagedPaths being empty (a bulk-stage idiom this parser can't resolve,
      // see extractStagedPaths' documented blind spots) leaves the flag on
      // rather than guessing safety from an absence of evidence.
      if (mixedSafetyBundleDisqualifyingFiles.length > 0) {
        evaluation.flags = evaluation.flags.filter((f) => f !== 'fallback-early-trigger-unreachable');
      }

      // cross-step-stranding (BRO-2580, the BRO-2538 cascade): a soft-fail
      // (continue-on-error / `|| echo`) push EARLIER in the same job that
      // stages a fallback-disqualifying file can strand its commit locally on
      // total failure; that stranded commit then rides this later call's
      // outgoing diff and disqualifies ITS Git Data API fallback too, even
      // though everything this call stages is apiFallbackSafe. Needs positive
      // evidence on both sides (non-empty, all-safe staged paths here; a known
      // disqualifying path staged by the earlier soft-fail call).
      // "Still fallback-eligible" = nothing staged disqualifies it (apiFallbackSafe
      // and apiFallbackMerge files both keep the fallback), and at least one file
      // is known. The earlier call strands if it is soft-fail, or if this step
      // runs after failures (`if: always()` / `failure()`).
      const stillEligible = stagedPaths.length > 0
        && !stagedPaths.some((p) => classifyPushFallbackSafety(p).disqualifiesFallback);
      const crossStepStrandingEarlier = stillEligible
        ? pushCalls.slice(0, pcIdx)
          .filter((e) => (e.call.softFail || e.step.continueOnError === true || step.runsAfterFailure === true)
            && e.step !== step
            && e.stagedPaths.some((p) => classifyPushFallbackSafety(p).disqualifiesFallback))
          .map((e) => e.step.name || '(unnamed step)')
        : [];
      const crossStepStranding = crossStepStrandingEarlier.length > 0;
      if (crossStepStranding) evaluation.flags.push('cross-step-stranding');

      let contentionScore = 0;
      if (managed) contentionScore += apiFallbackSafe ? 1 : 2;
      if (cronIntervalMinutes != null) {
        if (cronIntervalMinutes <= 30) contentionScore += 2;
        else if (cronIntervalMinutes <= 180) contentionScore += 1;
      }
      if (evaluation.flags.includes('retries-undersized-vs-deadline')) contentionScore += 1;
      if (evaluation.flags.includes('job-timeout-margin-undersized')) contentionScore += 2;
      if (mixedSafetyBundle) contentionScore += 2;
      if (crossStepStranding) contentionScore += 2;
      if (softFail) contentionScore = Math.max(0, contentionScore - 3);

      results.push({
        file: filePath,
        job: job.key,
        step: step.name,
        touchesManagedFile: managed,
        apiFallbackSafe,
        softFail,
        cronIntervalMinutes,
        contentionScore,
        mixedSafetyBundle,
        mixedSafetyBundleSafeFiles,
        mixedSafetyBundleDisqualifyingFiles,
        crossStepStranding,
        crossStepStrandingEarlierSteps: [...new Set(crossStepStrandingEarlier)],
        ...evaluation,
      });
    }
  }

  return results;
}

// BRO-2456: one GitHub Actions `::warning` per mixed-safety-bundle call site,
// built from the audit's --json report shape ({ranked: [...]}). Advisory only:
// the caller prints these and never changes its exit code from them.
function escapeAnnotationData(v) {
  return String(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeAnnotationProp(v) {
  return escapeAnnotationData(v).replace(/:/g, '%3A').replace(/,/g, '%2C');
}
function buildMixedBundleAnnotations(report) {
  const ranked = (report && Array.isArray(report.ranked)) ? report.ranked : [];
  return ranked.filter((r) => r && r.mixedSafetyBundle).map((r) => {
    const list = (a) => { const f = a || []; return f.slice(0, 3).join(', ') + (f.length > 3 ? `, +${f.length - 3} more` : ''); };
    const safe = list(r.mixedSafetyBundleSafeFiles);
    const bad = list(r.mixedSafetyBundleDisqualifyingFiles);
    const msg = `mixed-safety-bundle in job "${r.job}" step "${r.step}": apiFallbackSafe file(s) [${safe}] share one commit+push with disqualifying file(s) [${bad}], which defeats the Git Data API fallback for both (BRO-2435 shape). Split into separate git-add-existing.sh + push-with-retry.sh calls.`;
    return `::warning file=.github/workflows/${escapeAnnotationProp(r.file)},title=${escapeAnnotationProp('push-retry mixed-safety-bundle')}::${escapeAnnotationData(msg)}`;
  });
}

module.exports = {
  budgetMinutesFrom,
  CHECKOUT_ESTIMATE_SEC,
  buildMixedBundleAnnotations,
  computeOtherStepsBudgetSec,
  DEFAULT_MAX_RETRIES,
  DEFAULT_DEADLINE_SEC,
  DEFAULT_JOB_TIMEOUT_MIN,
  MARGIN_THRESHOLD,
  RETRY_DEADLINE_RATIO_THRESHOLD,
  GIT_NET_TIMEOUT_SEC,
  PUSH_OP_MIN_TIMEOUT_SEC,
  MIN_TIMED_OUT_ATTEMPT_SEC,
  MIN_FUNDABLE_ATTEMPTS,
  backoffForAttempt,
  computeFundableAttempts,
  computeEffectiveFallbackAfter,
  parseWorkflow,
  findPushRetryCalls,
  countRawCallSites,
  computeBackoffSum,
  computeResidualPastDeadlineSec,
  touchesManagedFile,
  managedFileInfo,
  classifyPushFallbackSafety,
  extractStagedPaths,
  stagedPathsPerCall,
  estimateCronIntervalMinutes,
  evaluateStep,
  auditWorkflowText,
};
