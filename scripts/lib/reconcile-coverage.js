'use strict';
/**
 * Coverage check: a workflow STEP that pushes through push-with-retry.sh
 * AND commits one of the union-merged managed JSON files must either set
 * PUSH_RECONCILE_MERGED_JSON=1 on that step, or carry a `push-reconcile-ok:`
 * waiver comment explaining why it's safe without it. Task #574 — generalizes
 * the opt-in flag task #420 shipped for exactly one caller
 * (deep-research-commercial.yml) to the other 9 that need it.
 *
 * WHY STEP-SCOPED, NOT FILE-SCOPED
 * ---------------------------------
 * A naive "does this workflow mention push-with-retry.sh AND a managed
 * filename anywhere" grep (the informal audit that seeded this card's
 * exposure list) over-reports: test.yml and check-cron-health.yml both
 * mention commercial.json / commercial-pending-review.json in comments and
 * cron-name strings, and both call push-with-retry.sh for UNRELATED commits
 * (health-check ledgers, alert-router state, snapshot pushes) — neither push
 * touches a managed file. update-mezzanine.yml is subtler: diary-shows.json
 * IS one of its files, but it's written through the separate push-core-data
 * composite action (.github/actions/push-core-data/action.yml), which has
 * its own unconditional per-slug reconciliation and never calls
 * push-with-retry.sh — so none of that workflow's push-with-retry.sh steps
 * need the flag either.
 *
 * So this check operates PER STEP (the region between one `- name:` line and
 * the next), matching how a human would actually reason about "does *this*
 * push commit *that* file." A step needs the flag only when BOTH:
 *   1. it invokes `bash scripts/lib/push-with-retry.sh` (or the Node wrapper
 *      without `reconcileMergedJson: true` already set), AND
 *   2. a MANAGED file's basename appears literally in the step body — as a
 *      `git add` argument, a `git-add-existing.sh` / `stage-data-changes.sh`
 *      argument, or a shell variable assignment later passed to one of
 *      those (e.g. `QUEUE_FILE="data/commercial-research-queue.json"` then
 *      `git add "$QUEUE_FILE"` — both lines live in the same step, so the
 *      literal is still visible to a same-block scan).
 *
 * Detection is intentionally coarse (literal substring, not real bash/YAML
 * parsing) — same tradeoff scripts/lib/unbounded-fetch-guard.js makes for
 * the sibling #420 lint gate. Comment-only lines (trimmed line starts with
 * `#`) are blanked before matching, so a step whose only mention of a
 * managed file is an EXPLANATORY comment about a DIFFERENT step's push
 * (update-mezzanine.yml's "Commit and push watermark" step explains it's
 * gated on "the PRIVATE diary-shows.json push" succeeding — that push is a
 * different step entirely, via push-core-data) doesn't false-positive. A
 * reviewed false positive that survives comment-stripping still waives with
 * `push-reconcile-ok: <reason>` anywhere in the step, mirroring
 * `unbounded-fetch-ok:`.
 *
 * Everything here is PURE (string in, data out) so it's unit-testable per
 * project rule §15; the filesystem walk lives in
 * scripts/audit-reconcile-coverage.js.
 */

// Kept in sync with MANAGED in reconcile-merged-json.js.
const MANAGED_BASENAMES = [
  'commercial.json',
  'commercial-pending-review.json',
  'commercial-research-queue.json',
  'diary-shows.json',
  'social-post-history.json',
];

const PUSH_SH_RE = /push-with-retry\.sh\b/;
const PUSH_JS_CALL_RE = /pushWithRetry\s*\(/;
const RECONCILE_JS_TRUE_RE = /reconcileMergedJson\s*:\s*true/;
const FLAG_YAML_RE = /PUSH_RECONCILE_MERGED_JSON\s*:\s*['"]?1['"]?/;
// `export FOO=1` persists to every later command in the same `run: |` shell
// script (real bash semantics), so it's accepted anywhere in the step. A
// BARE (non-exported) `FOO=1 cmd` only scopes to that one command — accepted
// only when it directly prefixes the push-with-retry.sh invocation on the
// same line (ship-check/Codex finding: a bare assignment on an unrelated
// line, e.g. `PUSH_RECONCILE_MERGED_JSON=1 node other-script.js`, would
// previously satisfy this check without the push actually inheriting it).
const FLAG_EXPORT_RE = /\bexport\s+PUSH_RECONCILE_MERGED_JSON\s*=\s*['"]?1['"]?/;
const FLAG_INLINE_RE = /PUSH_RECONCILE_MERGED_JSON\s*=\s*['"]?1['"]?[^\n;&|]*push-with-retry\.sh/;
const WAIVER_RE = /push-reconcile-ok:\s*\S/;

/**
 * Patterns that stage more than a named set of paths — so a managed file
 * COULD be swept into the commit even though its basename never appears
 * literally in the step (ship-check/Codex finding: bare `stage-data-
 * changes.sh` calls in scrape-aggregators.yml, review-refresh.yml,
 * check-show-freshness.yml, scrape-westendtheatre.yml, and
 * scrape-waltz-costs.yml were all invisible to a basename-only scan).
 * `stage-data-changes.sh` with NO arguments stages all of `data/` (minus
 * copyright/PII exclusions — see its own header); `git add -A`/`git add
 * --all`/`git add .` and `git commit -a` are the generic shell equivalents.
 *
 * Two things are deliberately EXCLUDED because they are actually scoped:
 *   - `stage-data-changes.sh <path>` / `git add -A <pathspec>` — per `git
 *     add`'s own docs, `-A`/`--all` is only tree-wide with NO pathspec
 *     argument; given one, it stages only that pathspec (real bug found in
 *     an earlier cut: bulk-reddit-sentiment.yml's `git add -A data/reddit-
 *     shards/` false-positived as "stages everything"). The lookahead below
 *     requires a command terminator, not a path, right after the flag.
 *   - `git add -A` after `cd data/review-texts` — that directory is a
 *     SEPARATE git clone (broadway-review-texts, see the `git clone` at
 *     opening-night-poller.yml:495), so staging "everything" there stages
 *     that repo's tree, not this one's — the managed files don't even exist
 *     on disk at that point. See stepCdIntoSeparateRepo().
 */
const STAGE_ALL_RE = /(?:^|[;&|]|\n)\s*bash\s+\S*stage-data-changes\.sh\s*(?:$|[;&|\n#])|git\s+add\s+(?:-A|--all)\b(?=\s*(?:$|[;&|#\n]|2>))|git\s+add\s+\.(?:\s|$)|git\s+commit\s+.*-a\b/m;

/** True when the step `cd`s into a directory that's a SEPARATE git clone
 * (currently only `data/review-texts`, the private broadway-review-texts
 * repo — see checkout-review-texts and the `git clone` calls in
 * opening-night-poller.yml / ingest-urls.yml). Once inside, `git add -A`,
 * `push-with-retry.sh`, etc. all operate on THAT repo's tree, so they can
 * never touch this repo's managed JSON files regardless of what STAGE_ALL_RE
 * matches. Coarse (doesn't track a `cd` back out) — matches the rest of this
 * file's precision tradeoffs; no real step in this repo `cd`s back to the
 * parent and then pushes the main repo within the same step. */
const CD_SEPARATE_REPO_RE = /\bcd\s+(?:\.\.\/)*data\/review-texts\b/;

/** Blank out comment-only lines (trimmed line starts with `#`), preserving
 * line count so callers that report a line number stay accurate. YAML and
 * shell share the same `#` comment syntax, so one pass covers both. */
function stripCommentLines(text) {
  return text
    .split('\n')
    .map((line) => (line.trim().startsWith('#') ? '' : line))
    .join('\n');
}

/**
 * Split a workflow file into step-sized chunks. A new chunk starts at any
 * line that begins a new `steps:` list item — `- name:`, or an UNNAMED step
 * starting directly with `- run:`, `- uses:`, or `- id:` (GitHub Actions
 * does not require `name:`; ship-check/Codex finding: the first cut only
 * recognized `- name:`, so an unnamed step landed in `<preamble>` — which
 * findCoverageGaps skips entirely — and could invisibly evade the gate).
 * These four keys are unambiguous step-starters: `run`/`uses`/`id` only
 * carry the list-item `- ` prefix on the line that OPENS a step; every
 * other occurrence is a continuation key of an already-opened step (plain
 * `run:`/`env:`/`if:` with no leading `-`). Text before the first such line
 * (job `env:`/`on:`/`permissions:`/etc.) becomes the `<preamble>` chunk.
 *
 * @param {string} content raw workflow YAML
 * @returns {{name:string, startLine:number, text:string}[]}
 */
function splitIntoSteps(content) {
  const lines = content.split('\n');
  const NAME_RE = /^\s*-\s*name:\s*(.+?)\s*$/;
  const UNNAMED_START_RE = /^\s*-\s*(run|uses|id)\s*:/;
  const steps = [];
  let current = { name: '<preamble>', startLine: 1, lines: [] };
  for (let i = 0; i < lines.length; i++) {
    const named = NAME_RE.exec(lines[i]);
    if (named) {
      if (current.lines.length) steps.push(current);
      current = { name: named[1].replace(/^['"]|['"]$/g, ''), startLine: i + 1, lines: [] };
    } else if (UNNAMED_START_RE.test(lines[i])) {
      if (current.lines.length) steps.push(current);
      current = { name: `<unnamed step @L${i + 1}>`, startLine: i + 1, lines: [] };
    }
    current.lines.push(lines[i]);
  }
  if (current.lines.length) steps.push(current);
  return steps.map((s) => ({ name: s.name, startLine: s.startLine, text: s.lines.join('\n') }));
}

/** True when the step text invokes push-with-retry.sh, or the Node wrapper
 * without reconcileMergedJson already set. */
function stepPushesWithRetry(text) {
  if (PUSH_SH_RE.test(text)) return true;
  if (PUSH_JS_CALL_RE.test(text) && !RECONCILE_JS_TRUE_RE.test(text)) return true;
  return false;
}

/** Managed-file basenames literally present anywhere in the step text. */
function stepManagedFiles(text) {
  return MANAGED_BASENAMES.filter((base) => text.includes(base));
}

function stepHasFlag(text) {
  return FLAG_YAML_RE.test(text) || FLAG_EXPORT_RE.test(text) || FLAG_INLINE_RE.test(text) || RECONCILE_JS_TRUE_RE.test(text);
}

function stepHasWaiver(text) {
  return WAIVER_RE.test(text);
}

/** True when the step stages more than a named set of paths (see
 * STAGE_ALL_RE) — a managed file could be swept in without its basename
 * ever appearing literally in the step text. False when the step first `cd`s
 * into a separate git clone (see CD_SEPARATE_REPO_RE) — staging "everything"
 * there can't touch this repo's managed files. */
function stepStagesEverything(text) {
  if (CD_SEPARATE_REPO_RE.test(text)) return false;
  return STAGE_ALL_RE.test(text);
}

/**
 * @param {string} fileName repo-relative path, for reporting only
 * @param {string} content  raw workflow YAML
 * @returns {{file:string, step:string, line:number, managedFiles:string[]}[]}
 *   one entry per step that pushes a managed file without the flag/waiver
 */
function findCoverageGaps(fileName, content) {
  const gaps = [];
  for (const step of splitIntoSteps(content)) {
    if (step.name === '<preamble>') continue;
    // Waivers scan the RAW text (a waiver comment is, by definition, a
    // comment) — everything else scans the comment-stripped text so an
    // explanatory comment about a DIFFERENT step's push can't false-positive.
    const code = stripCommentLines(step.text);
    if (!stepPushesWithRetry(code)) continue;
    const managedFiles = stepStagesEverything(code) ? [...MANAGED_BASENAMES] : stepManagedFiles(code);
    if (!managedFiles.length) continue;
    if (stepHasFlag(code) || stepHasWaiver(step.text)) continue;
    gaps.push({ file: fileName, step: step.name, line: step.startLine, managedFiles });
  }
  return gaps;
}

/**
 * Audit many files at once.
 * @param {Map<string,string>|Array<[string,string]>} fileMap fileName -> content
 * @returns {{file:string, step:string, line:number, managedFiles:string[]}[]}
 */
function auditWorkflows(fileMap) {
  const gaps = [];
  for (const [fileName, content] of fileMap) {
    gaps.push(...findCoverageGaps(fileName, content));
  }
  return gaps;
}

module.exports = {
  MANAGED_BASENAMES,
  stripCommentLines,
  splitIntoSteps,
  stepPushesWithRetry,
  stepManagedFiles,
  stepStagesEverything,
  stepHasFlag,
  stepHasWaiver,
  findCoverageGaps,
  auditWorkflows,
};
