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
 *   <changed-files> | node scripts/audit-orphan-tests.js --scope-stdin
 *                                                  # (card #1488) only orphans whose repo-
 *                                                  # relative path is in the piped newline-
 *                                                  # separated list are blocking; other
 *                                                  # pre-existing orphans print as
 *                                                  # informational and don't fail the run.
 *                                                  # Used by scripts/lib/run-push-audits.sh
 *                                                  # so an unrelated push isn't blocked by
 *                                                  # someone else's unregistered test. CI's
 *                                                  # direct calls in test.yml never pass this
 *                                                  # flag, so the full-repo check there is
 *                                                  # unchanged.
 *
 * Exempt: files matching tests/unit/_skip-*.test.mjs (intentionally unregistered,
 * e.g., network-dependent tests that can't run in CI).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { decideOrphanGate } = require('./lib/orphan-test-gate.js');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests', 'unit');
const SCRIPTS_DIR = path.join(ROOT, 'scripts'); // top level only; scripts/lib/ runs via its own glob
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
// test.yml's main runner reads file lists from these manifests (task #763 —
// replaced a single 15,987-char inline `node --test <368 files>` line, which
// guaranteed a merge conflict on every concurrent test addition) instead of
// listing test filenames inline. A registration now lives in the manifest,
// not literally inside test.yml, so it must be scanned too or every
// manifest-registered test reads as an orphan.
const MANIFEST_FILES = [
  path.join(ROOT, 'tests', 'unit-test-manifest.txt'),
  path.join(ROOT, 'tests', 'unit-test-manifest-tsx.txt'),
  path.join(ROOT, 'tests', 'e2e-unit-test-manifest.txt'),
];

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
  // Deferred-effect acceptance probe (task #419, card 3a7637c5-416f-81fd):
  // asserts the "SEO: health" digest condition doesn't fire on the next
  // weekly check-seo-health.yml run. Run by autonomous-acceptance-recheck.js
  // at its RECHECK-AFTER date, never by CI. Lives in scripts/, not
  // tests/unit/ (same pattern as the entry above).
  'verify-seo-health-clean.test.mjs': '3a7637c5-416f-81fd',
  // Deferred-effect acceptance probe (task #1466, card 3bc637c5-416f-8118):
  // asserts promote-we-aggregator.yml's daily cron produced a real
  // we-promotion-log.jsonl entry after the feature merged 2026-08-14.
  // RECHECK-AFTER 2026-08-16. This file was left off the manifest by the
  // merging session (#1478 ship-check found it as an orphan-tests block
  // when merging unrelated work) — same fix as the two entries above:
  // exempt from CI, let autonomous-acceptance-recheck.js pick it up.
  'verify-we-aggregator-promotion-ran.test.mjs': '3bc637c5-416f-8118',
  // Deferred-effect acceptance probe (card 3bd637c5-416f-81ed): asserts main's
  // test.yml has HELD green for 24h after the 2026-08-14 recovery from an
  // 89-failure red streak, reading the committed trunk snapshot (the recheck's
  // sandbox has no gh auth). RECHECK-AFTER 2026-08-15. Run by
  // autonomous-acceptance-recheck.js at its stamp date, never by CI — a probe
  // that is EXPECTED to report "not yet 24h" on its first evaluation must
  // never be able to redden the very trunk it is measuring. Lives in scripts/,
  // not tests/unit/ (same pattern as the three entries above).
  'verify-main-green-streak.test.mjs': '3bd637c5-416f-81ed',
};

const EXEMPT_KNOWN_BROKEN = {
  // (headless-prompt-no-owner-handoff.test.mjs removed 2026-08-02 — the task
  // #757 exemption above was explicitly conditional on "register in test.yml
  // when its guard lib passes". The guard shipped, all 10 cases pass, and the
  // test is now in the tests/unit node --test list, so the exemption decayed
  // the moment it was registered and the decayed-exemption gate demanded it go.)

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
  for (const manifestPath of MANIFEST_FILES) {
    if (!fs.existsSync(manifestPath)) continue;
    const content = fs.readFileSync(manifestPath, 'utf8');
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
  // --scope-stdin (card #1488): read repo-relative paths from a newline-
  // separated stdin stream and only treat orphans within that scope as
  // blocking. Absent this flag, scope is undefined and every orphan blocks —
  // byte-for-byte the pre-#1488 behavior, which is what CI's direct calls in
  // test.yml still get (they never pass this flag).
  const scopeStdin = process.argv.includes('--scope-stdin');
  const scope = scopeStdin
    ? fs.readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    : undefined;
  // Known accepted tradeoff (raised in review — Codex): a push that edits
  // test.yml/a manifest to REMOVE a test's registration, without touching
  // that test file's own content, downgrades the newly-orphaned test to
  // informational here instead of blocking. Making test.yml's mere presence
  // in scope fall back to full blocking was tried and reverted — it defeats
  // the fix's actual purpose, since test.yml touched for an UNRELATED reason
  // is exactly the #483/#1478 trigger this card exists to stop blocking.
  // There's no cheap way to tell "this push removed a registration line"
  // apart from "this push touched test.yml for any other reason" without a
  // content diff, so this stays a real, informational-only gap covered by
  // CI's unscoped full check as the safety net (test.yml:2566/2600).
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
  const { blocking, informational } = decideOrphanGate({ orphans, changedFiles: scope });

  if (json) {
    console.log(JSON.stringify({
      total: files.length,
      registered: files.length - rawOrphans.length,
      orphans: orphans.map(f => f.rel),
      blocking: blocking.map(f => f.rel),
      informational: informational.map(f => f.rel),
      exemptKnownBroken,
      exemptNeverCi,
    }, null, 2));
  } else if (blocking.length > 0) {
    console.error(`❌ ${blocking.length} orphan test file(s) — not referenced in any .github/workflows/*.yml:`);
    for (const f of blocking) console.error(`  ${f.rel}`);
    if (informational.length > 0) {
      console.error('');
      console.error(`(${informational.length} more pre-existing orphan(s) elsewhere in the repo, not touched by this push — not blocking:)`);
      for (const f of informational) console.error(`  ${f.rel}`);
    }
    console.error('');
    console.error('Fix: add the file to the appropriate `node --test ...` line in .github/workflows/test.yml.');
    console.error('Opt-out (known-broken): add to EXEMPT_KNOWN_BROKEN in scripts/audit-orphan-tests.js with a Notion card.');
    console.error('Opt-out (intentional): rename to `_skip-${name}.test.mjs`.');
  } else if (informational.length > 0) {
    console.log(`✅ ${files.length - informational.length} of ${files.length} unit test files registered in CI — ${informational.length} pre-existing orphan(s) elsewhere in the repo not touched by this push (not blocking):`);
    for (const f of informational) console.log(`  ${f.rel}`);
  } else {
    console.log(`✅ All ${files.length} unit test files registered in CI (${exemptKnownBroken.length} known-broken exempt, ${exemptNeverCi.length} never-CI exempt)`);
  }
  process.exit(blocking.length > 0 ? 1 : 0);
}

main();
