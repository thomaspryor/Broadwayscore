'use strict';
// Scanner behind tests/unit/tmp-git-repo-teardown-retries.test.mjs and
// tests/unit/git-race-fix.test.mjs (BRO-3620). A test that shells out to git
// must tear its temp repo down with rmSync({ maxRetries }): git keeps writing
// into .git/objects from processes that outlive the spawning command (`gc
// --auto`), and a plain recursive rmSync dies on the first ENOTEMPTY, which
// CI reports as a hookFailed on a test whose assertions all passed.
//
// The original guard scanned tests/unit and scripts/tests only, while CI also
// globs scripts/*.test.mjs and scripts/lib/*.test.mjs; 147 unretried
// teardowns sat in those two directories (BRO-3620).

const fs = require('fs');
const path = require('path');

// Every directory test.yml runs *.test.mjs from.
const GIT_TEST_DIRS = ['tests/unit', 'scripts/tests', 'scripts', 'scripts/lib'];

// A test "shells out to git" if it invokes the binary at all.
const USES_GIT = /(?:execFileSync|execSync|spawnSync|execFile|spawn)\(\s*['"]git['"]|['"]git init['"]|\bgit init\b/;
// The teardown shape that carries the race.
const RM_RECURSIVE = /rmSync\([^)]*\{[^}]*recursive:\s*true[^}]*\}/;
const HAS_RETRIES = /maxRetries:\s*\d+/;

// fs.rmSync's maxRetries only re-tries the final rmdir of a directory, never
// the walk that deletes its children, so a writer that adds a file after the
// walk makes every retry fail the same way (proved in
// tests/unit/git-race-fix.test.mjs). removeTreeSync re-runs the WHOLE removal
// with linear backoff, so a writer that stops within the budget always loses.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeTreeSync(dir, { attempts = 10, delayMs = 50 } = {}) {
  for (let i = 1; ; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
      return;
    } catch (e) {
      if (i >= attempts || !['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE'].includes(e.code)) throw e;
      sleepSync(delayMs * i);
    }
  }
}

function isUnretriedTeardown(line) {
  return RM_RECURSIVE.test(line) && !HAS_RETRIES.test(line);
}

function listTestFiles(repoRoot, dir, { exclude = [] } = {}) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.test.mjs') || f.endsWith('.test.js'))
    .filter(f => !f.startsWith('_skip-') && !exclude.includes(f))
    .map(f => ({ rel: `${dir}/${f}`, src: fs.readFileSync(path.join(abs, f), 'utf8') }));
}

function gitUsingTestFiles(repoRoot, dir, opts) {
  return listTestFiles(repoRoot, dir, opts).filter(({ src }) => USES_GIT.test(src));
}

function offendersIn(repoRoot, dir, opts) {
  return gitUsingTestFiles(repoRoot, dir, opts).flatMap(({ rel, src }) => src.split('\n')
    .map((text, i) => ({ rel, line: i + 1, text }))
    .filter(({ text }) => isUnretriedTeardown(text)));
}

module.exports = { removeTreeSync, GIT_TEST_DIRS, USES_GIT, RM_RECURSIVE, HAS_RETRIES, isUnretriedTeardown, gitUsingTestFiles, offendersIn };
