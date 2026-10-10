// BRO-917: cross-repo workflow races caused data loss and push failures. The three
// workflows that raced hardest must keep a top-level `concurrency:` group, and the
// dependency graph doc that explains the shared-writer map must exist.
// (The broader review-texts guard lives in scripts/lib/review-texts-workflows-concurrency.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wf = (name) => join(root, '.github', 'workflows', name);

for (const name of ['opening-night-poller.yml', 'rebuild-reviews.yml', 'adjudicate-review-queue.yml']) {
  test(`${name} has a top-level concurrency group`, () => {
    assert.ok(existsSync(wf(name)), `${name} missing`);
    assert.match(readFileSync(wf(name), 'utf8'), /^concurrency:/m);
  });
}

test('workflow dependency graph doc exists', () => {
  assert.ok(existsSync(join(root, 'docs', 'workflow-dependency-graph.md')));
});
