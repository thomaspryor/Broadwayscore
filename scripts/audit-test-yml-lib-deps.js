#!/usr/bin/env node
/**
 * Advisory guard (task #1745): flag scripts/lib/*.test.mjs files that
 * require()/import a file OUTSIDE scripts/lib/ (a top-level scripts/*.js
 * helper, or a root config like vercel.json) that test.yml's `on.push.paths`
 * push-trigger allow-list doesn't reference.
 *
 * Background: `scripts/lib/**` is a single push-path glob (added by task
 * #1745, replacing ~200 individually hand-listed scripts/lib paths) covering
 * every source + colocated test file INSIDE scripts/lib/. That closes the bug
 * class where a solo push touching only a scripts/lib file triggered ZERO CI.
 * But a scripts/lib test can still require() something OUTSIDE scripts/lib/
 * (e.g. scripts/check-orphan-commits.test.mjs -> scripts/check-orphan-commits.js;
 * scripts/lib/owner-accounts.test.mjs -> vercel.json) that the glob doesn't
 * cover and that has no path entry of its own — same gap, different shape.
 *
 * Non-blocking by design (same rationale as scripts/audit-run-budget-coverage.js):
 * dependency resolution here is regex-based (require()/import/dynamic-import
 * string literals only — no computed paths, no AST, and no transitive
 * chase beyond one hop: if a scripts/lib file's OWN out-of-lib dependency is
 * missing, that's this test's problem to catch, not this audit's), so false
 * negatives are expected and false positives are possible. Needs a period of
 * human-reviewed warnings before it's trustworthy enough to fail CI.
 *
 * Usage:
 *   node scripts/audit-test-yml-lib-deps.js            # human-readable, exit 0 always
 *   node scripts/audit-test-yml-lib-deps.js --json      # JSON output for CI/scripts
 *
 * No external deps (js-yaml is not a direct project dependency — see
 * scripts/audit-workflow-concurrency.js's header for the same convention).
 * The push-paths list is extracted with an indentation-aware line scan, not a
 * raw substring search of the whole file — a substring search would false-
 * negative the moment ANY comment in the file happens to mention a missing
 * dependency's filename (e.g. this very audit's own explanatory comments).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'scripts', 'lib');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'test.yml');

// readPushPaths/globToRegExp/isCovered now live in scripts/lib/test-yml-push-paths.js
// so this audit and scripts/audit-test-yml-manifest-paths.js share ONE definition
// of "would a solo push touching this file trigger CI?" — a second copy is how a
// fix lands in one audit and silently misses the other (CLAUDE.md §15). Still
// re-exported below: this module's public surface is unchanged.
const { readPushPaths, isCovered } = require('./lib/test-yml-push-paths.js');

// Whitespace-tolerant on purpose. The original `require\(['"]...` form missed
// the multi-line shape prettier produces for a long destructure, e.g.
// tests/unit/assert-broadcast-step-order.test.mjs:25:
//     const { a, b, c } = require(
//       '../../scripts/assert-broadcast-step-order.js',
//     );
// which silently dropped that dependency from both audits (BRO-3202).
const REQUIRE_RE = /require\s*\(\s*['"](\.[^'"]+)['"]/g;
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
const RESOLVE_CANDIDATES = ['', '.js', '.mjs', '.cjs', '.json', '/index.js'];

/** Pure: every relative require()/import specifier in a source file, as a Set.
 * Single definition shared by this audit and
 * audit-toplevel-script-test-yml-coverage.js — two copies of these regexes is
 * exactly how the multi-line blind spot above would come back. Returns a fresh
 * Set per call, so the /g regexes' lastIndex is never observed by a caller. */
function relativeSpecifiers(src) {
  const deps = new Set();
  let m;
  REQUIRE_RE.lastIndex = 0;
  IMPORT_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(src))) deps.add(m[1]);
  while ((m = IMPORT_RE.exec(src))) deps.add(m[1]);
  return deps;
}

/** Resolve a relative require()/import specifier to an on-disk path, trying
 * the extensions Node's own resolver would (bare, .js, .mjs, .cjs, .json,
 * dir/index.js) instead of assuming .js. Returns null if nothing exists. */
function resolveDepPath(fromDir, relPath) {
  const base = path.normalize(path.join(fromDir, relPath));
  for (const suffix of RESOLVE_CANDIDATES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function findGaps() {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const pathEntries = readPushPaths(yml);
  const testFiles = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.test.mjs'));
  const gaps = [];

  for (const testFile of testFiles) {
    const testPath = path.join(LIB_DIR, testFile);
    const src = fs.readFileSync(testPath, 'utf8');

    for (const rel of relativeSpecifiers(src)) {
      const abs = resolveDepPath(LIB_DIR, rel);
      if (!abs) continue; // not a local file on disk (e.g. a package import, or unresolvable)
      if (abs.startsWith(LIB_DIR + path.sep)) continue; // covered by scripts/lib/**
      const repoRel = path.relative(ROOT, abs);
      if (!isCovered(repoRel, pathEntries)) {
        gaps.push({ test: path.relative(ROOT, testPath), dep: repoRel });
      }
    }
  }
  return gaps;
}

function main() {
  const gaps = findGaps();
  const asJson = process.argv.includes('--json');

  if (asJson) {
    console.log(JSON.stringify({ gaps }, null, 2));
  } else if (gaps.length === 0) {
    console.log('audit-test-yml-lib-deps: no gaps found — every scripts/lib test dependency outside scripts/lib/ is path-listed.');
  } else {
    console.log(`::warning::audit-test-yml-lib-deps: ${gaps.length} scripts/lib test(s) depend on a file outside scripts/lib/ that is NOT in test.yml's on.push.paths allow-list (a solo push touching only that file triggers zero CI):`);
    for (const g of gaps) {
      console.log(`  ${g.test} -> ${g.dep}`);
    }
    console.log('Add the missing dep path(s) to on.push.paths in .github/workflows/test.yml.');
  }
  process.exit(0); // advisory — never fails CI (see file header)
}

module.exports = { readPushPaths, isCovered, resolveDepPath, relativeSpecifiers, findGaps };

if (require.main === module) main();
