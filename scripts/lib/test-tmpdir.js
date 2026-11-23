'use strict';
/**
 * BRO-8179: temp dirs for tests that clean themselves up.
 *
 * 1155 test files call mkdtemp; 360 never remove what they make, and the land
 * floor runs them thousands of times a day, so /private/tmp grew ~200k
 * entries / ~20GB a day on the Mac Studio (macOS only clears it at reboot).
 *
 *  - makeTmpDir(t, prefix): for test authors. Creates a dir under os.tmpdir()
 *    and registers t.after(rm -rf). `t` may be a TestContext or anything with
 *    an after() (pass node:test's top-level `after` hook for module-scoped dirs).
 *  - scopedTestTmpdir(): for test RUNNERS. Creates one fresh dir; pass its
 *    `env` (TMPDIR) to the child `node --test` process so every os.tmpdir()
 *    dir the suite makes lands inside it, then call cleanup() once the run
 *    returns. Catches every legacy test without migrating it.
 *
 * scripts/lib/test-tmpdir-cleanup-audit.js flags new test files that mkdtemp
 * without any cleanup.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function rmQuiet(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort */ }
}

function makeTmpDir(t, prefix = 'test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const register = typeof t === 'function' ? t : t && typeof t.after === 'function' ? t.after.bind(t) : null;
  if (!register) throw new Error('makeTmpDir(t, prefix): t must be a TestContext or an after() hook');
  register(() => rmQuiet(dir));
  return dir;
}

/**
 * @returns {{dir:string, env:{TMPDIR:string}, cleanup:()=>void}}
 * Short path under the parent's os.tmpdir() (unix socket paths stay well
 * under macOS's 104-char limit). Falls back to a no-op scope on failure so a
 * test run is never blocked by temp-dir trouble.
 */
function scopedTestTmpdir(prefix = 'bro-testrun-') {
  let dir;
  try { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }
  catch { return { dir: null, env: {}, cleanup: () => {} }; }
  return { dir, env: { TMPDIR: `${dir}/` }, cleanup: () => rmQuiet(dir) };
}

// Pure: does this test source create a temp dir with no cleanup anywhere in
// the file? (mkdtemp / mktemp -d with no rmSync/rmdirSync/fs.rm/rm -rf/rimraf/
// makeTmpDir). Coarse on purpose: one cleanup anywhere passes the file.
const CREATE_RE = /\bmkdtemp(?:Sync)?\s*\(|\bmktemp\s+-d\b/;
const CLEANUP_RE = /\brmSync\s*\(|\brmdirSync\s*\(|\brm(?:dir)?\s*\(|\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\b|\brimraf\b|\bmakeTmpDir\s*\(|\bscopedTestTmpdir\s*\(/;
function mkdtempWithoutCleanup(src) {
  const code = String(src || '');
  return CREATE_RE.test(code) && !CLEANUP_RE.test(code);
}

module.exports = { makeTmpDir, scopedTestTmpdir, mkdtempWithoutCleanup };
