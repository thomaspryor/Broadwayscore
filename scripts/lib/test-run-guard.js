'use strict';

/**
 * Is this process a test run? Ledger sinks ask before defaulting to a real,
 * committed data/audit file (BRO-2664 class, BRO-5261 retro-review).
 *
 * Every sink used to check NODE_TEST_CONTEXT alone. Node sets it only under
 * `node --test`, so a test file run directly (`node foo.test.mjs`, as several
 * test.yml steps do) wrote production rows: scraper-cookie-wiring appended to
 * scraper-spend-ledger.jsonl, and a crown-launch test wrote a fake 'Crown v45'
 * row to dispatch-ledger.jsonl.
 *
 * True when NODE_TEST_CONTEXT or BSC_TEST_RUN is set, or argv[1] is a
 * *.test.{js,mjs,cjs,ts} file. Loading this module from such a file sets
 * BSC_TEST_RUN=1 so child processes it spawns afterwards (whose argv[1] is a
 * production script) inherit the answer. It never sets NODE_TEST_CONTEXT:
 * that switches node:test into child-protocol output.
 *
 * Not covered: scripts/test-*.js runners, *.test.sh harnesses calling a
 * production script, Playwright. Those still need an explicit path override.
 */

const path = require('path');

const TEST_FILE_RE = /\.test\.[cm]?[jt]s$/;

function argvIsTestFile(argv = process.argv) {
  return TEST_FILE_RE.test(path.basename(String((argv && argv[1]) || '')));
}

function isTestRun(env = process.env, argv = process.argv) {
  return Boolean(env.NODE_TEST_CONTEXT || env.BSC_TEST_RUN) || argvIsTestFile(argv);
}

// Only for a DIRECT run: under `node --test` children already inherit
// NODE_TEST_CONTEXT, and tests that simulate a real run by deleting it from a
// child env must not find a second marker left behind.
if (argvIsTestFile() && !process.env.NODE_TEST_CONTEXT && !process.env.BSC_TEST_RUN) process.env.BSC_TEST_RUN = '1';

module.exports = { isTestRun, argvIsTestFile, TEST_FILE_RE };
