import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { makeStrandedLandedPredicate } = require('./headless-unlanded-detection.js');

// BRO-7664: real git repo + real predicate (no copied logic).
test('stranded rescue needs a landings.jsonl tip; a bare ancestor (dirty-worktree base) is NOT rescued', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stranded-pred-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('commit', '-q', '--allow-empty', '-m', 'base');
  const base = g('rev-parse', 'HEAD'); // a dirty-worktree strand records this as its sha
  g('commit', '-q', '--allow-empty', '-m', 'job work rebased onto main');
  const landedTip = g('rev-parse', 'HEAD');
  mkdirSync(join(dir, 'data/audit'), { recursive: true });
  writeFileSync(join(dir, 'data/audit/landings.jsonl'), JSON.stringify({ ts: '2026-11-15T12:00:00Z', tip: landedTip, sha: landedTip, ref: 'land/x' }) + '\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'landings');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  const pred = makeStrandedLandedPredicate({ cwd: dir });
  assert.equal(pred(landedTip), true, 'tip recorded by land.yml');
  assert.equal(pred(base), false, 'base commit is an ancestor of origin/main but never a landed job tip');
  assert.equal(pred(landedTip, { afterMs: Date.parse('2026-11-15T13:00:00Z') }), false, 'landing predates the job launch: not this job');
  assert.equal(pred(landedTip, { afterMs: Date.parse('2026-11-15T11:00:00Z') }), true);
  assert.equal(pred('deadbeef'), false);
  assert.equal(pred(null), false);
  assert.equal(makeStrandedLandedPredicate({})(landedTip), false);
});
