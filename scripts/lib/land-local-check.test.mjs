import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { parseArgs, newFailureFiles, DEFAULT_GATES, LOCAL_SKIPPED_GATES } = require('./land-local-check.js');
const { GATES, ADVISORY_GATES } = require('./land-gate-delta.js');
const R = require('./codex-runner.js');

test('parseArgs: default gates are real gauntlet gates; --all, --gates and bad input', () => {
  for (const g of DEFAULT_GATES) assert.ok(GATES.includes(g), `${g} is a land-gate-delta gate`);
  assert.deepEqual(parseArgs([]).gates, DEFAULT_GATES);
  assert.deepEqual(parseArgs(['--all']).gates, GATES);
  assert.deepEqual(parseArgs(['--gates', 'lint-workflows']).gates, ['lint-workflows']);
  assert.equal(parseArgs(['--max-wait-minutes', '5']).maxWaitMs, 300_000);
  assert.match(parseArgs(['--gates', 'nope']).error, /unknown gate/);
  assert.match(parseArgs(['--gates', '']).error, /unknown gate/);
  assert.match(parseArgs(['--bogus']).error, /unknown argument/);
  assert.match(parseArgs(['--max-wait-minutes', 'x']).error, /positive/);
});

test('every gate land.yml blocks on runs by default or is skipped with a reason (BRO-5771)', () => {
  const blocking = GATES.filter((g) => !(ADVISORY_GATES[g] && ADVISORY_GATES[g]()));
  for (const g of blocking) {
    assert.ok(DEFAULT_GATES.includes(g) || (LOCAL_SKIPPED_GATES[g] || '').length > 10,
      `${g} blocks a land but is neither a default gate nor in LOCAL_SKIPPED_GATES with a reason`);
  }
  for (const g of ['unit-tests-tsx', 'tsc', 'next-lint']) assert.ok(DEFAULT_GATES.includes(g), `${g} runs by default`);
  for (const g of Object.keys(LOCAL_SKIPPED_GATES)) assert.ok(GATES.includes(g), `${g} is a real gate`);
});

test('newFailureFiles: a tsx-gate failure is not re-run under plain node', () => {
  const report = [
    '#### unit-tests-tsx — NEW on the branch (blocking)',
    '  - `tests/unit/commercial-unreleased.test.mjs::pages only load commercial data [testCodeFailure]`',
  ].join('\n');
  assert.equal(newFailureFiles(report), null);
});

test('withFileMutex: a throwing onWait gives up without taking or deleting the held lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llc-'));
  const p = join(dir, 'm.lock');
  writeFileSync(p, String(process.ppid)); // a live holder that is not us
  let ran = false;
  assert.throws(() => R.withFileMutex(p, () => { ran = true; }, { pollMs: 10, onWait: () => { throw new Error('timeout'); } }), /timeout/);
  assert.equal(ran, false);
  assert.ok(existsSync(p), 'the holder keeps its lock');
  assert.equal(R.withFileMutex(join(dir, 'free.lock'), () => 7), 7);
  assert.ok(!existsSync(join(dir, 'free.lock')), 'released after fn');
  assert.match(R.CONTAINER_LAND_MUTEX, /bsc-land-checks\.lock$/);
});

test('newFailureFiles: the NEW test files only; null when a new failure is not a test case', () => {
  const report = [
    '#### unit-tests-node — NEW on the branch (blocking)',
    '  - `tests/unit/duplicate-of-url-mismatch.test.mjs::duplicateOf-cycle mismatches are excluded [testCodeFailure]`',
    '',
    '#### unit-tests-node — pre-existing on origin/main (not blocking; still real, file an issue)',
    '  - `scripts/award-scores.test.mjs::computeSiteAwardScore [testCodeFailure]`',
  ].join('\n');
  assert.deepEqual(newFailureFiles(report), ['tests/unit/duplicate-of-url-mismatch.test.mjs']);
  assert.equal(newFailureFiles('#### lint-workflows — NEW on the branch (blocking)\n  - `lint-workflows::actionlint`'), null);
  assert.deepEqual(newFailureFiles('no lists at all'), []);
  const table = (rows) => ['| gate | verdict | mode | new |', '|---|---|---|---|', ...rows].join('\n');
  assert.deepEqual(newFailureFiles(table(['| unit-tests-node | **FAIL** | delta | 1 |']) + '\n' + report), ['tests/unit/duplicate-of-url-mismatch.test.mjs']);
  assert.equal(newFailureFiles(table(['| unit-tests-node | **FAIL** | delta | 1 |', '| scripts-lib-tests | **FAIL** | strict | 0 |']) + '\n' + report), null,
    'a gate that failed with no NEW list (crash, timeout) is never cleared by re-running another gate\'s files');
});
