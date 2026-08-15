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
 * IMPORTANT SCOPE NOTE: only url-discovery.js is tracked, NOT scraper.js.
 * scraper.js's fetchPage() also writes ledger rows (any BD/SB/SD call) and
 * is used by ~300 of this repo's ~330 scripts/*.js — including it here
 * flagged 107 violations across 83 workflows on a clean main (verified
 * 2026-08-04), wildly out of proportion to the 19 real gaps this card
 * fixed and mostly already covered by some other commit step this check
 * can't see. That's a separate, much larger sweep — url-discovery.js's SERP
 * path matches the actual audited-and-fixed set and starts green.
 *
 * DETECTION METHOD: a real (acorn) AST walk, not text regex, because
 * "requires the file" is not the same as "calls the SERP function" —
 * rebuild-all-reviews.js requires url-discovery.js but only destructures
 * OUTLET_DOMAINS/REGISTRY_DOMAIN_ALIASES (data, never called); flagging it
 * would be a false positive of exactly the kind that made check_core_data_
 * pairing's v1 a dead no-op (see that check's history comment). The walk:
 *  1. Parse the file with acorn (fails open — skip the file — if acorn is
 *     unavailable or the file doesn't parse; same pattern as
 *     scripts/audit-help-flag-safety.js's acorn usage).
 *  2. Collect its `const { a, b: c } = require('./x')` / `const m =
 *     require('./x')` bindings (any depth, not just top-level — some
 *     scripts lazy-require inside a function body).
 *  3. Walk the target subtree (whole Program for an entry-point script; a
 *     single function's body when recursing into a required lib) for
 *     CallExpressions whose callee resolves to one of those bindings.
 *  4. A call reaches the ledger if it resolves directly to url-discovery.js's
 *     serpQuery/discoverCorrectUrl, or (recursively, memoized, cycle-safe)
 *     to an exported function in another local file whose OWN body reaches.
 *
 * KNOWN LIMITATIONS: only sees `node scripts/<path>.js` invocations written
 * literally in the workflow YAML; only static/relative requires (no dynamic
 * requires, no computed member-expression calls); a script invoked
 * indirectly (spawned as a subprocess by another script) is invisible.
 */

const fs = require('fs');
const path = require('path');

const LEDGER_FILE = 'scraper-spend-ledger.jsonl';
const LEDGER_PATH = 'data/audit/scraper-spend-ledger.jsonl';
// The reusable composite action (BRO-163) that wraps the canonical
// git-add/commit/push pattern this whole check exists to enforce — its own
// `git add data/audit/scraper-spend-ledger.jsonl` line lives inside
// .github/actions/commit-scraper-spend-ledger/action.yml, invisible to a
// scan of the CALLING workflow's YAML text. A job that `uses:` it counts as
// staging the ledger without the check needing to open the action file.
const COMMIT_LEDGER_ACTION_RE = /uses:\s*\.\/\.github\/actions\/commit-scraper-spend-ledger\b/;
const TRACKED_LIB_BASENAME = 'url-discovery.js';
const TRACKED_EXPORT_NAMES = new Set(['serpQuery', 'discoverCorrectUrl']);
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

function loadAcorn() {
  try {
    return require('acorn');
  } catch {
    return null;
  }
}

function resolveRequirePath(fromFileAbs, requirePath) {
  let resolved = path.normalize(path.join(path.dirname(fromFileAbs), requirePath));
  if (!resolved.endsWith('.js')) resolved += '.js';
  return resolved;
}

function isTrackedExport(resolvedPath, exportName) {
  return path.basename(resolvedPath) === TRACKED_LIB_BASENAME && TRACKED_EXPORT_NAMES.has(exportName);
}

// Generic ESTree walk — visits every node with a `.type`, recursing into all
// own-enumerable properties. Avoids depending on acorn-walk (a transitive,
// not package.json-declared dependency).
function walkNode(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkNode(item, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (value && typeof value === 'object') walkNode(value, visit);
  }
}

function isRequireCall(node) {
  return (
    node &&
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    node.arguments.length === 1 &&
    node.arguments[0].type === 'Literal' &&
    typeof node.arguments[0].value === 'string'
  );
}

// bindings: [{ localName, kind: 'named'|'namespace', exportName, requirePath }]
// Only relative requires ('./x' / '../x') are tracked — matches this repo's
// scripts/lib/ import convention.
// Shared by both binding forms below: `const {a} = require(...)` (pattern is
// a VariableDeclarator's `id`) and `({a} = require(...))` (pattern is an
// AssignmentExpression's `left` — the lazy try/catch-require style used by
// e.g. recover-explicit-ratings.js:250, which a VariableDeclarator-only walk
// misses entirely since `discoverCorrectUrl` is declared via a bare `let`
// one line earlier and only bound inside the try).
function bindingsFromPattern(pattern, requirePath, out) {
  if (!requirePath.startsWith('.')) return;
  if (pattern.type === 'Identifier') {
    out.push({ localName: pattern.name, kind: 'namespace', exportName: null, requirePath });
  } else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type !== 'Property') continue;
      const exportName =
        prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'Literal' ? String(prop.key.value) : null;
      const localName = prop.value.type === 'Identifier' ? prop.value.name : null;
      if (exportName && localName) out.push({ localName, kind: 'named', exportName, requirePath });
    }
  }
}

function collectBindings(ast) {
  const bindings = [];
  walkNode(ast, (node) => {
    if (node.type === 'VariableDeclarator' && isRequireCall(node.init)) {
      bindingsFromPattern(node.id, node.init.arguments[0].value, bindings);
    } else if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      (node.left.type === 'Identifier' || node.left.type === 'ObjectPattern') &&
      isRequireCall(node.right)
    ) {
      bindingsFromPattern(node.left, node.right.arguments[0].value, bindings);
    }
  });
  return bindings;
}

// name -> function node (FunctionDeclaration, or a FunctionExpression /
// ArrowFunctionExpression assigned to `const name = ...`).
function collectDefinedFunctions(ast) {
  const fns = new Map();
  walkNode(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) {
      fns.set(node.id.name, node);
    } else if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.init &&
      (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression')
    ) {
      fns.set(node.id.name, node.init);
    }
  });
  return fns;
}

// exportName -> { type: 'function', node } | { type: 'identifier', name } | { type: 'other' }
// Handles `module.exports = { a, b: c }` and `module.exports.a = ...` /
// `exports.a = ...`.
function collectExportsMap(ast) {
  const exportsMap = new Map();
  const setFromValueNode = (name, valueNode) => {
    if (!valueNode) return;
    if (valueNode.type === 'Identifier') {
      exportsMap.set(name, { type: 'identifier', name: valueNode.name });
    } else if (valueNode.type === 'FunctionExpression' || valueNode.type === 'ArrowFunctionExpression') {
      exportsMap.set(name, { type: 'function', node: valueNode });
    } else {
      exportsMap.set(name, { type: 'other' });
    }
  };

  walkNode(ast, (node) => {
    if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression') return;
    const left = node.left;

    // module.exports = { ... }
    if (
      left.object.type === 'Identifier' &&
      left.object.name === 'module' &&
      !left.computed &&
      left.property.type === 'Identifier' &&
      left.property.name === 'exports' &&
      node.right.type === 'ObjectExpression'
    ) {
      for (const prop of node.right.properties) {
        if (prop.type !== 'Property') continue;
        const name = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'Literal' ? String(prop.key.value) : null;
        if (name) setFromValueNode(name, prop.value);
      }
      return;
    }

    // module.exports.NAME = ... / exports.NAME = ...
    const isModuleExportsMember =
      left.object.type === 'MemberExpression' &&
      left.object.object.type === 'Identifier' &&
      left.object.object.name === 'module' &&
      left.object.property.type === 'Identifier' &&
      left.object.property.name === 'exports';
    const isExportsMember = left.object.type === 'Identifier' && left.object.name === 'exports';
    if ((isModuleExportsMember || isExportsMember) && !left.computed && left.property.type === 'Identifier') {
      setFromValueNode(left.property.name, node.right);
    }
  });

  return exportsMap;
}

const astCache = new Map(); // absPath -> ast | null

function parseFileCached(absPath, acorn) {
  if (astCache.has(absPath)) return astCache.get(absPath);
  let ast = null;
  try {
    let src = fs.readFileSync(absPath, 'utf8');
    // Strip a leading shebang (`#!/usr/bin/env node`) — acorn throws on it
    // otherwise ("Unexpected character '!'"), which would silently fail this
    // file open (false) and miss every entry-point script, since nearly all
    // of them start with one.
    if (src.startsWith('#!')) src = '//' + src.slice(2);
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', allowReturnOutsideFunction: true });
  } catch {
    ast = null;
  }
  astCache.set(absPath, ast);
  return ast;
}

// Does walking `subtreeNode` (a function node or a whole Program) find a
// CallExpression that reaches url-discovery.js's serpQuery/discoverCorrectUrl,
// directly, through another local file's exported function, OR through a
// same-file sibling function call (e.g. discoverAnnouncedClosingDate calling
// discoverAnnouncedDate — both defined in closing-date-discovery.js, no
// require() involved for that hop)?
function subtreeCallsTracked(subtreeNode, bindings, definedFunctions, currentAbsPath, acorn, memo, stack) {
  let found = false;
  walkNode(subtreeNode, (node) => {
    if (found || node.type !== 'CallExpression') return;
    const callee = node.callee;

    if (callee.type === 'Identifier') {
      const binding = bindings.find((b) => b.kind === 'named' && b.localName === callee.name);
      if (binding) {
        const resolvedPath = resolveRequirePath(currentAbsPath, binding.requirePath);
        if (isTrackedExport(resolvedPath, binding.exportName) || reachedName(resolvedPath, binding.exportName, acorn, memo, stack)) {
          found = true;
        }
      } else if (reachesLocalFunction(callee.name, definedFunctions, bindings, currentAbsPath, acorn, memo, stack)) {
        found = true;
      }
    } else if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object.type === 'Identifier' &&
      callee.property.type === 'Identifier'
    ) {
      const binding = bindings.find((b) => b.kind === 'namespace' && b.localName === callee.object.name);
      if (!binding) return;
      const resolvedPath = resolveRequirePath(currentAbsPath, binding.requirePath);
      const propName = callee.property.name;
      if (isTrackedExport(resolvedPath, propName) || reachedName(resolvedPath, propName, acorn, memo, stack)) {
        found = true;
      }
    }
  });
  return found;
}

// Does calling the same-file function `name` (e.g. a sibling helper, not
// require()d) itself reach a tracked call? Memoized per (absPath, name).
function reachesLocalFunction(name, definedFunctions, bindings, currentAbsPath, acorn, memo, stack) {
  const fnNode = definedFunctions.get(name);
  if (!fnNode) return false;
  const key = `${currentAbsPath}#local:${name}`;
  if (memo.has(key)) return memo.get(key);
  if (stack.has(key)) return false;
  stack.add(key);
  const reach = subtreeCallsTracked(fnNode, bindings, definedFunctions, currentAbsPath, acorn, memo, stack);
  stack.delete(key);
  memo.set(key, reach);
  return reach;
}

// Does the function exported as `exportName` from `absPath` itself reach a
// tracked call? Memoized per (absPath, exportName); cycle-safe.
function reachedName(absPath, exportName, acorn, memo, stack) {
  const key = `${absPath}#${exportName}`;
  if (memo.has(key)) return memo.get(key);
  if (stack.has(key)) return false;
  if (isTrackedExport(absPath, exportName)) {
    memo.set(key, true);
    return true;
  }

  const ast = parseFileCached(absPath, acorn);
  if (!ast) {
    memo.set(key, false);
    return false;
  }

  const definedFunctions = collectDefinedFunctions(ast);
  const exportsMap = collectExportsMap(ast);
  const entry = exportsMap.get(exportName);
  let bodyNode = null;
  if (entry && entry.type === 'function') {
    bodyNode = entry.node;
  } else if (entry && entry.type === 'identifier') {
    bodyNode = definedFunctions.get(entry.name) || null;
  }
  if (!bodyNode) {
    memo.set(key, false);
    return false;
  }

  stack.add(key);
  const bindings = collectBindings(ast);
  const reach = subtreeCallsTracked(bodyNode, bindings, definedFunctions, absPath, acorn, memo, stack);
  stack.delete(key);

  memo.set(key, reach);
  return reach;
}

// Does the whole file at absPath (any code path in it) reach a tracked call?
// Used for the entry-point scripts workflows invoke directly via
// `node scripts/X.js` — unlike reachedName(), no export-name scoping is
// needed because the whole file runs, not just one exported function.
function fileReachesLedger(absPath, acorn, memo) {
  const key = `${absPath}#__file__`;
  if (memo.has(key)) return memo.get(key);
  const ast = parseFileCached(absPath, acorn);
  if (!ast) {
    memo.set(key, false);
    return false;
  }
  const bindings = collectBindings(ast);
  const definedFunctions = collectDefinedFunctions(ast);
  const reach = subtreeCallsTracked(ast, bindings, definedFunctions, absPath, acorn, memo, new Set());
  memo.set(key, reach);
  return reach;
}

/**
 * findLedgerScripts(scriptsDir) -> Set<string>
 * Returns scripts/-relative paths (e.g. "audit-closing-dates.js") for every
 * .js file under scriptsDir whose own code calls url-discovery.js's
 * serpQuery/discoverCorrectUrl, directly or transitively. Returns an empty
 * set (fails open, logs nothing — callers should treat this as "skip the
 * check") if acorn isn't installed.
 */
function findLedgerScripts(scriptsDir) {
  const acorn = loadAcorn();
  const result = new Set();
  if (!acorn) return result;

  const memo = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.name.endsWith('.js')) {
        if (fileReachesLedger(abs, acorn, memo)) {
          result.add(path.relative(scriptsDir, abs).split(path.sep).join('/'));
        }
      }
    }
  };
  walk(scriptsDir);
  return result;
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

function jobStagesLedgerFile(jobLines) {
  const lines = joinBackslashContinuations(jobLines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE_RE.test(line)) continue;

    if (line.includes(LEDGER_FILE) && /git add\b/.test(line)) return true;
    if (lineStagesLedgerViaHelper(line)) return true;
    if (lineStagesLedgerViaDirectAdd(line)) return true;
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
        message: `job '${job.name}' runs ${invoked.join(', ')} (calls url-discovery.js's serpQuery/discoverCorrectUrl) but no step stages data/audit/${LEDGER_FILE} for commit in this job`,
      });
    }
  }
  return violations;
}

module.exports = {
  findLedgerScripts,
  findMissingLedgerCommits,
  fileReachesLedger,
  reachedName,
  resolveRequirePath,
  splitJobs,
};
