#!/usr/bin/env node
/**
 * Task #1662 / Notion 3be637c5: CI guard for the "test mutates a real tracked
 * data/*.json file in place" bug class fixed by hand twice in one session
 * (tests/unit/validate-data-push-refusal-sentinel.test.mjs, commit
 * b4d6c619317 — backup/mutate/restore on the live data/shows.json symlink;
 * tests/e2e/diary-generate-script.spec.ts, commit 8bf5f00eb08 — rename
 * data/diary-shows.json out of place and back). Both raced ~20 parallel
 * sessions + CI that write to those files on their own cadence, and both were
 * only caught by a manual grep sweep, not by anything automated.
 *
 * DETECTION METHOD: a real (acorn) AST walk, not text regex, so a variable
 * whose real-data-ness is only visible after tracing through one or two
 * `path.join()`/reassignment hops (`const dataDir = path.join(__dirname,
 * '../../data'); const diaryPath = path.join(dataDir, 'diary-shows.json');`)
 * is still resolved, not just the single-hop literal case.
 *
 * For every `writeFileSync`/`renameSync`/`copyFileSync` call (matched by
 * property/identifier name only — `fs.writeFileSync(...)` and a bare
 * destructured `writeFileSync(...)` both count; the object is not verified,
 * a documented KNOWN_GAP), the argument(s) that are actually a WRITE target
 * are resolved back through local variable assignments and `path.join`/
 * `path.resolve` calls to a best-effort list of literal path segments:
 *   - writeFileSync(target, data)        → check target (arg 0)
 *   - renameSync(oldPath, newPath)       → check BOTH (moving the real file
 *                                           OUT of place is exactly the
 *                                           diary-shows.json regression, and
 *                                           it is the FIRST argument there)
 *   - copyFileSync(src, dest)            → check dest (arg 1) only — src is
 *                                           a READ; the fixed sentinel test's
 *                                           own `copyFileSync(REAL_SHOWS_JSON,
 *                                           fixturePath)` legitimately reads
 *                                           the real file into a tmp fixture,
 *                                           and checking arg 0 there would be
 *                                           a false positive on the FIX.
 * A resolved argument is a violation when its segment chain assembles into a
 * `data/*.json`-shaped path AND no tmp marker (`mkdtemp(Sync)?`, `tmpdir`,
 * `RUNNER_TEMP`, `TMPDIR`, a literal `/tmp/`) appears anywhere in its
 * derivation chain.
 *
 * Heuristic by nature (no true data-flow analysis — the env table is a flat
 * "last assignment wins" map, not block-scoped; an unresolvable identifier or
 * function call contributes nothing rather than being flagged) — false
 * negatives are possible and accepted, consistent with
 * audit-help-flag-safety.js / audit-delete-without-breadcrumb.js's own
 * precedent for this class of guard. False positives are the more expensive
 * direction for a blocking gate, so ambiguous/unresolvable expressions are
 * never flagged.
 *
 * FAILS OPEN: a file that fails to parse (syntax error, unsupported syntax)
 * or a process where acorn itself is unavailable is skipped/reported as an
 * error, not crashed on or treated as a violation — this must never block CI
 * on an unrelated file, and must never manufacture a false "no violations"
 * either (see the parse-error reporting in main()).
 *
 * KNOWN_GAPS:
 *   - the write-call's OBJECT is never checked, only the property/identifier
 *     name — `someUnrelatedThing.writeFileSync(...)` would still be scanned.
 *     Deliberate: false positives here are directory writes, never data loss.
 *   - a write function reached via an ALIASED import (`import { writeFileSync
 *     as wfs } from 'fs'; wfs(REAL_PATH, data)`) or COMPUTED member access
 *     (`fs['writeFileSync'](...)`) is invisible — calleeIdentifierName() only
 *     reads the literal callee identifier/property name, never traces import
 *     specifiers. This is a different failure mode than the resolver gaps
 *     below: the CALL SITE itself is never found, not just its argument
 *     under-resolved (ship-check adversarial-review finding, task #1662).
 *     Safe (false-negative) direction; no instance in the current corpus.
 *   - `funcDefs` (named `function foo() {}` declarations, used for local
 *     function-return tracing) stays a single flat file-wide map — two
 *     unrelated same-named function declarations in different scopes can
 *     cross-resolve. Matches audit-delete-without-breadcrumb.js's precedent.
 *     Plain-variable `env`, by contrast, IS lexically scoped per call site
 *     (module scope + each enclosing function's own locals/params, with a
 *     `beforePos` cutoff so a later reassignment can't leak backward — see
 *     collectScopeDecls()/shadowParams()).
 *   - dynamic paths built from anything other than string literals,
 *     identifiers, `+` concatenation, template literals, and
 *     `path.join`/`path.resolve` calls are not resolved (e.g. array `.join()`
 *     tricks, computed member access) — they simply never match, which is
 *     the safe (false-negative, not false-positive) direction.
 *
 * Exemption (reviewed false positive): add
 *   // test-data-write-guard-ok: <reason>
 * anywhere in the offending file.
 *
 * Usage:
 *   node scripts/lib/test-data-write-guard.js            scan tests/, report
 *   node scripts/lib/test-data-write-guard.js --help, -h  print usage and exit
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./cli-help.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXEMPTION = 'test-data-write-guard-ok';

const USAGE = `test-data-write-guard.js — flags tests that write a real tracked data/*.json
path outside a tmp()/mkdtemp() fixture (task #1662).

Usage:
  node scripts/lib/test-data-write-guard.js             scan tests/, report violations
  node scripts/lib/test-data-write-guard.js --help, -h   print this usage and exit
`;

// Which argument index(es) of each call are an actual WRITE target. See the
// file header for why copyFileSync only checks arg 1 while renameSync checks
// both.
// Object.create(null) — a bare `{}` inherits Object.prototype, so a callee
// named e.g. `toString`/`constructor`/`hasOwnProperty` would resolve to a
// truthy inherited function instead of `undefined` and crash the arg-index
// loop below on a non-iterable.
const WRITE_ARG_INDEXES = Object.assign(Object.create(null), {
  writeFileSync: [0],
  renameSync: [0, 1],
  copyFileSync: [1],
});

// Matches inside literal text, identifier names, and raw source fallbacks.
const TMP_MARKER_RE = /\bmkdtemp(?:Sync)?\b|\btmpdir\b|\bRUNNER_TEMP\b|\bTMPDIR\b|\/tmp\//;

function loadAcorn() {
  try {
    return { acorn: require('acorn'), walk: require('acorn-walk') };
  } catch {
    return null;
  }
}

function calleeIdentifierName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

function segmentIsDataDir(segment) {
  if (typeof segment !== 'string') return false;
  const norm = segment.replace(/\\/g, '/').replace(/\/+$/, '');
  return /(^|\/)data$/.test(norm);
}

/**
 * Does this resolved segment chain assemble into a `data/*.json` path? Either
 * the LAST segment alone already spells out `data/something.json` (the
 * SHOWS_JSON single-hop case: `join(ROOT, 'data/shows.json')`), or the last
 * segment is a bare `*.json` filename and an EARLIER segment in the same
 * chain resolves to a `data` directory (the diary-shows.json two-hop case:
 * `join(dataDir, 'diary-shows.json')` where `dataDir` itself resolved to
 * `'../../data'`).
 */
function resolvedIsTrackedDataJson(segments) {
  if (!segments.length) return false;
  const last = segments[segments.length - 1];
  if (typeof last !== 'string' || !/\.json$/i.test(last)) return false;
  const lastNorm = last.replace(/\\/g, '/');
  // `.+` (not `[^/]+`): a NESTED subdirectory baked into one literal string
  // (e.g. `'data/review-texts/foo/bar.json'`) must match too, not just a
  // single flat level directly under data/ — a `[^/]+` cutoff here missed
  // exactly that shape (ship-check adversarial-review finding, task #1662).
  if (/(^|\/)data\/.+\.json$/.test(lastNorm)) return true;
  return segments.slice(0, -1).some(segmentIsDataDir);
}

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

/**
 * Resolve one expression node to { segments, tmp }. `env` maps identifier
 * name -> its most recent declaration/assignment RHS node (flat, last wins —
 * see KNOWN_GAPS). `funcDefs` maps a named `function foo() {}` declaration to
 * its node, so `const repo = makeRepo();` can be traced into `makeRepo`'s own
 * `return mkdtempSync(...)` (real corpus case: tests/unit/review-gate.test.mjs
 * wraps mkdtempSync in a local `makeRepo()` helper reused across many tests —
 * without this, every call site read as an unresolved call and false-positived
 * on `writeFileSync(join(repo, 'data', 'scratch.json'), ...)`). `seen` guards
 * against self-referential cycles (`let x = x;`, or a function that
 * (in)directly calls itself) during identifier/function resolution — it
 * shares one namespace for both since JS variable and function names do too.
 * `src` is the full (possibly shebang-stripped, possibly TS-transpiled)
 * source text, used only for the raw-text fallback on node types not
 * explicitly handled.
 */
function resolveExprSegments(node, env, funcDefs, seen, src) {
  if (!node) return { segments: [], tmp: false };

  switch (node.type) {
    case 'Literal': {
      if (typeof node.value === 'string') {
        return { segments: [node.value], tmp: TMP_MARKER_RE.test(node.value) };
      }
      return { segments: [], tmp: false };
    }

    case 'TemplateLiteral': {
      let segments = [];
      let tmp = false;
      for (let i = 0; i < node.quasis.length; i++) {
        const cooked = node.quasis[i].value.cooked;
        if (cooked) {
          segments.push(cooked);
          if (TMP_MARKER_RE.test(cooked)) tmp = true;
        }
        if (i < node.expressions.length) {
          const r = resolveExprSegments(node.expressions[i], env, funcDefs, seen, src);
          segments = segments.concat(r.segments);
          tmp = tmp || r.tmp;
        }
      }
      return { segments, tmp };
    }

    case 'BinaryExpression': {
      if (node.operator !== '+') return { segments: [], tmp: false };
      const l = resolveExprSegments(node.left, env, funcDefs, seen, src);
      const r = resolveExprSegments(node.right, env, funcDefs, seen, src);
      return { segments: l.segments.concat(r.segments), tmp: l.tmp || r.tmp };
    }

    case 'Identifier': {
      if (TMP_MARKER_RE.test(node.name)) return { segments: [], tmp: true };
      const decl = env.get(node.name);
      // OPAQUE (a function's own parameter, shadowing any outer same-named
      // binding — see shadowParams) resolves the same as "unresolved": a
      // known name whose value this tool cannot see, never an outer fallback.
      if (!decl || decl === OPAQUE) return { segments: [], tmp: false };
      // Cycle guard is keyed by the DECLARATION NODE, not the bare name — two
      // different scopes' own `repo` locals are two different AST nodes that
      // happen to share a name (real corpus case: a test declares `const repo
      // = makeRepo()` and makeRepo's OWN body separately declares `const repo
      // = mkdtempSync(...)`). Keying on the name alone made resolving the
      // outer `repo` mark the name as "in progress", so tracing into
      // makeRepo's unrelated inner `repo` hit a false cycle and returned
      // nothing, silently losing the tmp signal.
      if (seen.has(decl)) return { segments: [], tmp: false };
      seen.add(decl);
      const r = resolveExprSegments(decl, env, funcDefs, seen, src);
      seen.delete(decl);
      return r;
    }

    case 'MemberExpression': {
      const text = src.slice(node.start, node.end);
      return { segments: [], tmp: TMP_MARKER_RE.test(text) };
    }

    case 'CallExpression': {
      const name = calleeIdentifierName(node.callee);
      if (name && /^mkdtemp(?:Sync)?$/.test(name)) return { segments: [], tmp: true };
      if (name === 'tmpdir') return { segments: [], tmp: true };

      let segments = [];
      let tmp = false;
      if (name === 'join' || name === 'resolve') {
        for (const arg of node.arguments) {
          const r = resolveExprSegments(arg, env, funcDefs, seen, src);
          segments = segments.concat(r.segments);
          tmp = tmp || r.tmp;
        }
        return { segments, tmp };
      }

      // A call to a locally-defined function/arrow — trace into what it
      // RETURNS rather than treating the call as opaque. Plain Identifier
      // callees only (`makeRepo()`); a computed or member-expression callee
      // falls through to the generic best-effort handling below. Cycle guard
      // keyed by the function's AST node (see the Identifier case above for
      // why name-keying is wrong).
      if (node.callee.type === 'Identifier') {
        const fnNode = funcDefs.get(node.callee.name) || env.get(node.callee.name);
        if (fnNode && FUNCTION_NODE_TYPES.has(fnNode.type) && !seen.has(fnNode)) {
          seen.add(fnNode);
          const r = resolveFunctionReturns(fnNode, env, funcDefs, seen, src);
          seen.delete(fnNode);
          if (r) return r;
        }
      }

      // Unknown call — best-effort: still scan its arguments (a locally
      // defined helper that returns a path is otherwise invisible), and the
      // callee text itself (covers a custom `makeTmpDir()`-style helper).
      for (const arg of node.arguments) {
        const r = resolveExprSegments(arg, env, funcDefs, seen, src);
        segments = segments.concat(r.segments);
        tmp = tmp || r.tmp;
      }
      const calleeText = src.slice(node.callee.start, node.callee.end);
      if (TMP_MARKER_RE.test(calleeText)) tmp = true;
      return { segments, tmp };
    }

    default: {
      const text = src.slice(node.start, node.end);
      return { segments: [], tmp: TMP_MARKER_RE.test(text) };
    }
  }
}

const FUNCTION_NODE_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * A base visitor (for `walk.simple(node, visitors, base)`) that never
 * descends into a nested function's params/body — so a scope-collection walk
 * using it only ever sees declarations made DIRECTLY in the given node, never
 * inside a function nested within it. This is what makes `collectScopeDecls`
 * a real (if coarse — no block scoping) per-scope collector instead of a
 * single flat file-wide map: this corpus reuses generic local names (`repo`,
 * `statePath`, `dir`) across many independent `test(...)`/`beforeEach(...)`
 * callbacks (real case: review-gate.test.mjs declares `const repo =
 * makeRepo();` at ~15 call sites), and a flat "last declaration in the file
 * wins" map resolves an identifier to whichever OTHER scope happened to
 * declare it last, not the one actually in scope at the site being resolved.
 */
function buildShallowBase(walk) {
  const base = Object.assign({}, walk.base);
  for (const t of FUNCTION_NODE_TYPES) base[t] = () => {};
  return base;
}

/**
 * Collect `name -> initializer/RHS node` for declarations made DIRECTLY
 * within `node` (see buildShallowBase) into `into`.
 *
 * `beforePos` (default Infinity — no cutoff) restricts collection to
 * declarations/assignments that start strictly before that source offset.
 * This matters for module/function TOP-LEVEL scope, which executes
 * sequentially: a variable reused for something else later in the same
 * scope (`let x = 'data/foo.json'; ...; x = tmpPath;`) must resolve, at an
 * earlier call site, to whatever it held AT THAT POINT — not to its final
 * value in the file (adversarial-review finding, task #1662: a flat
 * whole-scope "last declaration wins" collector conflates "last in the
 * file" with "in scope here", which is only correct for a scope that is
 * never reassigned after the site being resolved).
 */
function collectScopeDecls(node, into, walk, shallowBase, beforePos = Infinity) {
  walk.simple(node, {
    VariableDeclarator(n) {
      if (n.start >= beforePos) return;
      if (n.id.type === 'Identifier' && n.init) into.set(n.id.name, n.init);
    },
    AssignmentExpression(n) {
      if (n.start >= beforePos) return;
      if (n.operator === '=' && n.left.type === 'Identifier') into.set(n.left.name, n.right);
    },
  }, shallowBase);
}

/**
 * Identifier names bound by a function's own parameter list — including
 * destructured/defaulted/rest forms, best-effort. Used to SHADOW those names
 * in the function's local scope map with an explicit "known, but opaque"
 * marker (see shadowParams below) rather than leaving them unset, which
 * would silently fall through to whatever an outer scope happens to declare
 * under the same name (adversarial-review finding, task #1662: a generic
 * helper like `function writeJson(target, data) { fs.writeFileSync(target,
 * ...) }` must never resolve `target` to some unrelated same-named
 * module-level constant just because the parameter itself isn't a
 * VariableDeclarator).
 */
function collectParamNames(params, out = []) {
  for (const p of params || []) {
    if (!p) continue;
    switch (p.type) {
      case 'Identifier': out.push(p.name); break;
      case 'AssignmentPattern': collectParamNames([p.left], out); break;
      case 'RestElement': collectParamNames([p.argument], out); break;
      case 'ObjectPattern':
        for (const prop of p.properties || []) {
          if (prop.type === 'RestElement') collectParamNames([prop.argument], out);
          else if (prop.value) collectParamNames([prop.value], out);
        }
        break;
      case 'ArrayPattern':
        collectParamNames(p.elements || [], out);
        break;
      default: break; // computed/complex — best effort, skip
    }
  }
  return out;
}

// Sentinel distinct from `undefined`: `env.get(name)` returning this means
// "this name IS a real binding here, but its value is opaque" — the
// Identifier resolver treats it exactly like "unresolved" (segments: [],
// tmp: false) but, critically, OVERWRITES whatever the same name would have
// resolved to in an outer/copied scope, which a plain omission cannot do.
const OPAQUE = Symbol('opaque');

/** Shadow every name in fnNode's own parameter list within `localEnv` as OPAQUE. */
function shadowParams(fnNode, localEnv) {
  for (const name of collectParamNames(fnNode.params)) localEnv.set(name, OPAQUE);
}

/**
 * Trace what a local function/arrow RETURNS, unioning across every `return`
 * in its body (best-effort — not scoped to skip nested function bodies for
 * the RETURN search itself, so a return inside a nested helper can leak in;
 * accepted per the file header's "false positives are the expensive
 * direction" stance, since that only ever ADDS segments/tmp signal, never
 * removes a real one). Returns null (not `{segments:[], tmp:false}`) when the
 * function has no `return` with an argument at all, so the caller can fall
 * through to generic handling instead of wrongly asserting "resolved to
 * nothing".
 */
function resolveFunctionReturns(fnNode, env, funcDefs, seen, src) {
  const loaders = loadAcorn();
  if (!loaders) return null;
  const { walk } = loaders;

  // Arrow with an expression body (`() => mkdtempSync(...)`) — implicit
  // return, no BlockStatement/ReturnStatement to walk. Still shadow params
  // (see shadowParams) — an expression body can reference them directly.
  if (fnNode.type === 'ArrowFunctionExpression' && fnNode.body.type !== 'BlockStatement') {
    const paramEnv = new Map(env);
    shadowParams(fnNode, paramEnv);
    return resolveExprSegments(fnNode.body, paramEnv, funcDefs, seen, src);
  }
  if (!fnNode.body || fnNode.body.type !== 'BlockStatement') return null;

  // A scope-shadowed copy of env — see buildShallowBase's doc comment for
  // why this must not be a flat merge. Params shadowed BEFORE locals, since
  // this function's own declarations should win over a same-named param
  // (real JS: `function f(x) { const x = 1; ... }` is a SyntaxError for var
  // params but this ordering is harmless either way and simpler than
  // detecting the conflict).
  const localEnv = new Map(env);
  shadowParams(fnNode, localEnv);
  collectScopeDecls(fnNode.body, localEnv, walk, buildShallowBase(walk));

  const returnArgs = [];
  walk.simple(fnNode.body, {
    ReturnStatement(node) {
      if (node.argument) returnArgs.push(node.argument);
    },
  });
  if (!returnArgs.length) return null;

  let segments = [];
  let tmp = false;
  for (const arg of returnArgs) {
    const r = resolveExprSegments(arg, localEnv, funcDefs, seen, src);
    segments = segments.concat(r.segments);
    tmp = tmp || r.tmp;
  }
  return { segments, tmp };
}

/**
 * Strip TypeScript type syntax via the real TS compiler (`transpileModule` —
 * fast, per-file, no cross-file type checking) so acorn (a plain-JS parser)
 * can walk what's left. Type erasure only (module: ESNext, target: ES2022),
 * so string literals / control flow / call shapes are preserved verbatim —
 * only the parts acorn couldn't parse anyway are removed. No `.tsx` test
 * files exist in this repo (verified) so JSX support is deliberately not
 * configured; a real one would fail closed here (see the `.ts`/`.tsx`
 * dispatch in scanFile) rather than being silently mis-parsed.
 */
function transpileTypeScript(src) {
  let ts;
  try { ts = require('typescript'); } catch { return { text: null, error: 'typescript is not installed' }; }
  try {
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: false,
    });
    return { text: out.outputText, error: null };
  } catch (e) {
    return { text: null, error: `typescript transpile failed: ${e.message}` };
  }
}

/**
 * Parse `src` and return { violations, error }. Fails open (returns error,
 * no throw) on unparseable source. Pass `isTypeScript: true` for `.ts`
 * fixtures — see transpileTypeScript().
 *
 * violations: [{ fn, argIndex, line, snippet, resolvedPath }]
 */
function analyzeSource(src, { isTypeScript = false } = {}) {
  const loaders = loadAcorn();
  if (!loaders) return { violations: [], error: 'acorn not installed' };
  const { acorn, walk } = loaders;

  let stripped = src.replace(/^#![^\n]*\n/, '');

  if (isTypeScript) {
    const { text, error } = transpileTypeScript(stripped);
    if (error) return { violations: [], error };
    stripped = text;
  }

  let ast;
  try {
    ast = acorn.parse(stripped, { ecmaVersion: 2022, sourceType: 'module', allowHashBang: true });
  } catch {
    try {
      ast = acorn.parse(stripped, { ecmaVersion: 2022, sourceType: 'script' });
    } catch (e2) {
      return { violations: [], error: e2.message };
    }
  }

  // funcDefs stays a flat file-wide map (KNOWN_GAPS: two same-named function
  // declarations in different scopes can cross-resolve) — named function
  // declarations are rare enough to reuse across sibling scopes that the
  // simpler flat lookup is an acceptable trade for the lower complexity.
  const funcDefs = new Map();
  walk.simple(ast, {
    FunctionDeclaration(node) {
      if (node.id) funcDefs.set(node.id.name, node);
    },
  });

  // See buildShallowBase()/collectScopeDecls() — plain-variable `env` is
  // built fresh per call site below (module scope + each enclosing
  // function's own locals + param shadowing), not as one flat file-wide map.
  const shallowBase = buildShallowBase(walk);

  const violations = [];
  walk.ancestor(ast, {
    CallExpression(node, state, ancestors) {
      const name = calleeIdentifierName(node.callee);
      const argIdxs = WRITE_ARG_INDEXES[name];
      if (!argIdxs) return;

      // Build the env actually in scope at THIS call site: module scope
      // (declarations before this point ONLY — see collectScopeDecls's
      // `beforePos` doc comment, adversarial-review finding on module-level
      // reassignment), then overlay each enclosing function's own params
      // (shadowed opaque) and locals, outermost first, so the innermost
      // (closest-declared) shadowing wins last.
      const scoped = new Map();
      collectScopeDecls(ast, scoped, walk, shallowBase, node.start);
      for (const anc of ancestors) {
        if (anc === node) continue;
        if (!FUNCTION_NODE_TYPES.has(anc.type) || !anc.body) continue;
        shadowParams(anc, scoped);
        collectScopeDecls(anc.body, scoped, walk, shallowBase, node.start);
      }

      for (const idx of argIdxs) {
        const argNode = node.arguments[idx];
        if (!argNode) continue;
        const { segments, tmp } = resolveExprSegments(argNode, scoped, funcDefs, new Set(), stripped);
        if (!tmp && resolvedIsTrackedDataJson(segments)) {
          violations.push({
            fn: name,
            argIndex: idx,
            line: lineOf(stripped, node.start),
            snippet: stripped.slice(node.start, node.end).slice(0, 160).replace(/\s+/g, ' ').trim(),
            resolvedPath: segments.join('/'),
          });
        }
      }
    },
  });

  return { violations, error: null };
}

function scanFile(absPath) {
  const src = fs.readFileSync(absPath, 'utf8');
  if (src.includes(EXEMPTION)) return { file: absPath, violations: [], error: null, exempt: true };
  const isTypeScript = /\.ts$/.test(absPath) && !/\.d\.ts$/.test(absPath);
  const { violations, error } = analyzeSource(src, { isTypeScript });
  return { file: absPath, violations, error, exempt: false };
}

const TEST_FILE_RE = /\.(?:mjs|ts|js)$/;
const SCRIPTS_TEST_FILE_RE = /\.test\.(?:mjs|ts|js)$/;
const SKIP_DIR_RE = /^(?:node_modules|\.git|\.claude)$/;

function walkDir(dir, fileFilter, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIR_RE.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, fileFilter, out);
    else if (entry.isFile() && fileFilter(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Default scan scope: every test-shaped file under tests/ (per the card's
 * suggested approach), plus colocated `*.test.mjs`/`*.test.ts`/`*.test.js`
 * files anywhere under scripts/ (CLAUDE.md rule 15's test-extraction
 * pattern lives there, not under tests/, and the same real-data-mutation
 * anti-pattern is possible there — confirmed clean on the current tree by
 * the evidence sweep, but the class of risk is identical).
 */
function listTestFiles({ repoRoot = REPO_ROOT } = {}) {
  const out = [];
  walkDir(path.join(repoRoot, 'tests'), (name) => TEST_FILE_RE.test(name), out);
  walkDir(path.join(repoRoot, 'scripts'), (name) => SCRIPTS_TEST_FILE_RE.test(name), out);
  return out.sort();
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return;
  }

  const files = listTestFiles();
  const violations = [];
  const parseErrors = [];

  for (const file of files) {
    const result = scanFile(file);
    if (result.error) { parseErrors.push({ file, error: result.error }); continue; }
    for (const v of result.violations) violations.push({ ...v, file });
  }

  if (parseErrors.length) {
    console.log(`⚠️  ${parseErrors.length} file(s) could not be parsed and were skipped (not treated as violations):`);
    for (const e of parseErrors) console.log(`  ${path.relative(REPO_ROOT, e.file)}: ${e.error}`);
    // A parse failure is a COVERAGE gap, not a clean bill of health — it must
    // not read as silent success (ship-check adversarial-review finding,
    // task #1662): a file this guard cannot parse is a file it cannot
    // vouch for, and that is worth a loud, non-zero exit distinct from an
    // actual violation, even though the whole step is advisory for now.
    process.exitCode = 1;
  }

  if (violations.length === 0) {
    if (parseErrors.length === 0) {
      console.log(`✅ test-data-write-guard: no violations (${files.length} test files scanned).`);
    } else {
      console.log(`⚠️  test-data-write-guard: no violations found, but ${parseErrors.length} file(s) were unscannable — see above.`);
    }
    return;
  }

  console.log(`🚨 test-data-write-guard: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.log(`  ${path.relative(REPO_ROOT, v.file)}:${v.line}  ${v.fn}() arg${v.argIndex} → ${v.resolvedPath}`);
    console.log(`      ${v.snippet}`);
  }
  console.log(`\nA test must never write to a real tracked data/*.json path — CI and ~20 parallel`);
  console.log(`sessions write to those files on their own cadence (task #1662). Use a`);
  console.log(`mkdtempSync(path.join(os.tmpdir(), 'prefix-')) fixture instead.`);
  console.log(`False positive? Add  // ${EXEMPTION}: <reason>  anywhere in the file.\n`);
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  WRITE_ARG_INDEXES,
  TMP_MARKER_RE,
  EXEMPTION,
  calleeIdentifierName,
  segmentIsDataDir,
  resolvedIsTrackedDataJson,
  resolveExprSegments,
  resolveFunctionReturns,
  buildShallowBase,
  collectScopeDecls,
  collectParamNames,
  shadowParams,
  OPAQUE,
  transpileTypeScript,
  analyzeSource,
  scanFile,
  listTestFiles,
};
