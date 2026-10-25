import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LIB = path.resolve('scripts/lib/is-partial-clone.sh');
const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'pipe' });
const partial = (d) => {
  try {
    execFileSync('bash', ['-c', `. "${LIB}"; is_partial_clone "$1"`, '_', d], { stdio: 'pipe' });
    return true;
  } catch { return false; }
};
const fresh = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'pc-'));
  execFileSync('git', ['init', '-q', d]);
  return d;
};

test('full clone is not partial', () => assert.equal(partial(fresh()), false));
test('promisor remote is partial', () => {
  const d = fresh();
  git(d, 'config', 'remote.origin.promisor', 'true');
  assert.equal(partial(d), true);
});
test('extensions.partialclone is partial', () => {
  const d = fresh();
  git(d, 'config', 'extensions.partialclone', 'origin');
  assert.equal(partial(d), true);
});
test('sparse checkout alone keeps all objects, so is not partial', () => {
  const d = fresh();
  git(d, 'config', 'core.sparseCheckout', 'true');
  assert.equal(partial(d), false);
});
test('setup-local-data.sh uses the guard', () => {
  assert.match(readFileSync('scripts/setup-local-data.sh', 'utf8'), /! is_partial_clone "\$REVIEW_TEXTS_SOURCE"/);
});
