/**
 * Shared require-graph reachability engine, extracted from
 * ledger-coverage-check.js (BRO-3671) so a second CI gate — the same file's
 * sibling alert-ledger-commit-check.js — can answer the identical question
 * ("does this entry-point script, directly or transitively, call one of a
 * tracked set of exported functions?") for a DIFFERENT tracked module
 * (owner-alert-router.js's routeAlert/resolveCondition) without re-deriving
 * a weaker, comment-vulnerable text-regex version of this same logic.
 *
 * DETECTION METHOD: a real (acorn) AST walk, not text regex, because
 * "requires the file" is not the same as "calls the tracked function", and a
 * PROSE COMMENT mentioning a function by name is not a call either — both
 * false-positive classes an AST walk is naturally immune to (BRO-3671 found
 * exactly this: scripts/audit-reverse-discovery.js and
 * scripts/check-opening-night-completeness.js both contain the literal text
 * "owner-alert-router" and "routeAlert()" only inside `//` comments; a naive
 * `grep -rl owner-alert-router scripts/*.js` — the ticket's own repro
 * command — flags both, and neither actually requires or calls the router).
 *
 * `trackedTargets` is a `Map<libBasename, Set<exportName>>` passed in by the
 * caller (e.g. `new Map([['owner-alert-router.js', new Set(['routeAlert',
 * 'resolveCondition'])]])`) rather than a module-level constant, so this
 * engine has no opinion about which ledger/module it's being asked about —
 * each caller (ledger-coverage-check.js, alert-ledger-commit-check.js) owns
 * its own map and its own "which file must be staged" logic.
 *
 * The walk:
 *  1. Parse the file with acorn (fails open — skip the file — if acorn is
 *     unavailable or the file doesn't parse).
 *  2. Collect its `const { a, b: c } = require('./x')` / `const m =
 *     require('./x')` bindings (any depth, not just top-level — some
 *     scripts lazy-require inside a function body), including the
 *     assignment-expression form (`({ a } = require('./x'))`) used by
 *     lazy try/catch-require patterns.
 *  3. Walk the target subtree (whole Program for an entry-point script; a
 *     single function's body when recursing into a required lib) for
 *     CallExpressions whose callee resolves to one of those bindings.
 *  4. A call reaches a tracked target if it resolves directly to one of
 *     trackedTargets' exports, or (recursively, memoized, cycle-safe) to an
 *     exported function in another local file whose OWN body reaches, or to
 *     a same-file sibling function (no require() involved for that hop).
 */

const fs = require('fs');
const path = require('path');

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

function isTrackedExport(resolvedPath, exportName, trackedTargets) {
  const names = trackedTargets.get(path.basename(resolvedPath));
  return !!names && names.has(exportName);
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
// `declNodes` holds every Identifier AST node object created AT the binding
// site — kept by reference (not by name) so subtreeReferencesTracked can
// exclude precisely these occurrences from "is this name used anywhere"
// scanning without also excluding a same-named USAGE elsewhere in the file.
// For an ObjectPattern property, that's BOTH `prop.key` and `prop.value` —
// even for shorthand `{ routeAlert }`, acorn allocates two DISTINCT
// Identifier objects (verified: `prop.key === prop.value` is false) with the
// same name and position. Recording only `prop.value` left `prop.key`
// unexcluded, so a walk over the whole declaration statement would find its
// own key node as a "reference" and flag every script that merely
// destructures a tracked export — with no other use — as reaching it; the
// exact false-positive class this AST engine exists to avoid.
function bindingsFromPattern(pattern, requirePath, out) {
  if (!requirePath.startsWith('.')) return;
  if (pattern.type === 'Identifier') {
    out.push({ localName: pattern.name, kind: 'namespace', exportName: null, requirePath, declNodes: [pattern] });
  } else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type !== 'Property') continue;
      const exportName =
        prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'Literal' ? String(prop.key.value) : null;
      const localName = prop.value.type === 'Identifier' ? prop.value.name : null;
      if (exportName && localName) out.push({ localName, kind: 'named', exportName, requirePath, declNodes: [prop.key, prop.value] });
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
// CallExpression that reaches one of trackedTargets' exports, directly,
// through another local file's exported function, OR through a same-file
// sibling function call (e.g. discoverAnnouncedClosingDate calling
// discoverAnnouncedDate — both defined in the same file, no require()
// involved for that hop)?
function subtreeCallsTracked(subtreeNode, bindings, definedFunctions, currentAbsPath, acorn, memo, stack, trackedTargets, opts) {
  let found = false;
  walkNode(subtreeNode, (node) => {
    if (found || node.type !== 'CallExpression') return;
    const callee = node.callee;

    if (callee.type === 'Identifier') {
      const binding = bindings.find((b) => b.kind === 'named' && b.localName === callee.name);
      if (binding) {
        const resolvedPath = resolveRequirePath(currentAbsPath, binding.requirePath);
        if (
          isTrackedExport(resolvedPath, binding.exportName, trackedTargets) ||
          reachedName(resolvedPath, binding.exportName, acorn, memo, stack, trackedTargets, opts)
        ) {
          found = true;
        }
      } else if (reachesLocalFunction(callee.name, definedFunctions, bindings, currentAbsPath, acorn, memo, stack, trackedTargets, opts)) {
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
      if (
        isTrackedExport(resolvedPath, propName, trackedTargets) ||
        reachedName(resolvedPath, propName, acorn, memo, stack, trackedTargets, opts)
      ) {
        found = true;
      }
    }
  });
  if (found) return true;
  if (opts && opts.referenceCountsAsReach) {
    return subtreeReferencesTrackedDirectly(subtreeNode, bindings, currentAbsPath, trackedTargets);
  }
  return false;
}

// opts.referenceCountsAsReach (opt-in, default off — preserves
// ledger-coverage-check.js's exact original call-only semantics): does the
// subtree reference a directly-required tracked export BY NAME anywhere
// other than its own require() declaration site — e.g. passed by reference
// into another function's options object, not called by this file itself?
// Real case (BRO-3671): scripts/opening-night-checklist.js requires
// `routeAlert` from owner-alert-router.js and passes it as
// `executeRemediations(planned, { ..., routeAlert, ... })` — a dependency-
// injection pattern where the ACTUAL call happens inside
// opening-night-remediation.js's executeRemediations(), several calls away
// from any require() this engine could follow. A pure call-callee walk
// never sees this; naming the export at all (outside its own binding site)
// is a strong enough signal for a directly-required tracked module,
// deliberately NOT extended into the wrapper-function/local-function
// recursion paths (reachesLocalFunction/reachedName) to keep the widened
// surface bounded to exactly this shape.
// KNOWN LIMITATION: does not distinguish a real reference from an unrelated
// object-KEY that happens to share the tracked export's name (e.g.
// `{ routeAlert: somethingElse }`) — acceptable for owner-alert-router.js's
// two distinctive export names (routeAlert/resolveCondition), same
// heuristic-with-documented-limitation standard as this file's YAML-side
// sibling checks.
function subtreeReferencesTrackedDirectly(subtreeNode, bindings, currentAbsPath, trackedTargets) {
  const declNodes = new Set(bindings.flatMap((b) => b.declNodes || []));
  let found = false;
  walkNode(subtreeNode, (node) => {
    if (found || node.type !== 'Identifier' || declNodes.has(node)) return;
    const binding = bindings.find((b) => b.kind === 'named' && b.localName === node.name);
    if (!binding) return;
    const resolvedPath = resolveRequirePath(currentAbsPath, binding.requirePath);
    if (isTrackedExport(resolvedPath, binding.exportName, trackedTargets)) found = true;
  });
  return found;
}

// Does calling the same-file function `name` (e.g. a sibling helper, not
// require()d) itself reach a tracked call? Memoized per (absPath, name).
function reachesLocalFunction(name, definedFunctions, bindings, currentAbsPath, acorn, memo, stack, trackedTargets, opts) {
  const fnNode = definedFunctions.get(name);
  if (!fnNode) return false;
  const key = `${currentAbsPath}#local:${name}`;
  if (memo.has(key)) return memo.get(key);
  if (stack.has(key)) return false;
  stack.add(key);
  const reach = subtreeCallsTracked(fnNode, bindings, definedFunctions, currentAbsPath, acorn, memo, stack, trackedTargets, opts);
  stack.delete(key);
  memo.set(key, reach);
  return reach;
}

// Does the function exported as `exportName` from `absPath` itself reach a
// tracked call? Memoized per (absPath, exportName); cycle-safe.
function reachedName(absPath, exportName, acorn, memo, stack, trackedTargets, opts) {
  const key = `${absPath}#${exportName}`;
  if (memo.has(key)) return memo.get(key);
  if (stack.has(key)) return false;
  if (isTrackedExport(absPath, exportName, trackedTargets)) {
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
  const reach = subtreeCallsTracked(bodyNode, bindings, definedFunctions, absPath, acorn, memo, stack, trackedTargets, opts);
  stack.delete(key);

  memo.set(key, reach);
  return reach;
}

// Does the whole file at absPath (any code path in it) reach a tracked call?
// Used for the entry-point scripts workflows invoke directly via
// `node scripts/X.js` — unlike reachedName(), no export-name scoping is
// needed because the whole file runs, not just one exported function.
function fileReachesTracked(absPath, acorn, memo, trackedTargets, opts) {
  const key = `${absPath}#__file__`;
  if (memo.has(key)) return memo.get(key);
  const ast = parseFileCached(absPath, acorn);
  if (!ast) {
    memo.set(key, false);
    return false;
  }
  const bindings = collectBindings(ast);
  const definedFunctions = collectDefinedFunctions(ast);
  const reach = subtreeCallsTracked(ast, bindings, definedFunctions, absPath, acorn, memo, new Set(), trackedTargets, opts);
  memo.set(key, reach);
  return reach;
}

/**
 * findTrackedCallerScripts(scriptsDir, trackedTargets, opts) -> Set<string>
 * Returns scriptsDir-relative paths (e.g. "audit-closing-dates.js" or
 * "video-reviews/foo.js") for every .js file under scriptsDir whose own code
 * calls one of trackedTargets' exports, directly or transitively. Returns an
 * empty set (fails open, logs nothing — callers should treat this as "skip
 * the check") if acorn isn't installed. `opts.referenceCountsAsReach` (see
 * subtreeReferencesTrackedDirectly's header) defaults to off.
 */
function findTrackedCallerScripts(scriptsDir, trackedTargets, opts = {}) {
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
        if (fileReachesTracked(abs, acorn, memo, trackedTargets, opts)) {
          result.add(path.relative(scriptsDir, abs).split(path.sep).join('/'));
        }
      }
    }
  };
  walk(scriptsDir);
  return result;
}

module.exports = {
  findTrackedCallerScripts,
  fileReachesTracked,
  reachedName,
  resolveRequirePath,
};
