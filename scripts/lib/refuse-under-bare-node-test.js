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
 * It exits 0 (the runner reports the file as passing with no tests) when
 * ALL hold:
 *   1. the entry file (argv[1]) is not a *.test.{js,mjs,cjs,ts,mts,cts} file;
 *   2. this process looks like a runner child: --test-isolation=process or
 *      --test in execArgv (Node >= 22.8 runner children), or NODE_TEST_CONTEXT
 *      set (older Node, and anything a test file spawns);
 *   3. the parent command line has a bare `--test` flag (so the parent is the
 *      runner, not a `node x.test.mjs` that spawned this script) and does NOT
 *      name this file. `node --test scripts/x-test.js` names it: the caller
 *      asked for it, so it runs and its exit code counts (no false green for
 *      the custom-runner self-tests). Only discovery by glob is refused.
 * If the parent command line cannot be read, condition 3 counts as met
 * (fail safe: refuse rather than run live work).
 * A script spawned BY a test file or run directly (`node scripts/x-test.js`)
 * is unaffected.
 *
 * Not covered: `node --test --test-isolation=none`, which imports every file
 * into the runner process itself (opt-in flag, not the bare default).
 *
 * Class guard: scripts/lib/bare-node-test-guard.test.mjs fails when a tracked
 * file matched by node's default globs neither loads this module first nor is
 * allowlisted there.
 */

const fs = require('fs');
const path = require('path');

const { TEST_FILE_RE } = require('./test-run-guard');
const BARE_TEST_FLAG_RE = /(^|\s)--test(\s|=|$)/;

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

function namesEntry(parent, entry, cwd) {
  let real;
  try {
    real = fs.realpathSync(entry);
  } catch {
    real = path.resolve(cwd, entry);
  }
  return parent.split(/\s+/).some((tok) => {
    if (!tok || tok.startsWith('-')) return false;
    try {
      return fs.realpathSync(path.resolve(cwd, tok)) === real;
    } catch {
      return false;
    }
  });
}

/**
 * Pure decision (getParentArgs and cwd injected for tests).
 */
function shouldRefuse({ execArgv, env, argv, getParentArgs, cwd = process.cwd() }) {
  const entryPath = String((argv && argv[1]) || '');
  const entry = path.basename(entryPath);
  if (!entry || TEST_FILE_RE.test(entry)) return false;
  if (!execArgvIsRunnerChild(execArgv) && !(env && env.NODE_TEST_CONTEXT)) return false;
  const parent = typeof getParentArgs === 'function' ? getParentArgs() || '' : '';
  if (!parent) return true;
  if (!BARE_TEST_FLAG_RE.test(parent)) return false;
  return !namesEntry(parent, entryPath, cwd);
}

if (
  shouldRefuse({
    execArgv: process.execArgv,
    env: process.env,
    argv: process.argv,
    getParentArgs: () => parentArgs(process.ppid),
  })
) {
  const rel = path.relative(process.cwd(), String(process.argv[1]));
  process.stdout.write(
    `# skipped ${rel}: not a *.test.* file, refusing to run it from node --test's ` +
      `file discovery (BRO-7984). Run it directly: node ${rel}\n`,
  );
  process.exit(0);
}

module.exports = { shouldRefuse, execArgvIsRunnerChild, TEST_FILE_RE };
