// Acceptance test for Notion card 3b2637c5-416f-818f (Carmen-class sweep):
// passes only when every cross-outlet attribution suspect has been triaged
// (corrected, excluded, or annotated crossOutletVerified:true). Reads LIVE
// repo data via the scanner — run from the main checkout that owns
// data/review-texts (pattern: verify-provider-spend-streak.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no unreviewed cross-outlet attribution suspects remain', () => {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'audit-cross-outlet-attributions.js'), '--json'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
  } catch (err) {
    // Scanner exits 1 while suspects remain; its stdout still carries the JSON.
    out = err.stdout;
  }
  const { count, suspects } = JSON.parse(out);
  assert.strictEqual(
    count,
    0,
    `unreviewed cross-outlet suspects remain (first 5): ${JSON.stringify((suspects || []).slice(0, 5), null, 2)}`
  );
});
