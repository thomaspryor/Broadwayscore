#!/usr/bin/env node
/**
 * BLOCKING gate: every test file registered in a unit-test manifest must also be
 * reachable by test.yml's `on.push.paths` allow-list.
 *
 * THE GAP THIS CLOSES. Two independent lists decide a test's fate:
 *   - tests/unit-test-manifest*.txt decides whether the test RUNS once CI fires.
 *   - test.yml's on.push.paths decides whether CI fires AT ALL.
 * A test in the first but not the second is the worst of both worlds: it looks
 * fully wired, it passes in every run you happen to see, and a push that edits
 * only that file (or only the code it is the sole test for) triggers ZERO CI.
 * The test still runs later, on someone else's unrelated push, which is how a
 * regression gets attributed to the wrong commit.
 *
 * This has recurred at least four times (memory/feedback_test_yml_push_path_allowlist.md,
 * tasks #1737 and #1745, BRO-2603). Task #1745 closed the biggest instance by
 * replacing ~200 hand-listed scripts/lib entries with a single `scripts/lib/**`
 * glob. scripts/audit-test-yml-lib-deps.js then closed the "a scripts/lib test
 * requires something OUTSIDE the glob" shape. This closes the last shape: a
 * manifest-registered test that lives outside every glob and was never given a
 * path entry of its own. It was found with 18 live instances, one of which
 * (scripts/send-opening-night-broadcast.test.mjs) is the only test for the
 * email-broadcast safety rules in CLAUDE.md §17.
 *
 * WHY THIS ONE BLOCKS while audit-test-yml-lib-deps.js only warns: that audit
 * resolves require()/import specifiers with regex and can produce false
 * positives. This one compares two literal lists — a manifest line and a glob
 * from the same repo. There is nothing to guess, so a finding is always real,
 * and the fix is always one line.
 *
 * Usage:
 *   node scripts/audit-test-yml-manifest-paths.js            # human-readable
 *   node scripts/audit-test-yml-manifest-paths.js --json     # machine-readable
 *   node scripts/audit-test-yml-manifest-paths.js --root=DIR # audit another tree
 * Exit 0 = no gaps, 1 = gaps found (or the workflow/manifests are unreadable).
 *
 * --root exists so the colocated test can drive the REAL binary against a
 * fixture tree that HAS a gap. Without it the failure path could only ever be
 * asserted by reading the source, and a gate whose failure path is never
 * executed is a gate you are trusting on faith.
 *
 * No external deps (js-yaml is not a direct project dependency — same
 * convention as scripts/audit-workflow-concurrency.js).
 */
'use strict';

const path = require('path');
const {
  findManifestPathGaps,
  findUnregisteredTests,
  MANIFEST_FILES,
  SCANNED_TEST_DIRS,
  WORKFLOW_REL,
} = require('./lib/test-yml-manifest-paths.js');

const ROOT = path.resolve(__dirname, '..');

function main() {
  const asJson = process.argv.includes('--json');
  const rootArg = process.argv.find((a) => a.startsWith('--root='));
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : ROOT;
  let gaps;
  let unregistered;
  try {
    gaps = findManifestPathGaps(root);
    unregistered = findUnregisteredTests(root);
  } catch (e) {
    // Fail CLOSED: this gate is exact, so an unreadable input is a real problem
    // (a renamed manifest, a restructured test.yml) and must not pass silently.
    console.error(`audit-test-yml-manifest-paths: could not run — ${e.message}`);
    process.exit(1);
    return;
  }

  if (asJson) {
    console.log(JSON.stringify({ gaps, unregistered }, null, 2));
  } else if (gaps.length === 0) {
    console.log(
      `audit-test-yml-manifest-paths: no gaps — every test in ${MANIFEST_FILES.join(' + ')} is reachable by test.yml's on.push.paths.`
    );
  } else {
    console.error(
      `::error::audit-test-yml-manifest-paths: ${gaps.length} manifest-registered test(s) are NOT covered by test.yml's on.push.paths. ` +
        'Each one RUNS in CI but a push touching only it triggers zero CI:'
    );
    for (const g of gaps) console.error(`  ${g.test}   (registered in ${g.manifest})`);
    console.error("\nFix: add each path to on.push.paths in .github/workflows/test.yml, e.g.\n  - '" + gaps[0].test + "'");
  }

  // The mirror-image check: a test file no manifest registers never runs in CI
  // at all. Reported even in --json mode's absence so the human form carries it
  // too; the exit code below folds both findings together.
  if (!asJson) {
    for (const q of unregistered.quarantined) {
      console.log(`audit-test-yml-manifest-paths: quarantined (knowingly unregistered) — ${q.test}\n    ${q.reason}`);
    }
    for (const t of unregistered.staleQuarantine) {
      console.log(
        `audit-test-yml-manifest-paths: stale quarantine entry — ${t} is now registered or gone; drop it from UNREGISTERED_TEST_QUARANTINE.`
      );
    }
    for (const t of unregistered.brokenExemptions) {
      console.error(
        `::error::audit-test-yml-manifest-paths: ${t} is exempted on the grounds that it runs at its own ` +
          `${WORKFLOW_REL} step, but no step in that file mentions it any more. It is now registered nowhere ` +
          'and runs NOWHERE. Restore the step, or register it in a manifest, or replace the quarantine reason.'
      );
    }
    if (unregistered.orphans.length === 0 && unregistered.brokenExemptions.length === 0) {
      // Never claim "every test file is registered" while a quarantine exists —
      // that sentence is literally false and is what makes a log skimmable past
      // the exemptions (Codex adversarial review, 2026-09-04).
      const q = unregistered.quarantined.length;
      console.log(
        `audit-test-yml-manifest-paths: no orphans — every test file under ${SCANNED_TEST_DIRS.join(', ')} is ` +
          `registered in a manifest${q ? `, or is one of the ${q} explicitly quarantined above` : ''}.`
      );
    } else if (unregistered.orphans.length > 0) {
      console.error(
        `::error::audit-test-yml-manifest-paths: ${unregistered.orphans.length} test file(s) under ${SCANNED_TEST_DIRS.join(', ')} are in NO manifest, so ` +
          'test.yml:3575 never runs them — in any run, on any push:'
      );
      for (const t of unregistered.orphans) console.error(`  ${t}`);
      console.error(
        `\nFix: add each to ${MANIFEST_FILES[0]} (or the tsx/e2e manifest if that is where it belongs). ` +
          'If it genuinely must not run in CI, add it to UNREGISTERED_TEST_QUARANTINE in ' +
          'scripts/lib/test-yml-manifest-paths.js with the issue that will end the exemption.'
      );
    }
  }

  process.exit(
    gaps.length === 0 && unregistered.orphans.length === 0 && unregistered.brokenExemptions.length === 0 ? 0 : 1
  );
}

if (require.main === module) main();
