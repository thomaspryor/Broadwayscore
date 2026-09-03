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
const { findManifestPathGaps, MANIFEST_FILES } = require('./lib/test-yml-manifest-paths.js');

const ROOT = path.resolve(__dirname, '..');

function main() {
  const asJson = process.argv.includes('--json');
  const rootArg = process.argv.find((a) => a.startsWith('--root='));
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : ROOT;
  let gaps;
  try {
    gaps = findManifestPathGaps(root);
  } catch (e) {
    // Fail CLOSED: this gate is exact, so an unreadable input is a real problem
    // (a renamed manifest, a restructured test.yml) and must not pass silently.
    console.error(`audit-test-yml-manifest-paths: could not run — ${e.message}`);
    process.exit(1);
    return;
  }

  if (asJson) {
    console.log(JSON.stringify({ gaps }, null, 2));
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
  process.exit(gaps.length === 0 ? 0 : 1);
}

if (require.main === module) main();
