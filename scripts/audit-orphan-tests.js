#!/usr/bin/env node
/**
 * audit-orphan-tests.js — find *.test.mjs/ts/js files not referenced in any
 * .github/workflows/*.yml. Wired into test.yml's lint-workflows job so a forgotten
 * registration blocks the PR instead of silently going un-tested.
 *
 * Scans BOTH tests/unit/ AND the top level of scripts/ (a test placed directly in
 * scripts/ — not scripts/lib/, which runs via its own glob step — otherwise falls
 * in a gap: no glob covers it and the old audit never looked there, so it ran
 * locally but never in CI. Hit 2026-07-12 with notion-tasks-sync/bsc-next tests.)
 *
 * Notion 362637c5-416f-81f4 — discovered 59 orphans (33% of the suite) during the
 * Stuart King Fixes v2 session. The orphan that triggered the audit (bulk-import-
 * summary.test.mjs) had shipped 2 weeks earlier without being registered, so
 * regressions in its surface area went uncaught.
 *
 * Usage:
 *   node scripts/audit-orphan-tests.js            # exits 1 with a list if orphans found
 *   node scripts/audit-orphan-tests.js --json     # JSON output for CI/scripts
 *
 * Exempt: files matching tests/unit/_skip-*.test.mjs (intentionally unregistered,
 * e.g., network-dependent tests that can't run in CI).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests', 'unit');
const SCRIPTS_DIR = path.join(ROOT, 'scripts'); // top level only; scripts/lib/ runs via its own glob
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

// Known-broken tests that need investigation before they can be wired into CI.
// Each entry MUST have a Notion card so the exemption can be unwound. Audit will
// list these in --json output as `exemptKnownBroken` so the existence is visible
// but doesn't fail CI.
const EXEMPT_KNOWN_BROKEN = {
  // NOT broken — a deferred-effect acceptance probe (task #695, card
  // 3ae637c5-416f-81bb): asserts a 7-day provider-spend streak, EXPECTED to
  // fail until the ledger accumulates history. Run by
  // autonomous-acceptance-recheck.js at its RECHECK-AFTER date, never by CI.
  'verify-provider-spend-streak.test.mjs': '3ae637c5-416f-81bb',
  // 1/5 tests fails on assertion: 'ok' !== 'warning' — behavior drift in the
  // underlying bww-rr check. Either the test expectation is stale or the check
  // regressed. 4/5 pass.
  'opening-night-checks-bww-rr.test.mjs': '363637c5-416f-814f',
  // 1/2 tests fails because the CLI prints "Fetching: ..." to stdout in --json
  // mode, breaking JSON.parse. Either CLI should silence stdout in --json mode,
  // or test should parse last line / strip preamble.
  'opening-night-checklist-cli.test.mjs': '363637c5-416f-814f',
  // (opening-night-checks-skeleton.test.mjs removed 2026-05-16 — it actually passes
  // given a 30s per-test budget; the original "TIMEOUT" report was from a 30s
  // wall-clock kill across 3 sequential tests. Now registered in test.yml's main
  // runner. Decayed-exemption gate caught this.)
  //
  // 1 assertion failure at line 120: "long-biographical + 550 words (bughouse-class)
  // + opinion → defer (true)" expects true, gets false. Added by another session
  // while the orphan audit P1 was in flight. Needs investigation: either the heuristic
  // changed and the test is stale, or there's a real regression in the defer logic.
  'should-defer-cv-wrong-show.test.mjs': '363637c5-416f-814f',
};

// .mjs is the canonical extension but .test.ts and .test.js exist too — must
// audit all three or the gate has the same hole it was built to close. Claude
// caught this during ship-check: 6 .ts/.js orphans were silently uncovered.
const TEST_FILE_REGEX = /\.test\.(mjs|ts|js)$/;
const REFERENCE_REGEX = /[a-zA-Z0-9_-]+\.test\.(mjs|ts|js)/g;

// Returns { name, rel } for each test file: name is the bare filename (used for
// the reference/exempt lookups, matching how they're cited in YAML), rel is the
// repo-relative path (used in messages). readdirSync is non-recursive, so the
// scripts/ scan sees top-level files only — scripts/lib/ is excluded by design.
function listTestFiles() {
  const fromDir = (dir, prefix) => fs.readdirSync(dir)
    .filter(f => TEST_FILE_REGEX.test(f))
    .filter(f => !f.startsWith('_skip-'))     // explicit opt-out prefix
    .map(f => ({ name: f, rel: `${prefix}/${f}` }));
  return [...fromDir(TESTS_DIR, 'tests/unit'), ...fromDir(SCRIPTS_DIR, 'scripts')]
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

function collectReferencedTests() {
  const referenced = new Set();
  for (const file of fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.yml'))) {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
    for (const match of content.matchAll(REFERENCE_REGEX)) referenced.add(match[0]);
  }
  return referenced;
}

function main() {
  // --list-exempt prints exempt file names one per line, for use by the
  // decayed-exemption check in CI (`for f in $(...); run; if pass: fail`).
  if (process.argv.includes('--list-exempt')) {
    for (const f of Object.keys(EXEMPT_KNOWN_BROKEN)) console.log(f);
    process.exit(0);
  }
  const json = process.argv.includes('--json');
  const files = listTestFiles();
  const referenced = collectReferencedTests();
  const rawOrphans = files.filter(f => !referenced.has(f.name));
  const orphans = rawOrphans.filter(f => !(f.name in EXEMPT_KNOWN_BROKEN));
  const exemptKnownBroken = rawOrphans
    .filter(f => f.name in EXEMPT_KNOWN_BROKEN)
    .map(f => ({ file: f.rel, notion: EXEMPT_KNOWN_BROKEN[f.name] }));

  if (json) {
    console.log(JSON.stringify({
      total: files.length,
      registered: files.length - rawOrphans.length,
      orphans: orphans.map(f => f.rel),
      exemptKnownBroken,
    }, null, 2));
  } else if (orphans.length > 0) {
    console.error(`❌ ${orphans.length} orphan test file(s) — not referenced in any .github/workflows/*.yml:`);
    for (const f of orphans) console.error(`  ${f.rel}`);
    console.error('');
    console.error('Fix: add the file to the appropriate `node --test ...` line in .github/workflows/test.yml.');
    console.error('Opt-out (known-broken): add to EXEMPT_KNOWN_BROKEN in scripts/audit-orphan-tests.js with a Notion card.');
    console.error('Opt-out (intentional): rename to `_skip-${name}.test.mjs`.');
  } else {
    console.log(`✅ All ${files.length} unit test files registered in CI (${exemptKnownBroken.length} known-broken exempt)`);
  }
  process.exit(orphans.length > 0 ? 1 : 0);
}

main();
