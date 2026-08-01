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
// Deliberately never run by CI, and NOT expected to stay failing — so the
// decayed-exemption gate must never evaluate these. A deferred-effect
// acceptance probe passes the day its condition finally comes true; flagging
// that as "decay" would turn a success into a red main. Keep this map tiny and
// only for tests whose correct home is a scheduled recheck, not the test suite.
const EXEMPT_NEVER_CI = {
  // Deferred-effect acceptance probe (task #695, card 3ae637c5-416f-81bb):
  // asserts a 7-day provider-spend streak, EXPECTED to fail until the ledger
  // accumulates history. Run by autonomous-acceptance-recheck.js at its
  // RECHECK-AFTER date, never by CI. Lives in scripts/, not tests/unit/.
  'verify-provider-spend-streak.test.mjs': '3ae637c5-416f-81bb',
};

const EXEMPT_KNOWN_BROKEN = {
  // (opening-night-checks-bww-rr.test.mjs removed 2026-08-01 — it was never
  // "behavior drift". Its no-bwwRoundupUrl case asserted the branch the check
  // takes when Browserbase is UNCONFIGURED, then inherited the ambient env: it
  // passed in CI's secret-less lint job and failed on any machine with a .env.
  // The test now scrubs BROWSERBASE_* itself and is registered in test.yml.
  // Surfaced when this gate ran for the first time ever — see the note on the
  // decayed-exemption step in test.yml.)
  //
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
  // --list-exempt prints REPO-RELATIVE PATHS of decay candidates, one per line,
  // for the decayed-exemption check in CI (`for f in $(...); run; if pass: fail`).
  //
  // Paths, not bare names: CI used to prepend `tests/unit/`, so any exempt test
  // living in scripts/ resolved to a nonexistent file, `node --test` exited 1,
  // and the gate scored it "still failing" forever — it could never detect that
  // one had decayed. Resolving through listTestFiles() means the gate always
  // runs the file that actually exists.
  //
  // EXEMPT_NEVER_CI is excluded by construction: those are expected to start
  // passing, and their passing is not decay.
  if (process.argv.includes('--list-exempt')) {
    const byName = new Map(listTestFiles().map(f => [f.name, f.rel]));
    for (const name of Object.keys(EXEMPT_KNOWN_BROKEN)) {
      const rel = byName.get(name);
      // A missing file means the exemption outlived the test — surface it
      // rather than silently emitting a path that can't run.
      if (!rel) {
        console.error(`::warning::EXEMPT_KNOWN_BROKEN lists ${name} but no such test file exists — stale entry`);
        continue;
      }
      console.log(rel);
    }
    process.exit(0);
  }
  const json = process.argv.includes('--json');
  const files = listTestFiles();
  const referenced = collectReferencedTests();
  const rawOrphans = files.filter(f => !referenced.has(f.name));
  const isExempt = f => (f.name in EXEMPT_KNOWN_BROKEN) || (f.name in EXEMPT_NEVER_CI);
  const orphans = rawOrphans.filter(f => !isExempt(f));
  const exemptKnownBroken = rawOrphans
    .filter(f => f.name in EXEMPT_KNOWN_BROKEN)
    .map(f => ({ file: f.rel, notion: EXEMPT_KNOWN_BROKEN[f.name] }));
  const exemptNeverCi = rawOrphans
    .filter(f => f.name in EXEMPT_NEVER_CI)
    .map(f => ({ file: f.rel, notion: EXEMPT_NEVER_CI[f.name] }));

  if (json) {
    console.log(JSON.stringify({
      total: files.length,
      registered: files.length - rawOrphans.length,
      orphans: orphans.map(f => f.rel),
      exemptKnownBroken,
      exemptNeverCi,
    }, null, 2));
  } else if (orphans.length > 0) {
    console.error(`❌ ${orphans.length} orphan test file(s) — not referenced in any .github/workflows/*.yml:`);
    for (const f of orphans) console.error(`  ${f.rel}`);
    console.error('');
    console.error('Fix: add the file to the appropriate `node --test ...` line in .github/workflows/test.yml.');
    console.error('Opt-out (known-broken): add to EXEMPT_KNOWN_BROKEN in scripts/audit-orphan-tests.js with a Notion card.');
    console.error('Opt-out (intentional): rename to `_skip-${name}.test.mjs`.');
  } else {
    console.log(`✅ All ${files.length} unit test files registered in CI (${exemptKnownBroken.length} known-broken exempt, ${exemptNeverCi.length} never-CI exempt)`);
  }
  process.exit(orphans.length > 0 ? 1 : 0);
}

main();
