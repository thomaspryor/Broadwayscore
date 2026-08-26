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
// Two independent flags come out of this module:
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
//   2. marginRatio — the job-timeout-headroom check #1891's follow-up commit
//      caught. A push step's realistic worst-case wall time is bounded by
//      PUSH_DEADLINE_SEC itself (the Git Data API fallback also runs inside
//      whatever deadline budget remains — see push-with-retry.sh's
//      "_api_remaining_sec" — so total step time rarely exceeds the deadline
//      by much). stepBudgetSec is therefore max(deadlineSec, backoffSum) —
//      backoffSum only wins when MAX_RETRIES is set high enough to outrun a
//      too-small deadline, an unusual but possible misconfiguration.
//      "Other named step budgets" = the sum of every OTHER step in the same
//      job that declares its own explicit `timeout-minutes:` (undeclared
//      steps aren't counted — there's no static bound to sum). Flagged when
//      the job timeout leaves under MARGIN_THRESHOLD (15%) of headroom past
//      stepBudgetSec + those other steps' budgets.
//
// No YAML library (none of the CI jobs that would run this npm-install first;
// same constraint scripts/lib/ci-cancellation-guard.js documents). Parsed
// with the same indentation-aware line reader that file uses.
'use strict';

const DEFAULT_MAX_RETRIES = 7; // push-with-retry.sh: MAX_RETRIES=${1:-7}
const DEFAULT_DEADLINE_SEC = 240; // push-with-retry.sh: PUSH_DEADLINE_SEC=${PUSH_DEADLINE_SEC:-240}
const DEFAULT_JOB_TIMEOUT_MIN = 360; // GitHub Actions' own default when a job omits timeout-minutes

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
try {
  // eslint-disable-next-line global-require
  const { CORE_DATA_MERGE_REGISTRY, activeEntriesFor, apiFallbackSafeEntriesFor } = require('./core-data-merge-registry.js');
  for (const entry of CORE_DATA_MERGE_REGISTRY) {
    const base = entry.file.split('/').pop();
    const prev = MANAGED_FILE_INFO.get(base);
    const apiFallbackSafe = entry.apiFallbackSafe === true && (prev ? prev.apiFallbackSafe : true);
    MANAGED_FILE_INFO.set(base, { apiFallbackSafe });
  }
  PUBLIC_REPO_MANAGED_FILES = activeEntriesFor('public-repo').map((e) => e.file);
  PUBLIC_REPO_API_FALLBACK_SAFE_FILES = apiFallbackSafeEntriesFor('public-repo').map((e) => e.file);
} catch {
  MANAGED_FILE_INFO = new Map();
  PUBLIC_REPO_MANAGED_FILES = [];
  PUBLIC_REPO_API_FALLBACK_SAFE_FILES = [];
}

// data/shows.json / data/reviews.json — push-with-retry.sh's NEVER_FALLBACK
// list (fail-closed regardless of MANAGED/API_FALLBACK_SAFE membership).
const NEVER_FALLBACK_FILES = ['data/shows.json', 'data/reviews.json'];

/**
 * Classify one staged repo-relative file path exactly the way push-with-
 * retry.sh's disqualifier does: `isApiFallbackSafe` mirrors its
 * isApiFallbackSafe(f); `disqualifiesFallback` mirrors the `hit` predicate
 * (isManaged || isNeverFallback || unaudited-data/audit/-path). The two are
 * mutually exclusive by registry construction (an apiFallbackSafe: true
 * entry is never also `status: 'active'` on the same surface).
 */
function classifyPushFallbackSafety(filePath) {
  const isManaged = PUBLIC_REPO_MANAGED_FILES.some((f) => filePath.endsWith(f));
  const isApiFallbackSafe = PUBLIC_REPO_API_FALLBACK_SAFE_FILES.some((f) => filePath.endsWith(f));
  const isNeverFallback = NEVER_FALLBACK_FILES.some((p) => filePath === p || filePath.endsWith('/' + p));
  const disqualifiesFallback = isManaged || isNeverFallback || (filePath.startsWith('data/audit/') && !isManaged && !isApiFallbackSafe);
  return { isApiFallbackSafe, disqualifiesFallback };
}

// Extract literal `data/...` file-path arguments staged in `runText` via
// `git-add-existing.sh` or plain `git add` invocations (the two shapes used
// across every workflow — see BRO-2446 evidence grep). Best-effort/advisory,
// matching this module's existing parse philosophy: flags (`-u`, `--force`,
// …), shell variables (`$f`, `"${arr[@]}"`), and bare directory adds
// (`data/audit/`, trailing slash — can't be resolved to specific files
// statically) are skipped rather than guessed at, so this only ever
// UNDER-reports staged paths, never fabricates one. Runs against the WHOLE
// runText (not one line) since real workflows stage several files across
// separate `git add` lines before a single commit+push.
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
      for (const tokRaw of rest.trim().split(/\s+/)) {
        if (!tokRaw) continue;
        const tok = tokRaw.replace(/^['"]|['"]$/g, '');
        if (tok.startsWith('-')) continue;
        if (tok.includes('$')) continue;
        if (tok.endsWith('/')) continue;
        if (!tok.startsWith('data/')) continue;
        paths.add(tok);
      }
    }
  }
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

/**
 * Parse a workflow YAML file's text into { jobs: [{ key, timeoutMinutes,
 * steps: [{ name, runText, envDeadlineSec, timeoutMinutes }] }] }.
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
        const envField = findChildKey(kids, 'env');
        const stepTimeoutField = findChildKey(kids, 'timeout-minutes');
        const continueOnErrorField = findChildKey(kids, 'continue-on-error');

        const runText = runField ? scalarBlockText(lines, runField.idx, runField.inline) : '';
        let envDeadlineSec = null;
        if (envField) {
          const envKids = childLines(lines, envField.idx);
          const deadlineField = findChildKey(envKids, 'PUSH_DEADLINE_SEC');
          if (deadlineField) envDeadlineSec = parseIntOrNull(deadlineField.inline.replace(/^['"]|['"]$/g, ''));
        }

        step.name = nameField ? nameField.inline.replace(/^['"]|['"]$/g, '') : null;
        step.runText = runText;
        step.envDeadlineSec = envDeadlineSec;
        step.timeoutMinutes = stepTimeoutField ? parseIntOrNull(stepTimeoutField.inline) : null;
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

// N^2+4N: sum_{i=1..N} (3 + 2i), push-with-retry.sh's WAIT=3+i*2+jitter
// backoff formula with the 0-4s random jitter term dropped (worst-case floor,
// not ceiling — jitter only ever adds time).
function computeBackoffSum(maxRetries) {
  return maxRetries * maxRetries + 4 * maxRetries;
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
 *   flags: string[]
 * }}
 */
function evaluateStep({ maxRetries, deadlineSec, jobTimeoutMinutes, otherStepsBudgetSec = 0 }) {
  const backoffSum = computeBackoffSum(maxRetries);
  const retryDeadlineRatio = deadlineSec > 0 ? backoffSum / deadlineSec : Infinity;
  const jobTimeoutSec = (jobTimeoutMinutes == null ? DEFAULT_JOB_TIMEOUT_MIN : jobTimeoutMinutes) * 60;
  const stepBudgetSec = Math.max(deadlineSec, backoffSum);
  const marginSec = jobTimeoutSec - (stepBudgetSec + otherStepsBudgetSec);
  const marginRatio = jobTimeoutSec > 0 ? marginSec / jobTimeoutSec : -Infinity;

  const flags = [];
  if (retryDeadlineRatio < RETRY_DEADLINE_RATIO_THRESHOLD) {
    flags.push('retries-undersized-vs-deadline');
  }
  if (marginRatio < MARGIN_THRESHOLD) {
    flags.push('job-timeout-margin-undersized');
  }

  return {
    maxRetries, deadlineSec, backoffSum, retryDeadlineRatio,
    jobTimeoutSec, stepBudgetSec, otherStepsBudgetSec, marginSec, marginRatio,
    flags,
  };
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
    const explicitTimeoutSteps = job.steps.filter((s) => s.timeoutMinutes != null);

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
        pushCalls.push({ step, call, deadlineSec, stepBudgetSec, stagedPaths: stagedPerCall[callIdx] || [] });
      });
    }

    for (const pc of pushCalls) {
      const { step, call, deadlineSec, stagedPaths } = pc;
      const explicitOtherSec = explicitTimeoutSteps
        .filter((s) => s !== step)
        .reduce((sum, s) => sum + s.timeoutMinutes * 60, 0);
      const siblingPushOtherSec = pushCalls
        .filter((other) => other !== pc)
        .reduce((sum, other) => sum + other.stepBudgetSec, 0);
      const otherStepsBudgetSec = explicitOtherSec + siblingPushOtherSec;

      const evaluation = evaluateStep({
        maxRetries: call.maxRetries,
        deadlineSec,
        jobTimeoutMinutes: job.timeoutMinutes,
        otherStepsBudgetSec,
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

      let contentionScore = 0;
      if (managed) contentionScore += apiFallbackSafe ? 1 : 2;
      if (cronIntervalMinutes != null) {
        if (cronIntervalMinutes <= 30) contentionScore += 2;
        else if (cronIntervalMinutes <= 180) contentionScore += 1;
      }
      if (evaluation.flags.includes('retries-undersized-vs-deadline')) contentionScore += 1;
      if (evaluation.flags.includes('job-timeout-margin-undersized')) contentionScore += 2;
      if (mixedSafetyBundle) contentionScore += 2;
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
        ...evaluation,
      });
    }
  }

  return results;
}

module.exports = {
  DEFAULT_MAX_RETRIES,
  DEFAULT_DEADLINE_SEC,
  DEFAULT_JOB_TIMEOUT_MIN,
  MARGIN_THRESHOLD,
  RETRY_DEADLINE_RATIO_THRESHOLD,
  parseWorkflow,
  findPushRetryCalls,
  countRawCallSites,
  computeBackoffSum,
  touchesManagedFile,
  managedFileInfo,
  classifyPushFallbackSafety,
  extractStagedPaths,
  stagedPathsPerCall,
  estimateCronIntervalMinutes,
  evaluateStep,
  auditWorkflowText,
};
