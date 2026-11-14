// Tests for scripts/audit-feedback-overnight-branches.js (BRO-3015). Uses the REAL functions plus a
// throwaway git repo to prove reverse-apply detects "fix already on main".
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseBranchList, classify, auditBranch } = require('./audit-feedback-overnight-branches.js');

test('parseBranchList keeps only feedback-overnight branches, strips worktree markers, dedupes', () => {
  const out = parseBranchList(
    '+ worktree-feedback-overnight-2026-08-09T06-15-01\n  main\n* worktree-feedback-overnight-2026-08-09T06-15-01\n  worktree-other-2026-08-09T06-15-01\n',
  );
  assert.deepStrictEqual(out, ['worktree-feedback-overnight-2026-08-09T06-15-01']);
});

test('parseBranchList keeps remote-only refs, local wins over remote twin', () => {
  const out = parseBranchList(
    'origin/worktree-feedback-overnight-2026-08-09T06-15-01\nworktree-feedback-overnight-2026-08-09T06-15-01\norigin/worktree-feedback-overnight-2026-08-10T06-15-01\n',
  );
  assert.deepStrictEqual(out, [
    'origin/worktree-feedback-overnight-2026-08-10T06-15-01',
    'worktree-feedback-overnight-2026-08-09T06-15-01',
  ]);
});

test('auditBranch: multi-commit branch audits every commit; merged and empty are recognised', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-audit2-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
    g('init', '-q');
    g('checkout', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
    g('add', '.');
    g('commit', '-qm', 'base');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const N = (d) => `worktree-feedback-overnight-2026-02-0${d}T00-00-00`;
    // Two commits: the first edits a.txt, the second only b.txt. Main later gets the second.
    g('checkout', '-q', '-b', N(1), 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'ONE\n');
    g('commit', '-qam', 'c1');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'BEE\n');
    g('commit', '-qam', 'c2');
    g('checkout', '-q', '-b', N(2), 'main');
    g('commit', '-q', '--allow-empty', '-m', 'empty tip');
    g('checkout', '-q', '-b', N(3), 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'merged\n');
    g('commit', '-qam', 'c3');
    g('checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'BEE\n');
    g('commit', '-qam', 'main takes c2');
    g('merge', '-q', '--no-ff', '-m', 'merge c3', N(3));
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const one = auditBranch(dir, N(1));
    assert.deepStrictEqual(one.files.sort(), ['a.txt', 'b.txt']); // c1 is not ignored
    assert.strictEqual(one.fileStates['b.txt'], 'present');
    assert.strictEqual(auditBranch(dir, N(2)).disposition, 'empty');
    assert.strictEqual(auditBranch(dir, N(3)).disposition, 'merged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('classify precedence: merged > superseded > mergeable > conflicts', () => {
  assert.strictEqual(classify({ isAncestor: true, reverseApplies: true, forwardApplies: true }), 'merged');
  assert.strictEqual(classify({ isAncestor: false, reverseApplies: true, forwardApplies: false }), 'superseded');
  assert.strictEqual(classify({ isAncestor: false, reverseApplies: false, forwardApplies: true }), 'mergeable');
  assert.strictEqual(classify({ isAncestor: false, reverseApplies: false, forwardApplies: false }), 'conflicts');
});

test('auditBranch against a real repo: superseded, mergeable, conflicts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-audit-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');

  const mk = (name, content) => {
    g('checkout', '-q', '-b', name, 'main');
    fs.writeFileSync(f, content);
    g('commit', '-qam', 'fix: 6 TestFlight beta-feedback items');
  };
  mk('worktree-feedback-overnight-2026-01-01T00-00-00', 'one\nTWO\nthree\n');
  mk('worktree-feedback-overnight-2026-01-02T00-00-00', 'one\nTWO\nthree\nfour\n');
  // main later gets the first fix independently and diverges the same line for the second.
  g('checkout', '-q', 'main');
  fs.writeFileSync(f, 'one\nTWO\nthree\n');
  g('commit', '-qam', 'main fixes TWO');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  mk('worktree-feedback-overnight-2026-01-03T00-00-00', 'one\ntwo\nthree\nfive\n');
  g('checkout', '-q', 'main');
  fs.writeFileSync(f, 'one\nTWO\nthree\nsix\n');
  g('commit', '-qam', 'main diverges');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');

  g('checkout', '-q', '-b', 'worktree-feedback-overnight-2026-01-04T00-00-00', 'main');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  g('add', '.');
  g('commit', '-qm', 'fix: new file');
  g('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'other\n');
  g('add', '.');
  g('commit', '-qm', 'main b');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('checkout', '-q', '-b', 'worktree-feedback-overnight-2026-01-05T00-00-00', 'main~1');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  g('add', '.');
  g('commit', '-qm', 'fix: c');
  g('checkout', '-q', 'main');
  const r = (n) => auditBranch(dir, `worktree-feedback-overnight-2026-01-0${n}T00-00-00`);
  assert.strictEqual(r(1).disposition, 'superseded');
  assert.strictEqual(r(2).disposition, 'conflicts');
  assert.strictEqual(r(3).disposition, 'conflicts');
  assert.strictEqual(r(4).disposition, 'conflicts'); // add/add on b.txt
  assert.strictEqual(r(5).disposition, 'mergeable');
  assert.ok(r(1).files.includes('a.txt'));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
