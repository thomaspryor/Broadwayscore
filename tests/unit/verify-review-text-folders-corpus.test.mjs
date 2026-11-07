// BRO-5683: exercise the real acceptance test's missing-corpus contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');

for (const [name, required, missing] of [
  ['required empty corpus fails', true, false],
  ['required missing corpus fails', true, true],
  ['optional empty corpus skips', false, false],
]) {
  test(name, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5683-'));
    try {
      const env = {
        ...process.env,
        REVIEW_TEXTS_DIR: missing ? path.join(dir, 'missing') : dir,
      };
      if (required) env.REQUIRE_REVIEW_CORPUS = '1';
      else delete env.REQUIRE_REVIEW_CORPUS;
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [
        '--test', '--test-reporter=tap', 'scripts/verify-review-text-folders.test.mjs',
      ], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      const output = result.stdout + result.stderr;
      assert.equal(result.status, required ? 1 : 0, output);
      assert.match(output, required ? /# fail 2\b/ : /# fail 0\b/);
      if (required) {
        assert.match(output, /checkout did not land/);
        assert.doesNotMatch(output, /# SKIP no review-texts corpus/);
      } else {
        assert.match(output, /ok \d+ - BRO-5153 folders are not orphans # SKIP/);
        assert.match(output, /ok \d+ - BRO-5153 folders without a show id stay deleted # SKIP/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
