'use strict';
/**
 * Detection logic for the "unbounded `git fetch` from a shallow checkout" bug
 * class. Task #420 (root cause proven in #466).
 *
 * THE BUG
 * -------
 * actions/checkout defaults to `fetch-depth: 1` — a SHALLOW clone holding one
 * commit. A `git fetch` issued from a shallow repo with NO depth bound asks
 * upload-pack for the ref's history with no cut-off, and the server answers
 * with the ENTIRE repository. Measured on a real GitHub runner (run
 * 30218025467) against this repo's main: 1365 MB pulled before a 180s kill,
 * instead of the ~500-object delta. Bare (`git fetch origin main`) and
 * explicit-refspec (`+refs/heads/main:refs/remotes/origin/main`) forms behave
 * identically — the missing depth bound is the whole variable. It only FIRES
 * when there is something new to fetch, which is why it reads as intermittent.
 *
 * scripts/lib/push-with-retry.sh was fixed in #466 (it depth-bounds via
 * scripts/lib/shallow-fetch-args.js). This guard exists so the NEXT script
 * that hand-rolls its own fetch+rebase+push — the exact thing #420 found in
 * collect-review-texts.js, rediscover-review-urls.js and llm-scoring/index.ts
 * — is caught at lint time instead of by a 3 GB CI stall months later.
 *
 * WHAT COUNTS AS BOUNDED
 * ----------------------
 * Any of --depth / --deepen / --shallow-since / --shallow-exclude /
 * --unshallow. Note --depth=N is only safe when you KNOW the clone is shallow:
 * `--is-shallow-repository` proving a .git/shallow graft exists does not stop
 * --depth from SHORTENING a deep clone, so push-with-retry.sh uses --deepen for
 * its fallback. This guard only asks "is there a bound at all" — the choice
 * between them is a correctness question the call site must reason about (see
 * scripts/lib/shallow-fetch-args.js for the full rationale, including why a
 * bare --depth=1 destroys ancestry and must never be used before a rebase).
 *
 * REACHABILITY
 * ------------
 * An unbounded fetch is only a live defect if the script can actually run on a
 * shallow checkout. So a violation requires BOTH:
 *   1. the fetch carries no depth bound, AND
 *   2. the file is reachable (directly, or through require()) from a workflow
 *      whose actions/checkout does not set `fetch-depth: 0`.
 * Local-only tooling (session hooks, launchd scripts, worktree helpers) runs
 * against a full clone and is correctly left alone.
 *
 * Everything here is PURE (string in, data out) so it is unit-testable per
 * project rule §15 — the filesystem walk lives in scripts/audit-unbounded-fetch.js.
 */

/** Flags that give `git fetch` a cut-off, in any `--flag`, `--flag=x`, `--flag x` form. */
const BOUND_FLAGS = ['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--unshallow'];

/** Inline waiver: `unbounded-fetch-ok: <reason>` on the same line or the line above. */
const EXEMPT_RE = /unbounded-fetch-ok:\s*\S/;

/**
 * A git fetch/pull invocation. `-c key=value` config pairs may sit between
 * `git` and the subcommand (push-with-retry.sh's git_fetch wrapper does this).
 */
const GIT_FETCH_RE = /\bgit\s+(?:-c\s+(?:"[^"]*"|'[^']*'|\S+)\s+)*(fetch|pull)\b/g;

/** Shell lines that only TALK about a fetch (echo/printf text) rather than run one. */
const NARRATION_RE = /\b(?:echo|printf)\s+/;

/**
 * `execFileSync('git', ['fetch', 'origin', 'main', '--quiet'])` — the array
 * form, where the subcommand and flags are separate string literals so
 * GIT_FETCH_RE (which needs `git` and `fetch` adjacent) never matches. This was
 * a real blind spot: scripts/lib/overnight-digest.js used exactly this shape,
 * and the only reason the first cut of this guard flagged that file at all was
 * an unrelated log string on the same line.
 */
const GIT_ARGV_RE = /(['"`])git\1\s*,\s*\[([^\]]*)\]/g;

/**
 * In JS/TS, a `git fetch` string is only a COMMAND if something spawns it.
 * Without this, any log/error/comment string mentioning a fetch is a false
 * positive — e.g. `digest.errors.push('git fetch failed — summary may be
 * stale')`. Known limitation (documented rather than papered over): a command
 * assigned to a variable on one line and spawned on another is not detected.
 * Every real call site in this repo uses the inline or argv form.
 */
const JS_SPAWN_RE = /\b\w*(?:exec|spawn|shell)\w*\s*\(/i;

function langFromPath(filePath) {
  if (/\.(?:ts|mts|tsx)$/.test(filePath)) return 'js';
  if (/\.(?:js|mjs|cjs|jsx)$/.test(filePath)) return 'js';
  if (/\.(?:sh|bash)$/.test(filePath)) return 'sh';
  return 'sh'; // extensionless hooks (scripts/hooks/pre-push) are shell
}

/**
 * Blank out /* ... *\/ block comments while PRESERVING line count and column
 * positions, so line numbers reported downstream still match the real file.
 */
function stripBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function isCommentLine(line, lang) {
  const t = line.trim();
  if (!t) return true;
  if (lang === 'sh') return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Isolate just the fetch invocation from `rest` (the text following the match).
 * Without this, `execSync('git fetch origin main'); maybeDepth('--depth')` or a
 * chained `'git fetch origin main && git rebase --depth-ish'` would read a
 * later token's flag as this fetch's bound (false negative).
 *
 * For js/ts the command is inside a quoted string, so the closing quote ends
 * it; for shell the line itself is the command. Both then stop at the first
 * shell separator (`&&`, `||`, `;`, `|`).
 */
function isolateCommand(rest, lang) {
  let cmd = rest;
  if (lang === 'js') {
    const quote = cmd.search(/['"`]/);
    if (quote !== -1) cmd = cmd.slice(0, quote);
  }
  const sep = cmd.search(/&&|\|\||;|\|/);
  if (sep !== -1) cmd = cmd.slice(0, sep);
  return cmd;
}

/** True when the isolated fetch command carries any depth bound. */
function isFetchBounded(command) {
  return BOUND_FLAGS.some((flag) => new RegExp(`${flag}(?:[=\\s]|$)`).test(command));
}

/**
 * Find every unbounded git fetch/pull in one file's source.
 *
 * @param {string} source raw file text
 * @param {string} filePath repo-relative path (selects the comment/quote dialect)
 * @returns {{line:number, subcommand:string, command:string, snippet:string}[]}
 */
function findUnboundedFetches(source, filePath) {
  const lang = langFromPath(filePath);
  const lines = (lang === 'js' ? stripBlockComments(source) : source).split('\n');
  const rawLines = source.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line, lang)) continue;
    if (isWaived(lines, i, lang)) continue;

    // Form 1: the whole command in one string — `execSync('git fetch origin main')`
    GIT_FETCH_RE.lastIndex = 0;
    let m;
    while ((m = GIT_FETCH_RE.exec(line)) !== null) {
      const before = line.slice(0, m.index);
      if (lang === 'sh' ? NARRATION_RE.test(before) : !JS_SPAWN_RE.test(before)) continue;
      const command = isolateCommand(line.slice(m.index + m[0].length), lang);
      if (isFetchBounded(command)) continue;
      out.push({
        line: i + 1,
        subcommand: m[1],
        command: (m[0] + command).trim(),
        snippet: rawLines[i].trim(),
      });
    }

    // Form 2: argv array — `execFileSync('git', ['fetch', 'origin', 'main'])`
    if (lang !== 'js') continue;
    GIT_ARGV_RE.lastIndex = 0;
    while ((m = GIT_ARGV_RE.exec(line)) !== null) {
      const argv = m[2];
      const sub = /['"`](fetch|pull)['"`]/.exec(argv);
      if (!sub) continue;
      if (isFetchBounded(argv)) continue;
      out.push({
        line: i + 1,
        subcommand: sub[1],
        command: `git [${argv.trim()}]`,
        snippet: rawLines[i].trim(),
      });
    }
  }
  return out;
}

/**
 * True when an `unbounded-fetch-ok: <reason>` waiver applies to line `i`.
 * The waiver may sit on the line itself or anywhere in the contiguous comment
 * block directly above it — a one-line lookback is not enough for a waiver
 * that needs a paragraph to justify itself (push-with-retry.sh's git_fetch
 * wrapper is the motivating case: its bound arrives via "$@", which takes six
 * lines to explain).
 */
function isWaived(lines, i, lang) {
  if (EXEMPT_RE.test(lines[i])) return true;
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j];
    if (EXEMPT_RE.test(l)) return true;
    if (l.trim() === '') return false;                 // blank breaks the block
    // A trailing "\" means line j is the SAME logical command as line j+1, so
    // keep walking to reach the comment block above it. Without this, a waiver
    // above a wrapped shell command never applies to the wrapped part — which
    // is exactly the shape of push-with-retry.sh's git_fetch (`_timeout … \`
    // then the git line).
    if (lang === 'sh' && /\\\s*$/.test(l)) continue;
    if (!isCommentLine(l, lang)) return false;
  }
  return false;
}

/**
 * Decide whether a workflow's checkout(s) leave the repo shallow.
 *
 * A workflow is SHALLOW unless every actions/checkout step sets
 * `fetch-depth: 0`. A workflow with no checkout at all cannot run git ops
 * against the repo, so it is not an exposure path.
 *
 * @returns {{hasCheckout:boolean, shallow:boolean}}
 */
function analyzeWorkflowCheckout(source) {
  const lines = source.split('\n');
  let hasCheckout = false;
  let shallow = false;

  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*actions\/checkout@/.test(lines[i])) continue;
    hasCheckout = true;
    const baseIndent = lines[i].search(/\S/);
    let depthZero = false;
    // Scan the step's remaining body: everything more-indented than the `uses:`
    // line, stopping at the next sibling key or list item.
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const indent = l.search(/\S/);
      if (indent < baseIndent) break;
      if (indent === baseIndent && /^\s*-\s/.test(l)) break;
      if (indent === baseIndent && /^\s*(?:-\s+)?(?:name|uses|run|id|env|with|if):/.test(l) && !/^\s*with:/.test(l)) break;
      const dm = l.match(/fetch-depth:\s*['"]?(\d+)/);
      if (dm) { depthZero = dm[1] === '0'; break; }
    }
    if (!depthZero) shallow = true;
  }
  return { hasCheckout, shallow };
}

/**
 * Every `scripts/...` path a workflow actually INVOKES (run: blocks, env, args).
 *
 * `on: push: paths:` / `paths-ignore:` entries are deliberately excluded. They
 * name files whose modification TRIGGERS the workflow, not files the workflow
 * runs — test.yml's push filter alone lists ~40 scripts, which would have made
 * nearly every script in the repo look reachable from a shallow checkout and
 * turned this guard into noise (it initially flagged autonomous-nightly.sh, a
 * launchd-only script, purely because test.yml path-lists a sibling).
 */
function referencedScripts(source) {
  const found = new Set();
  const lines = source.split('\n');
  const re = /(?:^|[\s'"`(=])(scripts\/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts|sh))/g;

  let pathsBlockIndent = -1;
  for (const line of lines) {
    const indent = line.search(/\S/);
    if (pathsBlockIndent >= 0) {
      // Still inside the filter list while lines stay more-indented (or blank).
      if (line.trim() === '' || indent > pathsBlockIndent) continue;
      pathsBlockIndent = -1;
    }
    if (/^\s*paths(?:-ignore)?:\s*$/.test(line)) { pathsBlockIndent = indent; continue; }
    // A whole-line YAML comment names a script as PROSE, not an
    // invocation — this repo's step comments routinely cross-reference
    // other scripts by path (BRO-1794 caught this: a step comment merely
    // naming a review-text sync helper as a "see also" made this function
    // report it as reachable, exactly the false-positive shape the paths:
    // exclusion above already exists to prevent). Only skips a line that
    // IS a comment top-to-bottom, not a trailing comment after real
    // content, so a genuine invocation is never hidden. NOTE: keep this
    // comment block itself free of stray backtick/quote characters near a
    // scripts/*.sh mention — spawnedScripts()'s regex below treats any
    // unpaired quote-like char as an opening delimiter and can match clean
    // across newlines to the next scripts/ path (the exact bug this
    // sentence is warning about, caught when this very paragraph tripped
    // it during review).
    if (/^\s*#/.test(line)) continue;

    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) found.add(m[1]);
  }
  return [...found];
}

/**
 * Local require()/import targets of one script, resolved to repo-relative
 * paths. Only relative specifiers are followed — node_modules is not our code.
 *
 * @param {string} source file text
 * @param {string} filePath repo-relative path of `source`
 * @param {(p:string)=>string|null} resolve maps a candidate path to a real
 *        repo-relative file (or null); supplied by the caller so this stays pure.
 */
function localDependencies(source, filePath, resolve) {
  const dir = filePath.replace(/\/[^/]*$/, '');
  const out = new Set();
  const re = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const joined = normalizePath(`${dir}/${m[1]}`);
    for (const cand of [joined, `${joined}.js`, `${joined}.ts`, `${joined}.mjs`, `${joined}.cjs`, `${joined}/index.js`]) {
      const hit = resolve(cand);
      if (hit) { out.add(hit); break; }
    }
  }
  return [...out];
}

/**
 * Scripts this one SHELLS OUT to — `execSync('node scripts/foo.js')`,
 * `spawn('bash', ['scripts/bar.sh'])`, and friends. Without these edges the
 * reachability graph stops at the process boundary, so a workflow that invokes
 * a dispatcher which invokes the real worker would leave the worker looking
 * unreachable — a FALSE NEGATIVE, which for this guard means a silent
 * multi-GB CI stall rather than a noisy lint failure (Codex ship-check
 * finding, 2026-07-26).
 */
function spawnedScripts(source, resolve) {
  const out = new Set();
  const re = /['"`][^'"`]*?(scripts\/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts|sh))/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const hit = resolve(m[1]);
    if (hit) out.add(hit);
  }
  return [...out];
}

/** posix path normalize without touching the filesystem (`a/b/../c` → `a/c`). */
function normalizePath(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Transitive closure of `entries` over a dependency graph.
 * @param {string[]} entries seed files
 * @param {Map<string,string[]>} graph file → files it requires
 */
function reachableFrom(entries, graph) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const dep of graph.get(cur) || []) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

/**
 * Full audit decision, given already-read file contents. Pure.
 *
 * @param {{
 *   scripts: Map<string,string>,    // repo-relative script path → source
 *   workflows: Map<string,string>,  // repo-relative workflow path → source
 * }} input
 * @returns {{violations:Array, shallowWorkflows:string[], exposedScripts:string[]}}
 *   violations: {file, line, command, snippet, subcommand, workflows[]}
 */
function auditUnboundedFetches({ scripts, workflows }) {
  const resolve = (p) => (scripts.has(p) ? p : null);

  // Graph edges = static requires + shell-out invocations. Both are needed:
  // overnight-digest.js is reached only by require(), while several workers are
  // reached only because a dispatcher execSync's `node scripts/<worker>.js`.
  const graph = new Map();
  for (const [file, src] of scripts) {
    graph.set(file, [...new Set([
      ...localDependencies(src, file, resolve),
      ...spawnedScripts(src, resolve),
    ])]);
  }

  // Seed the reachability search with every script named by a SHALLOW workflow.
  const shallowWorkflows = [];
  const entryToWorkflows = new Map();
  for (const [wf, src] of workflows) {
    const { hasCheckout, shallow } = analyzeWorkflowCheckout(src);
    if (!hasCheckout || !shallow) continue;
    shallowWorkflows.push(wf);
    for (const s of referencedScripts(src)) {
      if (!scripts.has(s)) continue;
      if (!entryToWorkflows.has(s)) entryToWorkflows.set(s, []);
      entryToWorkflows.get(s).push(wf);
    }
  }

  // file → which shallow workflows can reach it (direct entry or via require).
  const exposure = new Map();
  for (const [entry, wfs] of entryToWorkflows) {
    for (const file of reachableFrom([entry], graph)) {
      if (!exposure.has(file)) exposure.set(file, new Set());
      for (const wf of wfs) exposure.get(file).add(wf);
    }
  }

  const violations = [];
  for (const [file, src] of scripts) {
    const exposedVia = exposure.get(file);
    if (!exposedVia || exposedVia.size === 0) continue;
    for (const hit of findUnboundedFetches(src, file)) {
      violations.push({ file, ...hit, workflows: [...exposedVia].sort() });
    }
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    violations,
    shallowWorkflows: shallowWorkflows.sort(),
    exposedScripts: [...exposure.keys()].sort(),
  };
}

module.exports = {
  BOUND_FLAGS,
  analyzeWorkflowCheckout,
  auditUnboundedFetches,
  findUnboundedFetches,
  isFetchBounded,
  isWaived,
  isolateCommand,
  localDependencies,
  normalizePath,
  reachableFrom,
  referencedScripts,
  spawnedScripts,
  stripBlockComments,
};
