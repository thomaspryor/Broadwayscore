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
  fs.rmSync(dir, { recursive: true, force: true });
});
