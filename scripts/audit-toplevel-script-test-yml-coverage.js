#!/usr/bin/env node
/**
 * Advisory guard (BRO-172 follow-up): flag top-level scripts/*.js files that
 * (a) are registered in tests/unit-test-manifest.txt or
 * tests/unit-test-manifest-tsx.txt (so CI DOES run their test — this is not
 * about untested scripts, most of the 900+ top-level scripts have no test at
 * all by design) but (b) have no matching entry in test.yml's `on.push.paths`
 * push-trigger allow-list, and so a solo push touching only that script (or
 * its colocated test) triggers ZERO CI even though the test exists and would
 * have caught the bug.
 *
 * Background: scripts/fix-platform-ticket-links.js had a region-mismatch bug
 * (Ticketmaster SERP re-verification silently overwrote a West End show's
 * correct ticketmaster.co.uk link with a wrong US ticketmaster.com page) that
 * regressed shows.json at least 6 times in the private data repo's history
 * before anyone noticed, because the script had no test.yml path entry at
 * all — nothing ever ran its logic on push. scripts/lib/** closed this gap
 * class for scripts/lib/ (task #1745); scripts/audit-test-yml-lib-deps.js and
 * scripts/audit-review-texts-test-yml-coverage.js catch two narrower shapes
 * of it. This is the general top-level-scripts/ version: any script sitting
 * in the manifest (proof a test exists and is meant to run in CI) but missing
 * from the push-path allow-list (proof a push touching it will ever fire).
 *
 * Non-blocking by design (same rationale as the sibling audits above):
 * covers manifest entries directly under scripts/ only (not scripts/lib/,
 * already globbed, and not scripts/tests/ or tests/, both broadly globbed by
 * 'tests/**' — see test.yml line ~9). No dependency-chasing: unlike
 * audit-test-yml-lib-deps.js this doesn't parse require()/import, it just
 * checks whether the manifest entry itself (and its sibling source file) is
 * covered by the allow-list.
 *
 * Usage:
 *   node scripts/audit-toplevel-script-test-yml-coverage.js            # human-readable, exit 0 always
 *   node scripts/audit-toplevel-script-test-yml-coverage.js --json      # JSON output for CI/scripts
 */
'use strict';

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const path = require('path');
const { readPushPaths, isCovered, resolveDepPath, relativeSpecifiers } = require('./audit-test-yml-lib-deps.js');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'test.yml');
const MANIFESTS = [
  path.join(ROOT, 'tests', 'unit-test-manifest.txt'),
  path.join(ROOT, 'tests', 'unit-test-manifest-tsx.txt'),
];

// scripts/*.test.(mjs|ts) directly under scripts/ (not scripts/lib/, not
// scripts/tests/) — those two subdirectories already have their own coverage
// (scripts/lib/** glob; tests/** glob covers scripts/tests/ via its own path).
const TOPLEVEL_TEST_RE = /^scripts\/[^/]+\.test\.(mjs|ts)$/;

// tests/unit/*.test.(mjs|ts) — the SECOND shape (BRO-3202). These test files
// are themselves always covered, because test.yml push-lists 'tests/**'. The
// gap is the other direction: the top-level scripts/ SOURCE the test requires
// is usually not path-listed, so editing the source ALONE triggers zero CI
// while the test that would have caught it sits there un-run. That is the
// dangerous direction — the source is what changes behaviour.
//
// This was hand-listed four times before it was measured (check-orphan-
// commits.js, check-missed-broadcasts.js, freeze-ledgers.js, check-cloud-
// secrets.js, then audit-dependencies.js as #5), and each entry's comment
// notes that no audit catches the shape. Measuring it found 28 uncovered
// sources, so hand-listing was never going to converge. Neither sibling audit
// covers this: audit-test-yml-lib-deps.js walks only scripts/lib/*.test.mjs,
// and the TOPLEVEL_TEST_RE pass above matches only tests that live under
// scripts/ themselves.
const TESTS_DIR_TEST_RE = /^tests\/.+\.test\.(mjs|cjs|js|ts|tsx)$/;

// A dep worth reporting: any scripts/ source file OUTSIDE scripts/lib/ (which
// is already covered by the scripts/lib/** glob). Originally single-segment
// only, which missed scripts/llm-scoring/input-builder.ts — required by three
// manifest-registered tests and absent from on.push.paths (BRO-3202
// ship-check). Subdirectories under scripts/ are not special; they were just
// out of the first version's field of view.
const SOURCE_RE = /^scripts\/(?!lib\/).+\.(js|mjs|cjs|ts|tsx)$/;

/** Pure: filter raw manifest lines down to top-level scripts/*.test.(mjs|ts)
 * entries (excludes scripts/lib/, scripts/tests/, tests/, and blank/comment
 * lines). Exported separately from the disk read so it's unit-testable. */
function filterToplevelTestEntries(lines) {
  return lines.map((l) => l.trim()).filter((t) => t && TOPLEVEL_TEST_RE.test(t));
}

/** Pure: filter raw manifest lines down to tests/**\/*.test.(mjs|ts) entries.
 * Counterpart to filterToplevelTestEntries for the second gap shape. */
function filterTestsDirEntries(lines) {
  return lines.map((l) => l.trim()).filter((t) => t && TESTS_DIR_TEST_RE.test(t));
}

function readManifestLines() {
  const lines = [];
  for (const manifestPath of MANIFESTS) {
    if (!fs.existsSync(manifestPath)) continue;
    lines.push(...fs.readFileSync(manifestPath, 'utf8').split('\n'));
  }
  return lines;
}

function readManifestEntries() {
  return filterToplevelTestEntries(readManifestLines());
}

function readTestsDirEntries() {
  return filterTestsDirEntries(readManifestLines());
}

/** Pure: given a test file's source text and the directory it lives in, return
 * the repo-relative top-level scripts/ files it require()s or imports. Reuses
 * relativeSpecifiers + resolveDepPath from audit-test-yml-lib-deps.js so
 * specifier parsing and extension resolution stay identical across the two
 * audits (a second copy would drift — and the first copy of that regex had a
 * multi-line blind spot, see the comment on REQUIRE_RE there). */
function toplevelScriptDeps(src, fromDir) {
  const out = new Set();
  for (const rel of relativeSpecifiers(src)) {
    const abs = resolveDepPath(fromDir, rel);
    if (!abs) continue; // package import, or nothing on disk
    const repoRel = path.relative(ROOT, abs);
    if (SOURCE_RE.test(repoRel)) out.add(repoRel);
  }
  return Array.from(out).sort();
}

function siblingSourcePath(testRelPath) {
  // scripts/foo.test.mjs -> scripts/foo.js ; scripts/foo.test.ts -> scripts/foo.ts
  const m = testRelPath.match(/^(scripts\/[^/]+)\.test\.(mjs|ts)$/);
  if (!m) return null;
  const [, stem, ext] = m;
  const candidate = ext === 'ts' ? `${stem}.ts` : `${stem}.js`;
  return fs.existsSync(path.join(ROOT, candidate)) ? candidate : null;
}

function findGaps() {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const pathEntries = readPushPaths(yml);
  const gaps = [];

  for (const testRelPath of readManifestEntries()) {
    const testCovered = isCovered(testRelPath, pathEntries);
    const sourceRelPath = siblingSourcePath(testRelPath);
    const sourceCovered = sourceRelPath ? isCovered(sourceRelPath, pathEntries) : true; // no sibling source = nothing more to check

    if (!testCovered || !sourceCovered) {
      gaps.push({
        test: testRelPath,
        testCovered,
        source: sourceRelPath,
        sourceCovered,
        via: 'sibling',
      });
    }
  }

  // Second shape (BRO-3202): manifest-registered tests under tests/ whose
  // required scripts/ source has no push-path entry. The test file is covered
  // by the 'tests/**' glob; the source is the uncovered half.
  //
  // `seen` is seeded from the first loop's gaps so one source can't be reported
  // twice under two different `via` values (ship-check finding).
  const seen = new Set(gaps.map((g) => g.source).filter(Boolean));
  for (const testRelPath of readTestsDirEntries()) {
    const abs = path.join(ROOT, testRelPath);
    if (!fs.existsSync(abs)) continue; // stale manifest row — not this audit's job
    const src = fs.readFileSync(abs, 'utf8');
    for (const sourceRelPath of toplevelScriptDeps(src, path.dirname(abs))) {
      if (isCovered(sourceRelPath, pathEntries)) continue;
      if (seen.has(sourceRelPath)) continue; // report each source once
      seen.add(sourceRelPath);
      gaps.push({
        test: testRelPath,
        testCovered: true, // 'tests/**' glob
        source: sourceRelPath,
        sourceCovered: false,
        via: 'require',
      });
    }
  }

  return gaps;
}

const USAGE = `Usage:
  node scripts/audit-toplevel-script-test-yml-coverage.js            # human-readable, exit 0 always
  node scripts/audit-toplevel-script-test-yml-coverage.js --json      # JSON output for CI/scripts
`;

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const gaps = findGaps();
  const asJson = process.argv.includes('--json');

  if (asJson) {
    console.log(JSON.stringify({ gaps }, null, 2));
  } else if (gaps.length === 0) {
    console.log('audit-toplevel-script-test-yml-coverage: no gaps found — every manifest-registered top-level scripts/*.test file (and its sibling source) is path-listed in test.yml.');
  } else {
    console.log(`::warning::audit-toplevel-script-test-yml-coverage: ${gaps.length} manifest-registered top-level script test(s) are NOT (fully) covered by test.yml's on.push.paths allow-list (a solo push touching only these files triggers zero CI even though a test exists):`);
    for (const g of gaps) {
      const parts = [];
      if (!g.testCovered) parts.push(`test file ${g.test} missing`);
      if (g.source && !g.sourceCovered) parts.push(`source file ${g.source} missing`);
      console.log(`  ${g.test} -> ${parts.join('; ')}`);
    }
    console.log("Add the missing path(s) to on.push.paths in .github/workflows/test.yml.");
  }
  process.exit(0); // advisory — never fails CI (see file header)
}

module.exports = {
  readManifestEntries, filterToplevelTestEntries, siblingSourcePath, findGaps,
  readTestsDirEntries, filterTestsDirEntries, toplevelScriptDeps,
};

if (require.main === module) main();
