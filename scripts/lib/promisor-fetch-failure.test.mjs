// BRO-4219: the partial-clone lazy-fetch classifier shared by land-branch.js
// and push-with-retry.sh (via its CLI). The behavioural cases are the same
// ones land-branch.test.mjs pins; the CLI cases are what the shell caller
// actually depends on — exit codes, not return values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'promisor-fetch-failure.js');
const { isPromisorFetchFailure, PROMISOR_REBASE_RETRIES } = require('./promisor-fetch-failure.js');

// Verbatim shape from run 36351955579 (land/our-sinatra, 3-commit branch).
const REAL = 'fatal: remote error: upload-pack: not our ref e31a1e453a95c0ffee\nfatal: could not fetch bc4a5adf from promisor remote';

test('isPromisorFetchFailure: the real Land stderr retries, a content conflict never does', () => {
  assert.equal(isPromisorFetchFailure(REAL), true);
  assert.equal(isPromisorFetchFailure('error: could not fetch 1234 from promisor remote'), true);
  assert.equal(isPromisorFetchFailure('CONFLICT (content): Merge conflict in a.txt\nerror: could not apply 1234... feat'), false);
  assert.equal(isPromisorFetchFailure('CONFLICT (content): x\nfatal: not our ref abc'), false, 'a real conflict is never masked by a retry');
  assert.equal(isPromisorFetchFailure('cannot rebase: You have unstaged changes.'), false, 'a BRO-3662 pre-flight refusal is not a fetch failure');
  assert.equal(isPromisorFetchFailure(''), false);
  assert.equal(isPromisorFetchFailure(undefined), false);
});

test('land-branch.js re-exports the same function (one definition for both callers)', () => {
  const land = require('./land-branch.js');
  assert.equal(land.isPromisorFetchFailure, isPromisorFetchFailure);
  assert.equal(land.PROMISOR_REBASE_RETRIES, PROMISOR_REBASE_RETRIES);
});

test('CLI exit codes: 0 on a promisor failure file, 1 otherwise, stdin via "-"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'promisor-'));
  const yes = join(dir, 'yes.txt'); writeFileSync(yes, REAL);
  const no = join(dir, 'no.txt'); writeFileSync(no, 'CONFLICT (content): Merge conflict in a.txt\nfatal: not our ref abc');
  assert.equal(spawnSync(process.execPath, [CLI, yes]).status, 0);
  assert.equal(spawnSync(process.execPath, [CLI, no]).status, 1);
  assert.equal(spawnSync(process.execPath, [CLI, '-'], { input: REAL }).status, 0);
  assert.equal(spawnSync(process.execPath, [CLI, '-'], { input: 'Successfully rebased' }).status, 1);
});

test('CLI never widens the retry on a usage or read error (exit 2, not 0)', () => {
  assert.equal(spawnSync(process.execPath, [CLI]).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, '/nonexistent/path/stderr.txt']).status, 2);
  // Sanity: the exported function is what the CLI runs, not a copy.
  assert.equal(execFileSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(CLI)}).isPromisorFetchFailure(${JSON.stringify(REAL)})))`], { encoding: 'utf8' }), 'true');
});
