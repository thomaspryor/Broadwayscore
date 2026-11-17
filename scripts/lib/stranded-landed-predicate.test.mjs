import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { makeStrandedLandedPredicate } = require('./headless-unlanded-detection.js');

// BRO-7664: real git repo, real predicate (no copied logic).
test('makeStrandedLandedPredicate: ancestor of origin/main is landed, a side-branch tip is not, junk is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stranded-pred-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('commit', '-q', '--allow-empty', '-m', 'base');
  g('checkout', '-q', '-b', 'job');
  g('commit', '-q', '--allow-empty', '-m', 'job work');
  const jobTip = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  g('commit', '-q', '--allow-empty', '-m', 'other');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  const pred = makeStrandedLandedPredicate({ cwd: dir });
  assert.equal(pred(jobTip), false, 'unlanded side branch');
  g('merge', '-q', '--no-ff', 'job', '-m', 'land');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  assert.equal(makeStrandedLandedPredicate({ cwd: dir })(jobTip), true, 'tip became an ancestor of origin/main');
  assert.equal(pred('deadbeef'), false);
  assert.equal(pred(null), false);
  assert.equal(makeStrandedLandedPredicate({})(jobTip), false);
});
