import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Notion card 351637c5-416f-81f8-a8fd-c3e0570f1454: extend the safeWriteReview
// write-routing lint (review-texts only, 2026-04-29) to the other core data
// files. shows.json's guard shipped in 3c9d57b31ee, then commercial.json +
// audience-buzz.json were generalized alongside it in 39720ed985e — all five
// modes now share one script, scripts/lint-write-routing.sh, run both in CI
// (.github/workflows/test.yml) and the local pre-push hook. This test runs
// the REAL gate for each canonical-writer-protected file so a future script
// that reintroduces a raw fs.writeFileSync bypass fails locally and in CI,
// not just silently relies on the allowlist.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MODES = ['shows-json', 'reviews-json', 'audience-buzz-json', 'commercial-json'];

for (const mode of MODES) {
  test(`lint-write-routing.sh ${mode} exits 0 (the actual CI gate)`, () => {
    let output;
    try {
      output = execFileSync('bash', ['scripts/lint-write-routing.sh', mode], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const stdout = err.stdout || '';
      const stderr = err.stderr || '';
      assert.fail(
        `lint-write-routing.sh ${mode} exited ${err.status ?? `(signal ${err.signal})`}\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
      );
    }
    assert.ok(
      output.includes('route through') || output.includes('All detected'),
      `unexpected output from lint-write-routing.sh ${mode}:\n${output}`
    );
  });
}
