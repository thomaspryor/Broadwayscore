/**
 * Guards tests/e2e/helpers/console-errors.ts:filterNonCriticalErrors.
 *
 * The E2E "no console errors" assertions drop known-benign console output via
 * this allowlist. Two properties MUST hold together, or the assertion is
 * worthless:
 *   1. Next.js RSC-prefetch degradation ("Failed to fetch RSC payload ...
 *      Falling back to browser navigation") is filtered — it floods the console
 *      during deploy-skew windows and is not a user-visible error (task #401).
 *   2. A genuine, unexpected console.error is NOT filtered — the allowlist must
 *      never neuter the assertion.
 *
 * The real TS function is exercised through tsx (same pattern as
 * classify-category-parity.test.mjs) so a regression in the source fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../../');

// Run an array of console strings through the real TS filter in one tsx process.
function filterViaTS(errors) {
  const helper = path.join(root, 'tests/e2e/helpers/console-errors.ts').replace(/\\/g, '/');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'console-errors-'));
  const inPath = path.join(tmp, 'in.json');
  const runnerPath = path.join(tmp, 'runner.mjs');
  writeFileSync(inPath, JSON.stringify(errors));
  writeFileSync(
    runnerPath,
    `
    import { readFileSync } from 'node:fs';
    import { filterNonCriticalErrors } from '${helper}';
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(JSON.stringify(filterNonCriticalErrors(input)));
  `
  );
  try {
    const result = execFileSync('node', ['--import', 'tsx', runnerPath, inPath], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(result.toString().trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const RSC_MESSAGE =
  'Failed to fetch RSC payload for https://broadwayscorecard.com/off-broadway. ' +
  'Falling back to browser navigation. TypeError: Failed to fetch\n    at f (...)';

test('RSC prefetch-degradation message is filtered out (deploy-skew noise)', () => {
  const filtered = filterViaTS([RSC_MESSAGE]);
  assert.deepEqual(filtered, [], 'RSC "Falling back to browser navigation" must be treated as benign');
});

test('allowlist does NOT neuter a genuine unexpected console.error', () => {
  const genuine = 'TypeError: Cannot read properties of undefined (reading score) at ShowHero';
  const filtered = filterViaTS([genuine]);
  assert.deepEqual(filtered, [genuine], 'an unexpected console.error must still fail the assertion');
});

test('mixed batch keeps only the genuine error', () => {
  const genuine = 'ReferenceError: getScore is not defined';
  const filtered = filterViaTS([
    RSC_MESSAGE,
    'Failed to load resource: the server responded with a status of 404',
    'favicon.ico 404',
    genuine,
  ]);
  assert.deepEqual(filtered, [genuine]);
});

test('a bare "Failed to fetch" without the RSC-fallback half is NOT filtered', () => {
  // Guards against the allowlist being too broad: only Next's exact
  // two-part degradation message is benign, not any "Failed to fetch".
  const appError = 'TypeError: Failed to fetch at fetchReviews (app code)';
  const filtered = filterViaTS([appError]);
  assert.deepEqual(filtered, [appError]);
});
