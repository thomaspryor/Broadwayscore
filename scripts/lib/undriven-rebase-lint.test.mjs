// BRO-5552: no inline rebase/merge in .github/ without the keep-run driver.
// Baseline is empty (every call was driven or marked keep-run-ok when this
// landed), so a new undriven call fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { findUndriven, scanRepo } = require('./undriven-rebase-lint.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRV = `-c "merge.ours.driver=bash '$GITHUB_WORKSPACE/scripts/lib/merge-keep-run.sh' B %O %A %B %P"`;

test('flags undriven pull --rebase / rebase / merge / cherry-pick', () => {
  for (const l of [
    'git pull --rebase -X theirs origin main',
    'if ! git pull origin main --rebase; then',
    'git rebase -X ours FETCH_HEAD',
    'GIT_EDITOR=true git rebase --continue',
    'git merge origin/main -X ours --no-edit',
    'git cherry-pick abc123',
    'git pull --no-rebase -X ours origin main',
    'git pull -r origin main',
    'git -C data pull --rebase',
  ]) assert.equal(findUndriven(l).length, 1, l);
});

test('accepts driven, marked, comment and non-content calls', () => {
  for (const l of [
    `git ${DRV} pull --rebase origin main`,
    `git ${DRV} rebase --continue`,
    '# git pull --rebase origin main',
    'git rebase --abort 2>/dev/null || true',
    'git rebase --skip',
    'MB=$(git merge-base HEAD origin/main)',
    'git merge-file --ours a b c',
    'git pull --rebase origin main # keep-run-ok: separate repo',
    'scripts/lib/push-with-retry.sh git rebase',
    `git ${DRV.replace(' B ',' A ')} pull --no-rebase -X ours origin main`,
  ]) assert.deepEqual(findUndriven(l), [], l);
  assert.deepEqual(findUndriven('# keep-run-ok: other repo\ngit pull --rebase'), []);
});

test('no undriven inline rebase/merge in .github/ on this tree', () => {
  assert.deepEqual(scanRepo(ROOT), []);
});
