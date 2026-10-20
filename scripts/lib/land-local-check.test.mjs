import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { parseArgs, newFailureFiles, DEFAULT_GATES } = require('./land-local-check.js');
const { GATES } = require('./land-gate-delta.js');
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
});
