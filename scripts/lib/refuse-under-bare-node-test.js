'use strict';

/**
 * BRO-7984: early-exit guard for live scripts whose filename matches node's
 * default `node --test` globs (test-*.js, *-test.js, *-test.mjs, test.js,
 * **\/test\/**) but which are NOT *.test.* files. A bare `node --test` at the
 * repo root runs every such file as a "test": sd-parity-test.js scraped live
 * and overwrote tracked data/audit, send-test.mjs could send real email.
 *
 * Require/import this FIRST in such a file. Under `node --test` (NODE_TEST_CONTEXT
 * set) with a non-*.test.* entry file it prints a message and exits 0.
 * Direct runs (`node scripts/sd-parity-test.js`) are unaffected. Explicit
 * override: BSC_ALLOW_LIVE_TEST=1.
 */

const path = require('path');

function shouldRefuse(env = process.env, argv = process.argv) {
  if (!env.NODE_TEST_CONTEXT || env.BSC_ALLOW_LIVE_TEST === '1') return false;
  const base = path.basename(String((argv && argv[1]) || ''));
  return !/\.test\.[cm]?[jt]s$/.test(base);
}

if (shouldRefuse()) {
  console.log(`[BRO-7984] ${path.basename(process.argv[1])} is a live script, not a unit test; skipping under node --test (set BSC_ALLOW_LIVE_TEST=1 to force).`);
  process.exit(0);
}

module.exports = { shouldRefuse };
