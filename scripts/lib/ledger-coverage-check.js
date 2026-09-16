/**
 * Lint check: any GitHub Actions job that runs `node scripts/<file>.js`
 * where <file>.js (or a file it transitively requires) actually CALLS
 * scripts/lib/url-discovery.js's serpQuery() or discoverCorrectUrl() — the
 * only two exports that reach its telemetry writers (recordBdCall/
 * recordSbCall/recordSdCall via _serpWithChain, verified 2026-08-04: every
 * other export is either a pure data constant like OUTLET_DOMAINS or a
 * helper with no SERP call) — must also stage
 * data/audit/scraper-spend-ledger.jsonl for commit in the SAME job, or the
 * telemetry is silently discarded when the runner exits (card 3b1637c5:
 * 19/~40 SERP-calling workflows had this gap; 18 fixed by hand in
 * 436f4a24092/943bd4a9327 — this check is the structural guard so the 20th
 * never needs a manual Explore-agent audit).
 *
 * BRO-2961 (2026-09-07): scraper.js's fetchPage() is now ALSO tracked. It
 * writes ledger rows for every BD/SB/SD call (recordBdCall/recordSbCall/
 * recordSdCall in scraper.js, imported from ./bd-telemetry) and is used by
 * ~300 of this repo's ~330 scripts/*.js — a naive add of it here flagged 107
 * violations across 83 workflows on a clean main back on 2026-08-04, before
 * this checker had lineStagesLedgerViaDirectAdd/lineStagesLedgerViaHelper/
 * matchForLoopStart or the commit-scraper-spend-ledger composite-action
 * detection (COMMIT_LEDGER_ACTION_RE) — all of which now correctly recognize
 * staging patterns that a bare LEDGER_FILE substring search missed. Re-run on
 * 2026-09-07 with today's checker: only 12 real gaps found (aggregator-url-
 * watcher, audit-reverse-discovery, backfill-review-dates, discover-
 * historical-shows, enrich-reviews, enrich-runtimes, generate-theater-tips,
 * ingest-urls, process-review-submission, update-broadway-com, update-
 * commercial, update-lottery-rush — all fixed), far smaller than BRO-2961's
 * original 44-file candidate list (a naive `grep SCRAPINGBEE_API_KEY` over
 * workflow YAML), which over-counted by including false positives like
 * scraper-cost-report.yml's SB-billing-API curl and opening-night-
 * orchestrator.yml's SB-quota-check-only steps — neither calls fetchPage().
 *
 * DETECTION METHOD: a real (acorn) AST walk, not text regex, because
 * "requires the file" is not the same as "calls the SERP function" —
 * rebuild-all-reviews.js requires url-discovery.js but only destructures
 * OUTLET_DOMAINS/REGISTRY_DOMAIN_ALIASES (data, never called); flagging it
 * would be a false positive of exactly the kind that made check_core_data_
 * pairing's v1 a dead no-op (see that check's history comment). The walk
 * itself (parse, collect require() bindings, resolve calls transitively,
 * memoized + cycle-safe) is shared with alert-ledger-commit-check.js via
 * scripts/lib/require-graph-ast.js (BRO-3671) — that file's own tracked
 * module is owner-alert-router.js's routeAlert/resolveCondition, not
 * url-discovery.js/scraper.js, but the reachability engine (and the
 * false-positive class an AST walk avoids that a text-regex version does
 * not — see require-graph-ast.js's header) is identical.
 *
 * KNOWN LIMITATIONS: only sees `node scripts/<path>.js` invocations written
 * literally in the workflow YAML; only static/relative requires (no dynamic
 * requires, no computed member-expression calls); a script invoked
 * indirectly (spawned as a subprocess by another script) is invisible.
 */

const fs = require('fs');
const path = require('path');
const { findTrackedCallerScripts } = require('./require-graph-ast');

const LEDGER_FILE = 'scraper-spend-ledger.jsonl';
const LEDGER_PATH = 'data/audit/scraper-spend-ledger.jsonl';
// The reusable composite action (BRO-163) that wraps the canonical
// git-add/commit/push pattern this whole check exists to enforce — its own
// `git add data/audit/scraper-spend-ledger.jsonl` line lives inside
// .github/actions/commit-scraper-spend-ledger/action.yml, invisible to a
// scan of the CALLING workflow's YAML text. A job that `uses:` it counts as
// staging the ledger without the check needing to open the action file.
const COMMIT_LEDGER_ACTION_RE = /uses:\s*\.\/\.github\/actions\/commit-scraper-spend-ledger\b/;
// lib basename -> tracked export names that reach a telemetry writer.
const TRACKED_TARGETS = new Map([
  ['url-discovery.js', new Set(['serpQuery', 'discoverCorrectUrl'])],
  ['scraper.js', new Set(['fetchPage'])],
]);
const JOB_KEY_RE = /^  ([A-Za-z0-9_.-]+):\s*$/;
const SCRIPT_INVOKE_RE = /\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*scripts\/([A-Za-z0-9_./-]+\.js)/g;
const COMMENT_LINE_RE = /^\s*#/;

// A bash `for VAR in <list>; do` on one line, tolerating a trailing
// `# comment` after `do` (task #763's exemption-marker convention lives
// there). Same pattern as scripts/lib/alert-ledger-commit-check.js's
// matchForLoopStart — several ledger-committing workflows (audit-aggregator-
// gap.yml, audit-census-recall.yml, coverage-adversarial-probe.yml) stage
// the ledger file via a shared `for f in <file-list>; do git add "$f"; done`
// loop, not a standalone `git add data/audit/scraper-spend-ledger.jsonl`
// line — missing this pattern would false-positive all three.
const FOR_LOOP_INLINE_DO_RE = /^\s*for\s+(\w+)\s+in\s+(.+?);\s*do\s*(?:#.*)?$/;
const FOR_LOOP_HEADER_RE = /^\s*for\s+(\w+)\s+in\s+(.+?)\s*$/;
const BARE_DO_RE = /^\s*do\s*$/;
const DONE_RE = /^\s*done\s*$/;

// Joins bash `\`-continued lines (audit-census-recall.yml and others spread
// a long `for f in <files>; do` list across multiple lines this way) into
// one logical line per statement, so matchForLoopStart sees the whole list.
function joinBackslashContinuations(lines) {
  const result = [];
  let buffer = '';
  let buffering = false;
  for (const line of lines) {
    const continues = /\\\s*$/.test(line);
    const stripped = line.replace(/\\\s*$/, '');
    buffer = buffering ? buffer + ' ' + stripped.trim() : stripped;
    if (continues) {
      buffering = true;
    } else {
      result.push(buffer);
      buffer = '';
      buffering = false;
    }
  }
  if (buffering) result.push(buffer);
  return result;
}

// Returns { varName, list, bodyStart } if `line` (at index i in jobLines)
// starts a `for VAR in <list>; do` loop — inline or with `do` on the next
// line — else null. bodyStart is the index of the first line inside the loop.
function matchForLoopStart(jobLines, i) {
  const line = jobLines[i];
  let m = line.match(FOR_LOOP_INLINE_DO_RE);
  if (m) return { varName: m[1], list: m[2], bodyStart: i + 1 };
  m = line.match(FOR_LOOP_HEADER_RE);
  if (m && jobLines[i + 1] && BARE_DO_RE.test(jobLines[i + 1])) {
    return { varName: m[1], list: m[2], bodyStart: i + 2 };
  }
  return null;
}

/**
 * findLedgerScripts(scriptsDir) -> Set<string>
 * Returns scripts/-relative paths (e.g. "audit-closing-dates.js") for every
 * .js file under scriptsDir whose own code calls url-discovery.js's
 * serpQuery/discoverCorrectUrl, directly or transitively. Returns an empty
 * set (fails open, logs nothing — callers should treat this as "skip the
 * check") if acorn isn't installed. Thin wrapper over the shared
 * require-graph-ast.js engine (BRO-3671) — see that file's header for the
 * AST walk itself.
 */
function findLedgerScripts(scriptsDir) {
  return findTrackedCallerScripts(scriptsDir, TRACKED_TARGETS);
}


function splitJobs(workflowYamlText) {
  const lines = workflowYamlText.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsIdx === -1) return [];

  const starts = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(JOB_KEY_RE);
    if (m) starts.push({ name: m[1], start: i });
  }

  return starts.map((job, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].start : lines.length;
    return { name: job.name, lines: lines.slice(job.start, end) };
  });
}

// Returns the list of ledgerScripts entries this job invokes via
// `node scripts/<path>.js`, deduped and in first-seen order.
function jobInvokesLedgerScripts(jobLines, ledgerScripts) {
  const invoked = [];
  for (const line of jobLines) {
    if (COMMENT_LINE_RE.test(line)) continue;
    SCRIPT_INVOKE_RE.lastIndex = 0;
    let m;
    while ((m = SCRIPT_INVOKE_RE.exec(line))) {
      if (ledgerScripts.has(m[1]) && !invoked.includes(m[1])) invoked.push(m[1]);
    }
  }
  return invoked;
}

// True if `arg` (a path passed to stage-data-changes.sh) covers the ledger
// file — either the exact path or a directory prefix of it (matched on a
// path-segment boundary, so 'data/aud' does NOT wrongly match 'data/audit/').
function argCoversLedgerPath(arg) {
  const a = arg.replace(/\/+$/, '');
  if (a === '') return false;
  return LEDGER_PATH === a || LEDGER_PATH.startsWith(a + '/');
}

// Does `line` invoke scripts/lib/stage-data-changes.sh in a way that stages
// the ledger file? With no path arguments it stages all of data/ (see that
// script's own usage comment); with arguments, only paths that are the
// ledger file itself or a directory prefix of it (e.g. `data/audit/`,
// `data/`) count. Real example: recover-explicit-ratings.yml stages via
// `bash scripts/lib/stage-data-changes.sh data/audit/` — a plain `git add
// <ledger-file>` text search would miss this entirely.
function lineStagesLedgerViaHelper(line) {
  const m = line.match(/stage-data-changes\.sh([^#]*)/);
  if (!m) return false;
  const argsStr = m[1].trim();
  if (argsStr === '') return true; // no args = stages all of data/
  const args = argsStr.split(/\s+/);
  return args.some(argCoversLedgerPath);
}

// Does a bare `git add <path...>` line (no stage-data-changes.sh helper, no
// literal ledger filename) cover the ledger file via a directory-prefix or
// exact-path operand — e.g. `git add data/audit/` or `git add data/`? Real
// examples: collect-review-texts.yml:368/742, collect-free-reviews.yml:362,
// collect-soft-paywall.yml, collect-hard-paywall.yml, overnight-collect.yml
// all stage via a bare directory add, not the literal filename — a
// LEDGER_FILE substring search misses every one of them (found by BRO-163's
// pre-implementation review; see ledger-coverage-exemptions.js history).
// Operands containing a shell glob character are deliberately rejected —
// `git add data/audit/*.json` (opening-night-express.yml) does NOT cover the
// ledger's `.jsonl` extension, and this function can't safely evaluate glob
// semantics, so it conservatively treats globbed operands as non-covering
// (a real gap stays flagged rather than silently passing).
function lineStagesLedgerViaDirectAdd(line) {
  const m = line.match(/git add\b([^#]*)/);
  if (!m) return false;
  const argsStr = m[1].trim();
  if (argsStr === '') return false;
  const args = argsStr.split(/\s+/).filter((a) => a && !a.startsWith('-') && a !== '||' && a !== '&&');
  return args.some((a) => !/[*?[\]{}$]/.test(a) && argCoversLedgerPath(a));
}

// Does `line` invoke scripts/lib/git-add-existing.sh with the ledger path as
// a literal argument (BRO-2296)? That helper stages each pathspec
// independently — the fix for the exact "one missing file drops the whole
// `git add`" bug this checker's own header cites for stage-data-changes.sh —
// and is already the established pattern for a step that stages a short,
// literal, exact list of data/audit/ files (as opposed to a directory
// sweep). Same argument-matching logic as lineStagesLedgerViaDirectAdd:
// literal path operands only, `--force`/`-f` and globs excluded.
function lineStagesLedgerViaGitAddExisting(line) {
  const m = line.match(/git-add-existing\.sh\b([^#]*)/);
  if (!m) return false;
  const argsStr = m[1].trim();
  if (argsStr === '') return false;
  const args = argsStr.split(/\s+/).filter((a) => a && !a.startsWith('-'));
  return args.some((a) => !/[*?[\]{}$]/.test(a) && argCoversLedgerPath(a));
}

function jobStagesLedgerFile(jobLines) {
  const lines = joinBackslashContinuations(jobLines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE_RE.test(line)) continue;

    if (line.includes(LEDGER_FILE) && /git add\b/.test(line)) return true;
    if (lineStagesLedgerViaHelper(line)) return true;
    if (lineStagesLedgerViaDirectAdd(line)) return true;
    if (lineStagesLedgerViaGitAddExisting(line)) return true;
    if (COMMIT_LEDGER_ACTION_RE.test(line)) return true;

    const loopMatch = matchForLoopStart(lines, i);
    if (loopMatch && loopMatch.list.includes(LEDGER_FILE)) {
      const stageRe = new RegExp(`git add\\b.*\\$\\{?${loopMatch.varName}\\b`);
      for (let j = loopMatch.bodyStart; j < lines.length && !DONE_RE.test(lines[j]); j++) {
        if (!COMMENT_LINE_RE.test(lines[j]) && stageRe.test(lines[j])) return true;
      }
    }
  }
  return false;
}

/**
 * findMissingLedgerCommits(workflowYamlText, ledgerScripts) -> {job, message}[]
 * ledgerScripts: Set<string> from findLedgerScripts(scriptsDir) — compute
 * once per run (repo-wide) and pass in; the AST walk is the expensive part.
 *
 * Returns one {job, message} per job that invokes a ledger-reaching script
 * but never stages data/audit/scraper-spend-ledger.jsonl for commit in that
 * same job. `job` is the job name (for exemption-list matching by callers —
 * see scripts/lib/ledger-coverage-exemptions.js); `message` is the
 * human-readable reason. Empty array = clean.
 */
function findMissingLedgerCommits(workflowYamlText, ledgerScripts) {
  const violations = [];
  const jobs = splitJobs(workflowYamlText);
  for (const job of jobs) {
    const invoked = jobInvokesLedgerScripts(job.lines, ledgerScripts);
    if (invoked.length > 0 && !jobStagesLedgerFile(job.lines)) {
      violations.push({
        job: job.name,
        message: `job '${job.name}' runs ${invoked.join(', ')} (calls url-discovery.js's serpQuery/discoverCorrectUrl or scraper.js's fetchPage) but no step stages data/audit/${LEDGER_FILE} for commit in this job`,
      });
    }
  }
  return violations;
}

module.exports = {
  findLedgerScripts,
  findMissingLedgerCommits,
  splitJobs,
};
