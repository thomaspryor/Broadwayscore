/**
 * Structural guard: a test that builds a throwaway git repo must tear it down
 * with RETRIES.
 *
 * The class (2026-09-15, main red): tests/unit/pre-push-visual-gate-scope.test.mjs
 * failed on the Linux runner as
 *
 *   not ok 6052 - REGRESSION: scoping survives a trailing non-merge commit ...
 *     failureType: 'hookFailed'
 *     error: "ENOTEMPTY: directory not empty, rmdir
 *             '/tmp/pre-push-visual-gate-scope-test-cYzWSh/.git/objects'"
 *
 * Every assertion in that test PASSED. What failed was the teardown hook, so the
 * TAP line names a passing behavioral test and reads exactly like a logic
 * regression — the most expensive possible way to report a cleanup race. It also
 * reproduces on no developer machine: the whole suite passed 10/10 locally at the
 * very commit CI reddened on, which is how a flake like this survives triage and
 * gets "fixed" by a re-run instead.
 *
 * Root cause: git writes into .git/objects from processes that outlive the
 * command that spawned them (notably `gc --auto`), so a plain
 * fs.rmSync(dir, { recursive: true, force: true }) can be walking the directory
 * while git is still creating files in it. `force` only suppresses ENOENT; it
 * does nothing for ENOTEMPTY. Node's rimraf takes maxRetries/retryDelay for
 * precisely this race, and without them the FIRST collision is fatal.
 *
 * So: 167 rmSync teardowns across the 25 test files that shell out to git now
 * pass { maxRetries: 10, retryDelay: 50 }. This guard keeps the 26th from
 * landing without them, because the failure it prevents is invisible locally and
 * misattributed in CI.
 *
 * Run: node --test tests/unit/tmp-git-repo-teardown-retries.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIRS = ['tests/unit', 'scripts/tests'];

// This guard QUOTES the unretried teardown it bans — in the header above and in
// the positive-control fixture below — so it matches its own patterns. It
// creates no temp git repo (its git text is fixture strings, never executed),
// so scanning it has no value and excluding it opens no hole. Same lesson as the
// diacritics structural guard's `// diacritic-guard-ok:` marker (2026-09-15):
// documenting an anti-pattern must never trip the guard that bans it, and the
// fix must not be to weaken the scan for everyone else.
const SELF = path.basename(fileURLToPath(import.meta.url));

// A test "shells out to git" if it invokes the binary at all. Deliberately
// broad: `git init` alone would miss a test that clones or worktree-adds a repo
// instead, and those race identically.
const USES_GIT = /(?:execFileSync|execSync|spawnSync|execFile|spawn)\(\s*['"]git['"]|['"]git init['"]|\bgit init\b/;
// The exact teardown shape that carries the race. Matching the options object
// rather than the whole call keeps this independent of how the path argument is
// built (path.join, a template literal, a bare variable — all appear in these
// files).
const RM_RECURSIVE = /rmSync\([^)]*\{[^}]*recursive:\s*true[^}]*\}/;
const HAS_RETRIES = /maxRetries:\s*\d+/;

function offendersIn(dir) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.test.mjs') || f.endsWith('.test.js'))
    .filter(f => !f.startsWith('_skip-') && f !== SELF)
    .map(f => ({ rel: `${dir}/${f}`, src: fs.readFileSync(path.join(abs, f), 'utf8') }))
    .filter(({ src }) => USES_GIT.test(src))
    .flatMap(({ rel, src }) => src.split('\n')
      .map((line, i) => ({ rel, line: i + 1, text: line }))
      .filter(({ text }) => RM_RECURSIVE.test(text) && !HAS_RETRIES.test(text)));
}

describe('tests that shell out to git must rmSync with retries', () => {
  for (const dir of DIRS) {
    it(`${dir}: every recursive rmSync passes maxRetries`, () => {
      const offenders = offendersIn(dir);
      assert.deepStrictEqual(
        offenders.map(o => `${o.rel}:${o.line}`), [],
        'A recursive rmSync in a git-using test raced git\'s own background writes and\n' +
        'reddened main as a FAKE logic failure (hookFailed / ENOTEMPTY on .git/objects).\n' +
        'Fix: add maxRetries: 10, retryDelay: 50 to the rmSync options.\n' +
        'Offending lines:\n' + offenders.map(o => `  ${o.rel}:${o.line} — ${o.text.trim()}`).join('\n')
      );
    });
  }

  // Without this, deleting every match from the regexes above (or renaming the
  // directories) would leave a guard that passes while checking nothing — the
  // "false positive fix turns the gate off" failure mode.
  it('the guard actually inspects git-using files (not vacuously green)', () => {
    const inspected = DIRS.flatMap(dir => {
      const abs = path.join(repoRoot, dir);
      if (!fs.existsSync(abs)) return [];
      return fs.readdirSync(abs)
        .filter(f => f.endsWith('.test.mjs'))
        .filter(f => f !== SELF && USES_GIT.test(fs.readFileSync(path.join(abs, f), 'utf8')));
    });
    assert.ok(inspected.length >= 20,
      `expected the git-using test population to stay substantial, saw ${inspected.length}`);
  });

  it('positive control: the regexes flag an unretried teardown and clear a retried one', () => {
    const bad = "execFileSync('git', ['init', d]);\n  fs.rmSync(d, { recursive: true, force: true });";
    const good = "execFileSync('git', ['init', d]);\n  fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });";
    for (const [label, src, expected] of [['unretried', bad, true], ['retried', good, false]]) {
      assert.ok(USES_GIT.test(src), `${label}: fixture must read as git-using`);
      const flagged = src.split('\n').some(l => RM_RECURSIVE.test(l) && !HAS_RETRIES.test(l));
      assert.strictEqual(flagged, expected, `${label} fixture classified wrong`);
    }
  });
});
