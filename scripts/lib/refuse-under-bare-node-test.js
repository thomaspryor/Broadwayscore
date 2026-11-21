'use strict';

/**
 * refuse-under-bare-node-test.js — stop a live script from running when the
 * `node --test` runner picked it up by file name (BRO-7984).
 *
 * `node --test` with no file arguments (e.g. an empty shell variable) falls
 * back to its default discovery globs: *.test.*, *-test.*, *_test.*, test-*.*,
 * test.* and test/**. In this repo that matches ~70 scripts that are NOT
 * node:test files: production runners named *-test.js (sd-parity-test.js made
 * live ScrapingBee/Bright Data calls and overwrote data/audit/sd-parity-2026-08.json
 * on 2026-11-21) and scripts/test-*.js runners, some of which send email or
 * call paid APIs.
 *
 * Usage: make it the FIRST require/import of the script, so it runs before
 * any other module does work at load time:
 *   CJS:  require('./lib/refuse-under-bare-node-test');
 *   ESM:  import './lib/refuse-under-bare-node-test.js';
 *
 * It exits 0 (the runner reports the file as passing with no tests) only when
 * BOTH hold:
 *   1. this process is a file the test runner itself spawned: node passes
 *      --test-isolation=process (Node >= 22.8) in that child's execArgv; on
 *      older Node, NODE_TEST_CONTEXT is set and the parent command line has a
 *      bare `--test` flag;
 *   2. the entry file (argv[1]) is not a *.test.{js,mjs,cjs,ts,mts,cts} file.
 * A script spawned BY a test file (parent is `node x.test.mjs`, execArgv
 * empty) or run directly (`node scripts/sd-parity-test.js`) is unaffected.
 *
 * Not covered: `node --test --test-isolation=none`, which imports every file
 * into the runner process itself (opt-in flag, not the bare default).
 *
 * Class guard: scripts/lib/bare-node-test-guard.test.mjs fails when a tracked
 * file matched by node's default globs neither loads this module first nor is
 * allowlisted there.
 */

const path = require('path');

const TEST_FILE_RE = /\.test\.[cm]?[jt]s$/;
const BARE_TEST_FLAG_RE = /(^|\s)--test(\s|$)/;

function execArgvIsRunnerChild(execArgv) {
  return (execArgv || []).some(
    (a) => a === '--test' || /^--(experimental-)?test-isolation=process$/.test(a),
  );
}

function parentArgs(ppid) {
  try {
    return require('child_process')
      .execFileSync('ps', ['-o', 'args=', '-p', String(ppid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      })
      .trim();
  } catch {
    return '';
  }
}

/**
 * Pure decision. `getParentArgs` is only consulted on the old-Node fallback.
 */
function shouldRefuse({ execArgv, env, argv, getParentArgs }) {
  const entry = path.basename(String((argv && argv[1]) || ''));
  if (!entry || TEST_FILE_RE.test(entry)) return false;
  if (execArgvIsRunnerChild(execArgv)) return true;
  if (env && env.NODE_TEST_CONTEXT && typeof getParentArgs === 'function') {
    return BARE_TEST_FLAG_RE.test(getParentArgs() || '');
  }
  return false;
}

if (
  !process.env.BSC_ALLOW_UNDER_NODE_TEST &&
  shouldRefuse({
    execArgv: process.execArgv,
    env: process.env,
    argv: process.argv,
    getParentArgs: () => parentArgs(process.ppid),
  })
) {
  const rel = path.relative(process.cwd(), String(process.argv[1]));
  process.stdout.write(
    `# skipped ${rel}: not a *.test.* file, refusing to run under node --test ` +
      `(BRO-7984). Run it directly: node ${rel}\n`,
  );
  process.exit(0);
}

module.exports = { shouldRefuse, execArgvIsRunnerChild, TEST_FILE_RE };
