/**
 * test-name-file.js — find the one test file that declares a failing test's name.
 *
 * Why (BRO-6262): ci-red cards ("main test.yml red: Unit Tests / ... — "<test>"")
 * fell back to the job proxy VERIFY `node scripts/run-unit-tests.js`. The whole
 * suite never passes from a worker session (unrelated reds), so the Done gate
 * refused every one of those cards after its fix had landed and they sat In
 * Review. The failing test's name is in the card, so the targeted check is
 * `node --test <file>`.
 *
 * Pure matcher + a thin git-grep wrapper. Ambiguity (0 or 2+ files) returns
 * null so the caller keeps its existing fallback instead of arming a guess.
 */

'use strict';

const { execFileSync } = require('child_process');

const TEST_FILE_RE = /^[A-Za-z0-9_./-]+\.test\.(?:mjs|js|cjs)$/;

/** The single test file among `files` that is safe to name in a VERIFY line, or null. */
function pickTestFile(files) {
  const ok = [...new Set((files || []).map((f) => String(f).trim()).filter((f) => TEST_FILE_RE.test(f)))];
  return ok.length === 1 ? ok[0] : null;
}

/**
 * @param {string} testName the failing test's name as the TAP line printed it
 * @param {{cwd?: string, grep?: (name: string, cwd?: string) => string[]}} [opts]
 * @returns {string|null} repo-relative path, or null when 0 or 2+ test files declare it
 */
function findTestFileByName(testName, { cwd, grep = gitGrepFiles } = {}) {
  const name = String(testName || '').trim();
  if (name.length < 8) return null;
  let files;
  try { files = grep(name, cwd); } catch { return null; }
  return pickTestFile(files);
}

function gitGrepFiles(name, cwd) {
  try {
    const out = execFileSync('git', ['grep', '-l', '-F', '-e', name, '--', 'tests', 'scripts'],
      { cwd, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    if (err && err.status === 1) return []; // git grep: no match
    throw err;
  }
}

module.exports = { findTestFileByName, pickTestFile, TEST_FILE_RE };
