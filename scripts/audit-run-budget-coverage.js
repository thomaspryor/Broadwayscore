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
 * Scope (BRO-3447): SCHEDULED workflows, plus any workflow another workflow
 * dispatches (`gh workflow run <file|"Name">`, github-script `workflow_id:`,
 * REST `/actions/workflows/<file>/dispatches`) — see buildDispatchGraph. A
 * workflow_dispatch-only job nothing else calls is still exempt (a human
 * picks its input). Dispatched workflows use a 360-min timeout ceiling
 * instead of 35, and a third finding kind, 'unbudgeted-invocation', flags a
 * script whose run-budget is only enabled by --time-budget-min= when the
 * workflow invokes it without that flag. Findings present when this landed
 * live in scripts/lib/run-budget-coverage-baseline.json; main() tags others
 * [NEW] and the unit tests fail only on NEW ones.
 *
 * Rule:
 *   For each job with `timeout-minutes` <= 35 whose body references
 *   BRIGHTDATA_TOKEN or SCRAPINGBEE_API_KEY, for each `node scripts/X.js`
 *   it invokes: if X.js requires scripts/lib/run-budget, pass. Otherwise,
 *   heuristically look for a for/while loop whose body calls a network
 *   helper (fetchPage/fetch/fetchXxx/scraperFetchJSON/httpsGet, one level of
 *   indirection through a helper function) — if found, WARN.
 *
 * BRO-109 extension: the check above only sees loops written INSIDE the
 * script itself. It's blind to the #369/#415/#421/#438/#446 shape where the
 * script requires (or should require) run-budget, but the actual unbounded
 * loop lives one hop away in a scripts/lib/ helper it calls (e.g.
 * batchScrapeAgeRecommendations in lib/broadway-com-runtimes.js,
 * batchDiscoverSlugs in lib/serp-slug-discovery.js) — a script→lib-helper
 * "budget-threading gap". A second pass now: for each `require('./lib/X')`
 * in the script, resolves the imported helper's exported function, checks
 * whether ITS body has a risky loop, and if so whether it has a
 * budget-shaped parameter (checked via `.exceeded()`) that the call site
 * actually supplies an argument for. Two distinct findings:
 *   - "not-passed": the helper supports a budget param, but the call site's
 *     arg count doesn't reach that parameter's position.
 *   - "unsupported": the helper has a risky loop with no budget param at
 *     all, so there's no way to thread one through even if the caller has it.
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
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const { readWorkflowFilesOrFailClosed } = require('./lib/workflow-glob-guard.js');
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

// --- Dispatch graph (BRO-3447) ---------------------------------------------
//
// The schedule-only scope above missed the gather-reviews.yml incident: a
// workflow_dispatch-only workflow whose "explicit, human-sized input" is in
// practice supplied by ANOTHER workflow (opening-night-poller, the
// orchestrator, its own follow-up job...) with a backlog-sized show list. A
// 55-min job running gather-reviews.js with no --time-budget-min burned ~35K
// credits in runs that hit the timeout and were cancelled. A workflow that
// another workflow dispatches is therefore treated as scheduled-equivalent.

/** Top-level `name:` of a workflow ('' if none). */
function getWorkflowName(raw) {
  const m = /^name\s*:\s*(.+?)\s*$/m.exec(raw);
  if (!m) return '';
  return m[1].replace(/^['"]|['"]$/g, '').trim();
}

/**
 * Raw dispatch targets named in a workflow's text: `gh workflow run <x>`
 * (file or quoted display name), `workflow_id: '<file>'` (github-script
 * createWorkflowDispatch), and REST `.../actions/workflows/<file>/dispatches`.
 * Whole-line YAML comments are dropped first so a "# re-run with gh workflow
 * run X.yml" note doesn't fabricate an edge.
 */
function extractDispatchTargets(raw) {
  const text = raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const out = [];
  const ghRe = /\bgh\s+workflow\s+run\s+(?:\\?"([^"\\]+)\\?"|'([^']+)'|([^\s"'`;|&)]+))/g;
  let m;
  while ((m = ghRe.exec(text)) !== null) out.push((m[1] || m[2] || m[3]).trim());
  const idRe = /\bworkflow_id\s*:\s*['"]([^'"]+)['"]/g;
  while ((m = idRe.exec(text)) !== null) out.push(m[1].trim());
  const restRe = /actions\/workflows\/([A-Za-z0-9_.\-]+\.ya?ml)\/dispatches/g;
  while ((m = restRe.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * Builds target-file -> Set(caller files) over `workflows` ([{file, raw}]).
 * Targets resolve by file basename (`x.yml`, `.github/workflows/x.yml`) or by
 * the target's top-level `name:` (`gh workflow run "Gather Reviews"`).
 * Unresolvable targets (`$WF`, a doc placeholder) are ignored. Self-edges
 * (a workflow re-dispatching itself) are dropped: "dispatched by ANOTHER
 * workflow" is the rule — a workflow nothing else calls stays exempt.
 */
function buildDispatchGraph(workflows) {
  const files = new Set(workflows.map((w) => w.file));
  const byName = new Map();
  for (const w of workflows) {
    const name = getWorkflowName(w.raw);
    if (name) byName.set(name, w.file);
  }
  const graph = new Map();
  for (const w of workflows) {
    for (const target of extractDispatchTargets(w.raw)) {
      const base = target.split('/').pop();
      const resolved = files.has(base) ? base : byName.get(target);
      if (!resolved || resolved === w.file) continue;
      if (!graph.has(resolved)) graph.set(resolved, new Set());
      graph.get(resolved).add(w.file);
    }
  }
  return graph;
}

/**
 * True when the script's run-budget is ONLY enabled by a `--time-budget-min=N`
 * CLI flag (run-budget.js returns 0 = disabled when it's absent) and it has no
 * numeric fallback. Requiring run-budget is then not enough: an invocation
 * that omits the flag runs unbudgeted — exactly gather-reviews.js in the
 * incident. Scripts with a default (`parseTimeBudgetMin(args) || 20`,
 * `createRunBudget(22)`, `?? 10`, DEFAULT_TIME_BUDGET_MIN) are budgeted
 * regardless of flags.
 */
function isFlagGatedBudgetScript(src) {
  const clean = stripComments(src);
  const usesFlag = /\bparseTimeBudgetMin\s*\(|['"`]-{0,2}time-budget-min['"`=]/.test(clean);
  if (!usesFlag) return false;
  const hasDefault =
    /parseTimeBudgetMin\([^()]*\)\s*(?:\|\||\?\?)\s*\d/.test(clean) ||
    /createRunBudget\(\s*\d/.test(clean) ||
    /time-budget-min['"]?\s*\]?\s*\)?\s*(?:\|\||\?\?)\s*\d/.test(clean) ||
    /DEFAULT_[A-Z_]*BUDGET[A-Z_]*\s*=\s*\d/.test(clean);
  return !hasDefault;
}

/**
 * The logical shell command starting at `startIdx` in a step body: the rest
 * of that line plus any `\`-continued lines.
 */
function invocationTextAt(text, startIdx) {
  const lines = text.slice(startIdx).split('\n');
  const out = [lines[0]];
  for (let i = 0; i < lines.length - 1 && /\\\s*$/.test(lines[i]); i++) out.push(lines[i + 1]);
  return out.join('\n');
}

/**
 * Shell/env variables in a step body that carry a run budget: assigned
 * (`TB_FLAG="--time-budget-min=$TB"`, YAML env `TB_FLAG: --time-budget-min=9`)
 * a value containing `--time-budget-min=`, or a value referencing another
 * such variable (`ARGS="$ARGS $TB_FLAG"`) — resolved to a fixed point.
 */
function budgetCarryingVars(stepBody) {
  const assigns = [];
  const re = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)(?:=|:[ \t]+)(.*)$/gm;
  let m;
  while ((m = re.exec(stepBody)) !== null) assigns.push({ name: m[1], value: m[2] });
  const vars = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, value } of assigns) {
      if (vars.has(name)) continue;
      const refs = [...value.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((r) => r[1]);
      if (/--time-budget-min=/.test(value) || refs.some((r) => vars.has(r))) {
        vars.add(name);
        changed = true;
      }
    }
  }
  return vars;
}

/**
 * True if an invocation passes a run budget: the `--time-budget-min=` EQUALS
 * form (the space form is silently ignored by parseTimeBudgetMin, BRO-3887),
 * a shell/expression variable whose name says it carries one
 * (`$BUDGET_FLAG`, `${{ inputs.time_budget }}`), or a variable the step body
 * assigns a budget flag to (`$TB_FLAG`, `$ARGS` built from it).
 */
function invocationPassesBudget(invocation, stepBody = '') {
  if (/--time-budget-min=/.test(invocation)) return true;
  if (/\$\{?\{?\s*[\w.]*budget[\w.]*/i.test(invocation)) return true;
  const refs = [...invocation.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((r) => r[1]);
  if (refs.length === 0) return false;
  const vars = budgetCarryingVars(stepBody);
  return refs.some((r) => vars.has(r));
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

// Chars after which a bare `/` is (almost) certainly a regex-literal start,
// not division — the standard "operand can't precede a regex" heuristic.
const REGEX_PRECEDING_CHAR_RE = /[([{,;:=!&|?+\-*%~^]$/;
const REGEX_PRECEDING_KEYWORD_RE = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|yield|case|do|else)$/;

/** True if the `/` at src[slashIdx] plausibly opens a regex literal (vs. division), by inspecting the preceding token. */
function looksLikeRegexStart(src, slashIdx) {
  let k = slashIdx - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true; // nothing before it — can't be a binary division operator
  if (REGEX_PRECEDING_CHAR_RE.test(src[k])) return true;
  return REGEX_PRECEDING_KEYWORD_RE.test(src.slice(Math.max(0, k - 12), k + 1));
}

/**
 * Index just past a regex literal (and its flags) starting at src[startIdx]
 * (`src[startIdx] === '/'`), honoring backslash escapes and `[...]`
 * character classes (where an unescaped `/` does NOT end the literal — e.g.
 * `/[/]/` is a one-char class matching a literal slash). Returns null if no
 * unescaped, non-class closing `/` is found before a newline (bails rather
 * than guessing — an apparent regex that runs past end-of-line is more
 * likely a stray division the heuristic misfired on).
 */
function skipRegexLiteral(src, startIdx) {
  let i = startIdx + 1;
  let inClass = false;
  while (i < src.length && src[i] !== '\n') {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') { inClass = true; i++; continue; }
    if (c === ']') { inClass = false; i++; continue; }
    if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags: g, i, m, ...
      return i;
    }
    i++;
  }
  return null;
}

/** Index of the char matching the `(` at src[openIdx]. */
/**
 * Index of the char matching src[openIdx] (which must be openChar), skipping
 * over '...'/"..." string literals and //, /* comments so a stray brace or
 * paren INSIDE a log message or error string can't desync the count (a bare
 * `console.log('caught: ' + e.message + '}')` would otherwise truncate the
 * scan early). Also skips regex literals (`/[{}]/g`) — an unescaped brace
 * inside a regex's character class is idiomatic in this scraping-heavy repo
 * (e.g. `scripts/lib/wiki-utils.js`'s `.replace(/\{\{/g, '')` /
 * `.replace(/\}\}/g, '')` markup scrubbers) and, unskipped, desyncs `depth`
 * exactly like an unskipped string would — confirmed on that real file:
 * without this, extractFunctionBodies() swallowed 2 of its 3 top-level
 * functions into a sibling's body. Backtick template literals are handled
 * with a small context stack rather than skipped outright: raw template
 * TEXT is opaque (never scanned for // or /* comments, ' / " strings, or
 * regex starts — a literal URL like `` `https://x` `` must not have its `//`
 * misread as a comment, which would desync the scan and silently make the
 * entire rest of the source invisible — a much worse false negative than
 * under-matching one template literal), but `${...}` interpolations ARE real
 * code and get full normal handling (their own nested braces/parens/
 * comments/strings/regexes all count), because they may themselves contain a
 * network call worth catching. BRO-109 surfaced the backtick case: extending
 * the risky-loop scan to whole scripts/lib/ files hit many more
 * `` fetchPage(`https://...`) `` call sites than the original single-script
 * scope ever did, and the naive "don't skip backticks at all" policy
 * silently dropped every loop/function after the first such call.
 */
function findMatching(src, openIdx, openChar, closeChar) {
  let depth = 0;
  // Stack of contexts we're nested inside. The bottom frame is always
  // top-level/interpolation code (`text: false`); a frame with `text: true`
  // means we're inside a template literal's raw text, where `braceDepth`
  // is unused. A `code` frame reached via `${` tracks its OWN `{`/`}`
  // nesting in `braceDepth` so an unrelated nested object/block inside the
  // interpolation isn't mistaken for the interpolation's closing brace.
  const stack = [{ text: false, braceDepth: 0 }];
  for (let i = openIdx; i < src.length; i++) {
    const top = stack[stack.length - 1];
    const ch = src[i];

    if (top.text) {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { stack.pop(); continue; }
      if (ch === '$' && src[i + 1] === '{') { stack.push({ text: false, braceDepth: 0 }); i++; continue; }
      continue; // raw template text: never a comment/string start, never a brace/paren of interest
    }

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
    if (ch === '/' && looksLikeRegexStart(src, i)) {
      const end = skipRegexLiteral(src, i);
      if (end != null) { i = end - 1; continue; }
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
    if (ch === '`') { stack.push({ text: true, braceDepth: 0 }); continue; }

    if (stack.length > 1) {
      // Inside a ${...} interpolation: track its own brace nesting so its
      // closing `}` (back to raw template text) isn't confused with a
      // nested object/block's `}` inside the interpolation. The `${` that
      // OPENED this frame was consumed as a 2-char marker above and never
      // reached the openChar/closeChar check below, so the `}` that CLOSES
      // it back to raw text must be excluded from that check too (`continue`)
      // — otherwise it double-decrements `depth` for a brace whose matching
      // open was never counted, returning a match many characters too early.
      if (ch === '{') top.braceDepth++;
      else if (ch === '}') {
        if (top.braceDepth === 0) { stack.pop(); continue; }
        top.braceDepth--;
      }
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

/**
 * All named function bodies in a script (function decls + const-assigned
 * arrow fns with a block body). Thin projection over extractFunctionSignatures
 * (dropping `params`) rather than its own regex — a separate `[^)]*`-based
 * param-list regex here would reintroduce the exact "default value with its
 * own parens truncates the match" bug that extractFunctionSignatures was
 * fixed for, just for the one-hop "networky name" lookup instead of the
 * budget-param lookup.
 */
function extractFunctionBodies(src) {
  return extractFunctionSignatures(src).map(({ name, body }) => ({ name, body }));
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

/**
 * Blanks `//` and `/* *\/` comment text (to spaces, preserving offsets) so a
 * docstring mentioning a risky-looking call by name — e.g. "fetchPage()
 * unwraps at FETCH time" in a prose comment — can't masquerade as a real
 * call to NETWORK_CALL_RE. Quoted strings are left untouched (skipped over
 * verbatim, never scanned). Backtick template literals use the SAME
 * text/interpolation context stack as findMatching (raw text copied verbatim
 * and never scanned for `//`/`/* *\/`/regex starts; `${...}` interpolations
 * get full normal handling since they're real code) — an earlier version
 * treated backticks as plain quoted strings (skip to the next backtick,
 * unconditionally), which mis-paired a NESTED template literal — ``  `outer
 * ${`inner`} end`  `` — the first backtick of `inner` was read as the
 * CLOSING backtick of the outer string, leaving `` end` `` to be scanned as
 * ordinary code and corrupting everything after it. A bare URL inside
 * template text — `` `https://api.example.com/x` `` — has the same false-
 * negative risk this function was built to close in the first place: its
 * `//` is not a comment start, and misreading it would blank the rest of the
 * line, silently hiding a real network call later on it. Extending the
 * risky-loop check to whole scripts/lib/ files (BRO-109) made comment-
 * stripping necessary at all — the original single-script scope rarely hit a
 * large enough docstring to false-positive, but library files with long
 * header comments do (scripts/lib/review-write-guard.js#safeWriteReview
 * matched via exactly this before this function was added).
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const stack = [{ text: false, braceDepth: 0 }];
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const ch = src[i];

    if (top.text) {
      if (ch === '\\') { out += src.slice(i, Math.min(i + 2, src.length)); i += 2; continue; }
      if (ch === '`') { stack.pop(); out += ch; i++; continue; }
      if (ch === '$' && src[i + 1] === '{') { stack.push({ text: false, braceDepth: 0 }); out += '${'; i += 2; continue; }
      out += ch; i++; continue; // raw template text: never a comment/regex/string start
    }

    if (ch === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? src.length : j + 2;
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    if (ch === '/' && looksLikeRegexStart(src, i)) {
      const end = skipRegexLiteral(src, i);
      if (end != null) { out += src.slice(i, end); i = end; continue; }
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, src.length);
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '`') { stack.push({ text: true, braceDepth: 0 }); out += ch; i++; continue; }

    if (stack.length > 1) {
      // Same interpolation brace-depth tracking as findMatching: a nested
      // object/block's `}` inside `${...}` must not be mistaken for the
      // interpolation's own closing `}`.
      if (ch === '{') top.braceDepth++;
      else if (ch === '}') {
        if (top.braceDepth === 0) { stack.pop(); out += ch; i++; continue; }
        top.braceDepth--;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Core of the risky-loop check: are there unbounded-looking loops in
 * `bodySrc` that call a network helper? `namesSrc` is where one-hop helper
 * function bodies are looked up to build the "networky names" set — for a
 * whole-script check this is the same source (`riskyLoopIn(src, src)`); for
 * a single lib-helper function's body it's the WHOLE lib file, so sibling
 * functions it delegates to are still visible.
 */
function riskyLoopIn(bodySrc, namesSrc) {
  const networkyNames = new Set(
    extractFunctionBodies(namesSrc).filter((f) => NETWORK_CALL_RE.test(stripComments(f.body))).map((f) => f.name),
  );
  for (const loop of extractLoops(bodySrc)) {
    // Explicitly bounded: `.slice(-N)` (last N) or `.slice(A, B)` with literal
    // bounds (e.g. `maps.slice(-2)`, `candidates.slice(0, 4)`). A single
    // non-negative-literal or variable arg (`.slice(alreadyProcessed)`) means
    // "from N to end" — NOT bounded — so it must NOT match here.
    if (/\.slice\(\s*-\d+\s*\)|\.slice\(\s*\d+\s*,\s*\d+\s*\)/.test(loop.header)) continue;
    const cleanBody = stripComments(loop.body);
    if (NETWORK_CALL_RE.test(cleanBody)) return true;
    for (const name of networkyNames) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(cleanBody)) return true;
    }
  }
  return false;
}

/** True if the script has an unbounded-looking loop that calls a network helper. */
function hasRiskyLoop(src) {
  return riskyLoopIn(src, src);
}

/** True if a single lib-helper function's body has a risky loop (sibling helpers in `libSrc` count as one hop). */
function functionBodyHasRiskyLoop(fnBody, libSrc) {
  return riskyLoopIn(fnBody, libSrc);
}

/**
 * Splits a comma-separated parameter/argument LIST into its top-level
 * (paren/brace/bracket/string-aware) chunks — e.g. `a, b = () => {}, c`
 * stays 3 chunks, not split on the comma-less arrow default's internal
 * structure. Shared by extractFunctionSignatures (splitting params) and
 * countTopLevelArgs (splitting call args).
 */
function splitTopLevel(text) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < trimmed.length && trimmed[i] !== quote) {
        if (trimmed[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      out.push(trimmed.slice(start, i));
      start = i + 1;
    }
  }
  out.push(trimmed.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

const FUNCTION_HEADER_RE = /(?:async\s+function\s+([A-Za-z_$][\w$]*)\s*\(|function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=\s*\()/g;

/**
 * All named function bodies AND parameter lists in a script (function decls +
 * const-assigned arrow fns with a block body) — like extractFunctionBodies
 * but also captures the raw parameter list, needed to find a budget-shaped
 * parameter's position. Params are located via matchParen (paren-depth-aware)
 * rather than a `[^)]*` regex, so a default value that itself contains
 * parens — `function f(items, onProgress = () => {})` — doesn't prematurely
 * truncate the param list at the arrow's own `()` and silently drop the
 * whole function from the scan (a real risky helper would then be invisible
 * to the BRO-109 threading check — a false negative, not just imprecision).
 */
function extractFunctionSignatures(src) {
  const out = [];
  let m;
  FUNCTION_HEADER_RE.lastIndex = 0;
  while ((m = FUNCTION_HEADER_RE.exec(src)) !== null) {
    const name = m[1] || m[2] || m[3] || m[4];
    const isArrow = Boolean(m[3] || m[4]);
    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = matchParen(src, openParenIdx);
    if (closeParenIdx == null) continue;

    let j = closeParenIdx + 1;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (isArrow) {
      if (src[j] !== '=' || src[j + 1] !== '>') continue;
      j += 2;
      while (j < src.length && /\s/.test(src[j])) j++;
    }
    if (src[j] !== '{') continue;

    const body = extractBracedBody(src, j);
    if (name && body != null) {
      const paramsRaw = src.slice(openParenIdx + 1, closeParenIdx);
      const params = splitTopLevel(paramsRaw).map((p) => p.split('=')[0].trim().replace(/^\.\.\./, ''));
      out.push({ name, params, body });
    }
  }
  return out;
}

/**
 * 0-based index of a budget-shaped parameter that the function body actually
 * checks (`<name>.exceeded(` / `<name>?.exceeded(`, or the BRO-3340
 * `<name>.canStartItem(` loop-head form) — i.e. a real budget
 * param, not just a coincidentally-named one that's ignored. -1 if none.
 */
function findBudgetParamIndex(fn) {
  const idx = fn.params.findIndex((p) => /budget/i.test(p));
  if (idx === -1) return -1;
  const name = fn.params[idx];
  return new RegExp(`\\b${name}\\??\\.(?:exceeded|canStartItem)\\s*\\(`).test(fn.body) ? idx : -1;
}

/**
 * Local lib requires: `const { a, b } = require('./lib/xxx');` →
 * [{names: [{exported: 'a', local: 'a'}, ...], relPath: 'xxx'}]. Matches
 * `./lib/` AND `../lib/` (one or more `../`/`./` segments) — scripts one
 * directory down (scripts/cli/, scripts/admin/, etc.) reach scripts/lib/ via
 * `../lib/`, not `./lib/`; a script→lib-helper gap in one of those would
 * otherwise be silently invisible to this check.
 *
 * `exported` and `local` diverge for an aliased destructure — `const {
 * batchScrapeAgeRecommendations: batchScrape } = require(...)` — a real
 * pattern in this repo (e.g. `fetchPage: fetchPageScraper` in
 * scripts/recollect-for-scores.js). `exported` is the name that appears in
 * the lib file's own module.exports / function declaration (needed to find
 * and inspect the helper); `local` is what the SCRIPT actually calls
 * (needed to find its call sites). Conflating them — using `exported` for
 * both, as an earlier version of this function did — made findBudgetThreadingGaps
 * search the script for a name it never uses, silently missing the gap.
 */
function getLibRequires(src) {
  const re = /const\s*\{\s*([^}]+)\}\s*=\s*require\(\s*['"](?:\.\.\/|\.\/)+lib\/([A-Za-z0-9_\-]+)(?:\.js)?['"]\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const names = m[1]
      .split(',')
      .map((s) => {
        const parts = s.trim().split(':').map((p) => p.trim());
        return { exported: parts[0], local: (parts[1] || parts[0]).replace(/^\.\.\./, '') };
      })
      .filter((n) => n.exported);
    out.push({ names, relPath: m[2] });
  }
  return out;
}

/**
 * Names in a lib file's `module.exports = { a, b, c };` (shorthand
 * export-list convention used throughout scripts/lib/). Uses matchParen's
 * sibling extractBracedBody (brace-depth-aware) rather than a `[^}]*` regex,
 * so a nested object value in the export list — `module.exports = { a, b:
 * { c } };` — doesn't truncate at the inner `}` and silently drop every
 * export named after it.
 */
function getModuleExportNames(src) {
  const m = /module\.exports\s*=\s*\{/.exec(src);
  if (!m) return new Set();
  const braceIdx = m.index + m[0].length - 1;
  const body = extractBracedBody(src, braceIdx);
  if (body == null) return new Set();
  return new Set(splitTopLevel(body).map((s) => s.split(':')[0].trim()).filter(Boolean));
}

/** Number of top-level (paren/brace/bracket/string-aware) comma-separated args in a call's argument text. */
function countTopLevelArgs(argsText) {
  return splitTopLevel(argsText).length;
}

/** Argument counts of every call to `fnName(...)` found in `src`. */
function callArgCounts(src, fnName) {
  const re = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const parenIdx = m.index + m[0].length - 1;
    const end = matchParen(src, parenIdx);
    if (end == null) continue;
    out.push(countTopLevelArgs(src.slice(parenIdx + 1, end)));
  }
  return out;
}

/**
 * Script→lib-helper budget-threading gaps (BRO-109): scripts/lib/ helpers the
 * script calls that have their own risky (network-in-loop) body, where either
 * the helper has no budget param at all ("unsupported") or has one the call
 * site doesn't actually reach with an argument ("not-passed").
 * `libSrcByRelPath` maps a lib require's relPath (e.g. 'broadway-com-runtimes')
 * to that file's source, so this stays a pure function of two strings/maps —
 * fs resolution lives in main().
 */
function findBudgetThreadingGaps(scriptSrc, libSrcByRelPath) {
  const gaps = [];
  // Comments stripped once, up front: a JSDoc @example call (or any other
  // prose mentioning `helperName(a, b, c, budget)`) must not count as a real
  // call site — that would mask an actual call that omits the budget arg
  // (false negative, worse than the noise a stray comment might otherwise add).
  const cleanScriptSrc = stripComments(scriptSrc);
  for (const { names, relPath } of getLibRequires(scriptSrc)) {
    const libSrc = libSrcByRelPath[relPath];
    if (libSrc == null) continue;
    const exportedNames = getModuleExportNames(libSrc);
    const signatures = extractFunctionSignatures(libSrc);
    for (const { exported, local } of names) {
      if (!exportedNames.has(exported)) continue;
      const fn = signatures.find((f) => f.name === exported);
      if (!fn) continue;
      if (!functionBodyHasRiskyLoop(fn.body, libSrc)) continue;

      const budgetIdx = findBudgetParamIndex(fn);
      if (budgetIdx === -1) {
        gaps.push({ name: exported, relPath, reason: 'unsupported' });
        continue;
      }
      // ANY call site short of the budget param position is a real gap —
      // even if a sibling call site elsewhere threads it correctly, the
      // short one still runs the helper's loop with no way to stop early.
      // Searched by `local` (what the script actually calls), not `exported`
      // — they diverge for an aliased destructure.
      const argCounts = callArgCounts(cleanScriptSrc, local);
      if (argCounts.some((c) => c <= budgetIdx)) {
        gaps.push({ name: exported, relPath, reason: 'not-passed' });
      }
    }
  }
  return gaps;
}

/** Reads the lib files a script `require('./lib/X')`s (for findBudgetThreadingGaps's second argument). */
function resolveLibSrcs(scriptSrc, scriptsDir = SCRIPTS_DIR) {
  const map = {};
  for (const { relPath } of getLibRequires(scriptSrc)) {
    if (map[relPath] !== undefined) continue;
    const libPath = path.join(scriptsDir, 'lib', `${relPath}.js`);
    if (fs.existsSync(libPath)) map[relPath] = fs.readFileSync(libPath, 'utf8');
  }
  return map;
}

// Timeout ceilings per trigger class. Scheduled-only workflows keep the
// original tight-timeout rule (#425). A workflow another workflow dispatches
// (BRO-3447) gets GitHub's own 360-min default as the ceiling: its input is
// whatever the dispatcher computed (a backlog-sized show list in the
// gather-reviews incident), and the incident job had a 55-min timeout — a
// "generous" timeout still SIGKILLs and still bills every credit spent
// before it fires. A step/job with no timeout-minutes runs under that same
// 360-min default, so for dispatched workflows a missing timeout is evaluated
// as 360 rather than skipped.
const DISPATCHED_MAX_TIMEOUT_MIN = 360;
const GITHUB_DEFAULT_TIMEOUT_MIN = 360;

// Advisory baseline (CLAUDE.md §19 / BRO-2123): the dispatch-graph extension
// raised live findings from 0 to dozens on the day it landed. Those are
// recorded here; main() marks anything outside it as NEW, and the colocated
// unit test fails only on a NEW finding (a regression), never on a baselined
// one. Shrink it as workflows get budgets: `node
// scripts/write-run-budget-coverage-baseline.js`.
const BASELINE_PATH = path.join(__dirname, 'lib', 'run-budget-coverage-baseline.json');

/** Stable identity for a finding (baseline key). */
function findingKey(f) {
  return [f.kind, f.file, f.job, f.script, f.relPath ? `${f.relPath}#${f.name}` : ''].join('|');
}

function loadBaseline(baselinePath = BASELINE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    return new Set(Array.isArray(parsed.findings) ? parsed.findings : []);
  } catch {
    return new Set();
  }
}

/** Splits findings into { fresh, known } against a baseline Set of keys. */
function partitionByBaseline(findings, baseline) {
  const fresh = [];
  const known = [];
  for (const f of findings) (baseline.has(findingKey(f)) ? known : fresh).push(f);
  return { fresh, known };
}

/**
 * Scans .github/workflows/ + scripts/ (overridable for fixtures) and returns
 * the raw findings ({ files, warnings, threadingWarnings, flagWarnings,
 * dispatchGraph }) with no printing/exit behavior — the pure core that both
 * main() and the unit tests call (CLAUDE.md §15: tests require() the real
 * function, never re-implement its scan logic).
 *
 * A workflow is in scope when it has a schedule trigger OR another workflow
 * dispatches it (BRO-3447 dispatch graph). Every finding carries `kind`
 * ('missing-run-budget' | 'threading' | 'unbudgeted-invocation') and
 * `trigger` ('schedule' or 'dispatched by a.yml, b.yml').
 *
 * 'unbudgeted-invocation' (BRO-3447): the script DOES require run-budget,
 * but its budget is only switched on by `--time-budget-min=N` and this
 * invocation doesn't pass it, so it runs with no budget at all.
 */
function collectFindings({ workflowDir = WORKFLOW_DIR, scriptsDir = SCRIPTS_DIR } = {}) {
  const files = readWorkflowFilesOrFailClosed(workflowDir, { includeYaml: true })
    .sort();
  const workflows = files.map((file) => ({ file, raw: fs.readFileSync(path.join(workflowDir, file), 'utf8') }));
  const dispatchGraph = buildDispatchGraph(workflows);

  const warnings = [];
  const threadingWarnings = [];
  const flagWarnings = [];
  const scriptCache = new Map(); // script path -> { hasRunBudget, risky, flagGated, threadingGaps }

  for (const { file, raw } of workflows) {
    const scheduled = hasScheduleTrigger(raw);
    const callers = [...(dispatchGraph.get(file) || [])].sort();
    const dispatched = callers.length > 0;
    if (!scheduled && !dispatched) continue; // nothing automated feeds it a backlog
    if (raw.includes(`${ANNOTATION}:`)) continue;
    const trigger = scheduled ? 'schedule' : `dispatched by ${callers.join(', ')}`;
    const maxTimeout = dispatched ? DISPATCHED_MAX_TIMEOUT_MIN : MAX_TIMEOUT_MIN;
    const fallbackTimeout = dispatched ? GITHUB_DEFAULT_TIMEOUT_MIN : null;

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
      const jobTimeout = job.timeoutMinutes ?? fallbackTimeout;
      const steps = job.steps.length > 0
        ? job.steps.map((s) => ({ bodyText: s.bodyText, timeoutMinutes: s.timeoutMinutes ?? jobTimeout }))
        : [{ bodyText: job.bodyText, timeoutMinutes: jobTimeout }];

      for (const step of steps) {
        if (!Number.isFinite(step.timeoutMinutes) || step.timeoutMinutes > maxTimeout) continue;
        if (!BD_SB_TOKENS.some((t) => step.bodyText.includes(t))) continue;

        const invocations = new Map(); // script -> [invocation text]
        for (const m of step.bodyText.matchAll(/\bnode\s+scripts\/([A-Za-z0-9_\-/]+\.js)/g)) {
          if (!invocations.has(m[1])) invocations.set(m[1], []);
          invocations.get(m[1]).push(invocationTextAt(step.bodyText, m.index));
        }

        for (const [script, invTexts] of invocations) {
          const scriptPath = path.join(scriptsDir, script);
          if (!fs.existsSync(scriptPath)) continue;

          if (!scriptCache.has(scriptPath)) {
            const content = fs.readFileSync(scriptPath, 'utf8');
            const hasRunBudget = /require\(\s*['"](?:\.\.?\/)+lib\/run-budget(?:\.js)?['"]\s*\)/.test(content);
            scriptCache.set(scriptPath, {
              hasRunBudget,
              risky: !hasRunBudget && hasRiskyLoop(content),
              flagGated: isFlagGatedBudgetScript(content),
              threadingGaps: findBudgetThreadingGaps(content, resolveLibSrcs(content, scriptsDir)),
            });
          }

          const result = scriptCache.get(scriptPath);
          const base = { file, job: job.name, timeoutMinutes: step.timeoutMinutes, script, trigger };
          if (result.risky) {
            warnings.push({ kind: 'missing-run-budget', ...base });
          }
          if (result.flagGated && invTexts.some((t) => !invocationPassesBudget(t, step.bodyText))) {
            flagWarnings.push({ kind: 'unbudgeted-invocation', ...base });
          }
          for (const gap of result.threadingGaps) {
            threadingWarnings.push({ kind: 'threading', ...base, ...gap });
          }
        }
      }
    }
  }

  return { files, warnings, threadingWarnings, flagWarnings, dispatchGraph };
}

function main() {
  const { files, warnings, threadingWarnings, flagWarnings } = collectFindings();
  const all = [...warnings, ...threadingWarnings, ...flagWarnings];

  if (all.length === 0) {
    console.log(`✅ Run-budget coverage guard: no candidates flagged (${files.length} workflows checked).`);
    return;
  }

  const baseline = loadBaseline();
  const tag = (f) => (baseline.has(findingKey(f)) ? '' : '[NEW] ');
  const { fresh, known } = partitionByBaseline(all, baseline);

  if (warnings.length > 0) {
    console.log('⚠️  Run-budget coverage guard — possible missing scripts/lib/run-budget.js:\n');
    console.log('These jobs run on a SCHEDULED trigger (timeout-minutes <= 35) or are DISPATCHED by');
    console.log('another workflow (any timeout), use Bright Data / ScrapingBee, and invoke a script');
    console.log('with a loop that calls a network helper but does NOT require scripts/lib/run-budget');
    console.log('— the same shape as #369/#415/#421.\n');
    console.log('This is advisory (heuristic, non-blocking) — verify manually before fixing.\n');
    for (const w of warnings) {
      console.log(`  • ${tag(w)}${w.file} [${w.trigger}] :: job "${w.job}" (timeout-minutes: ${w.timeoutMinutes}) → scripts/${w.script}`);
    }
    console.log(`\nFix: wire scripts/lib/run-budget.js into the script (see #369/#415 for the pattern).`);
    console.log(`Exempt (false positive): add  # ${ANNOTATION}: <reason>  anywhere in the workflow file.\n`);
  }

  if (flagWarnings.length > 0) {
    console.log('⚠️  Run-budget coverage guard — budgeted script invoked WITHOUT --time-budget-min= (BRO-3447):\n');
    console.log('These scripts require scripts/lib/run-budget.js, but their budget is only enabled by');
    console.log('--time-budget-min=N (no default), and this invocation does not pass it — so the run');
    console.log('has no wall-clock budget at all (the gather-reviews.yml 35K-credit incident shape).\n');
    for (const w of flagWarnings) {
      console.log(`  • ${tag(w)}${w.file} [${w.trigger}] :: job "${w.job}" (timeout-minutes: ${w.timeoutMinutes}) → scripts/${w.script}`);
    }
    console.log('\nFix: pass --time-budget-min=N (EQUALS form) a few minutes under the step/job timeout.');
    console.log(`Exempt (false positive): add  # ${ANNOTATION}: <reason>  anywhere in the workflow file.\n`);
  }

  if (threadingWarnings.length > 0) {
    console.log('⚠️  Run-budget coverage guard — possible script→lib-helper budget-threading gaps (BRO-109):\n');
    console.log('These scripts call a scripts/lib/ helper with its own unbounded network loop, but the');
    console.log('call site never threads a run-budget through to it — the helper\'s loop has no way to');
    console.log('stop early even though the calling script has (or could have) a budget. Same shape as');
    console.log('batchScrapeAgeRecommendations (lib/broadway-com-runtimes.js) / batchDiscoverSlugs');
    console.log('(lib/serp-slug-discovery.js).\n');
    console.log('This is advisory (heuristic, non-blocking) — verify manually before fixing.\n');
    for (const w of threadingWarnings) {
      const detail = w.reason === 'unsupported'
        ? `lib/${w.relPath}.js#${w.name}() has an internal network loop but no budget parameter at all`
        : `lib/${w.relPath}.js#${w.name}() accepts a budget param but the call site doesn't pass it`;
      console.log(`  • ${tag(w)}${w.file} [${w.trigger}] :: job "${w.job}" → scripts/${w.script} calls ${detail}`);
    }
    console.log(`\nFix: thread the script's run-budget object through to the helper call (see lib/broadway-com-runtimes.js's`);
    console.log(`batchScrapeAgeRecommendations or lib/serp-slug-discovery.js's batchDiscoverSlugs for the pattern).`);
    console.log(`Exempt (false positive): add  # ${ANNOTATION}: <reason>  anywhere in the workflow file.\n`);
  }

  console.log(`Summary: ${all.length} finding(s) — ${known.length} baselined, ${fresh.length} NEW (baseline: ${path.relative(process.cwd(), BASELINE_PATH)}).`);
  // Advisory only — never fails CI (see header). NEW findings fail the
  // colocated unit test instead (tests/unit/run-budget-coverage-dispatch-graph.test.mjs).
}

// Only run the audit when executed directly — `require()`d from a unit test,
// the module must expose its decision functions without scanning the repo
// (CLAUDE.md §15: tests require() the real function, never a copy of it).
if (require.main === module) main();


module.exports = {
  collectFindings,
  hasRiskyLoop,
  riskyLoopIn,
  stripComments,
  functionBodyHasRiskyLoop,
  extractFunctionBodies,
  extractFunctionSignatures,
  extractLoops,
  findMatching,
  matchParen,
  extractBracedBody,
  looksLikeRegexStart,
  skipRegexLiteral,
  findBudgetParamIndex,
  getLibRequires,
  getModuleExportNames,
  splitTopLevel,
  countTopLevelArgs,
  callArgCounts,
  findBudgetThreadingGaps,
  hasScheduleTrigger,
  getWorkflowName,
  extractDispatchTargets,
  buildDispatchGraph,
  isFlagGatedBudgetScript,
  invocationTextAt,
  invocationPassesBudget,
  budgetCarryingVars,
  findingKey,
  loadBaseline,
  partitionByBaseline,
  BASELINE_PATH,
};
