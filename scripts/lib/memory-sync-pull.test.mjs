import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncMainSafely } from './memory-sync-pull.js';

// Fake git: keyed by joined-args command string. Anything not explicitly
// scripted is treated as "not found / no-op success" (code 1 for rev-parse
// --verify checks reads as "ref does not exist", which is the safe default —
// scripting every marker check per test would be noise).
function makeGit(script) {
  const calls = [];
  const git = (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key in script) return script[key];
    if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  git.calls = calls;
  return git;
}

test('clean pull returns ok and never calls merge --abort', () => {
  const git = makeGit({
    'fetch origin main': { code: 0, stdout: '', stderr: '' },
    'merge --no-edit FETCH_HEAD': { code: 0, stdout: 'Already up to date.', stderr: '' },
  });
  const result = syncMainSafely({ cwd: '/repo', git, log: () => {} });
  assert.equal(result.status, 'ok');
  assert.ok(!git.calls.some((c) => c.includes('--abort')));
});

test('conflicting merge replay is aborted and reported', () => {
  const git = makeGit({
    'fetch origin main': { code: 0, stdout: '', stderr: '' },
    'merge --no-edit FETCH_HEAD': {
      code: 1,
      stdout: '',
      stderr: 'CONFLICT (add/add): Merge conflict in scripts/express-retry-queue.js',
    },
    'merge --abort': { code: 0, stdout: '', stderr: '' },
  });
  const result = syncMainSafely({ cwd: '/repo', git, log: () => {} });
  assert.equal(result.status, 'aborted');
  assert.equal(result.abortIssued, true);
  assert.equal(result.abortOk, true);
  assert.ok(git.calls.includes('merge --abort'));
});

test('merge failure is surfaced via log, not swallowed', () => {
  const git = makeGit({
    'fetch origin main': { code: 0, stdout: '', stderr: '' },
    'merge --no-edit FETCH_HEAD': { code: 1, stdout: '', stderr: 'CONFLICT in foo.json' },
    'merge --abort': { code: 0, stdout: '', stderr: '' },
  });
  const logs = [];
  syncMainSafely({ cwd: '/repo', git, log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => m.includes('CONFLICT in foo.json')), `expected a log line with the conflict, got: ${JSON.stringify(logs)}`);
});

test('a failed merge --abort is itself surfaced, not swallowed', () => {
  const git = makeGit({
    'fetch origin main': { code: 0, stdout: '', stderr: '' },
    'merge --no-edit FETCH_HEAD': { code: 1, stdout: '', stderr: 'CONFLICT in foo.json' },
    'merge --abort': { code: 1, stdout: '', stderr: 'fatal: There is no merge to abort' },
  });
  const logs = [];
  const result = syncMainSafely({ cwd: '/repo', git, log: (m) => logs.push(m) });
  assert.equal(result.abortOk, false);
  assert.ok(logs.some((m) => m.includes("'git merge --abort' itself failed")));
});

test('fetch failure surfaces on stderr and never attempts a merge', () => {
  const git = makeGit({
    'fetch origin main': { code: 1, stdout: '', stderr: 'could not resolve host' },
  });
  const logs = [];
  const result = syncMainSafely({ cwd: '/repo', git, log: (m) => logs.push(m) });
  assert.equal(result.status, 'fetch-failed');
  assert.ok(logs.some((m) => m.includes('could not resolve host')));
  assert.ok(!git.calls.some((c) => c.startsWith('merge')));
});

test('pre-existing MERGE_HEAD blocks without touching the checkout', () => {
  const git = makeGit({
    'rev-parse -q --verify MERGE_HEAD': { code: 0, stdout: 'deadbeef\n', stderr: '' },
  });
  const logs = [];
  const result = syncMainSafely({ cwd: '/repo', git, log: (m) => logs.push(m) });
  assert.equal(result.status, 'blocked-existing-residue');
  assert.equal(result.marker, 'MERGE_HEAD');
  assert.ok(!git.calls.some((c) => c.startsWith('fetch') || c.includes('merge ')));
  assert.ok(logs.some((m) => m.includes('not ours to abort')));
});

test('pre-existing REBASE_HEAD (a rebase stopped on conflict) also blocks', () => {
  const git = makeGit({
    'rev-parse -q --verify MERGE_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse -q --verify CHERRY_PICK_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse -q --verify REVERT_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse -q --verify REBASE_HEAD': { code: 0, stdout: 'cafebabe\n', stderr: '' },
  });
  const result = syncMainSafely({ cwd: '/repo', git, log: () => {} });
  assert.equal(result.status, 'blocked-existing-residue');
  assert.equal(result.marker, 'REBASE_HEAD');
});

test('a live rebase stopped on a non-conflict failure (no REBASE_HEAD, but rebase-merge/ on disk) still blocks', () => {
  // Empirically confirmed (task #1893 ship-check finding): `git rebase -x false`
  // stops mid-operation WITHOUT ever creating REBASE_HEAD — only the
  // rebase-merge/ directory marks it. A REBASE_HEAD-only check would miss
  // this and barrel into fetch/merge on top of a live rebase.
  const git = makeGit({
    'rev-parse -q --verify MERGE_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse -q --verify CHERRY_PICK_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse -q --verify REVERT_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse -q --verify REBASE_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse --path-format=absolute --git-path rebase-merge': {
      code: 0,
      stdout: '/repo/.git/rebase-merge\n',
      stderr: '',
    },
  });
  const pathExists = (p) => p === '/repo/.git/rebase-merge';
  const result = syncMainSafely({ cwd: '/repo', git, pathExists, log: () => {} });
  assert.equal(result.status, 'blocked-existing-residue');
  assert.equal(result.marker, 'REBASE_HEAD');
  assert.ok(!git.calls.some((c) => c.startsWith('fetch') || c.includes('merge ')));
});

test('rebase-apply/ (apply-based backend) is checked when rebase-merge/ is absent', () => {
  const git = makeGit({
    'rev-parse -q --verify MERGE_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse -q --verify CHERRY_PICK_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse -q --verify REVERT_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse -q --verify REBASE_HEAD': { code: 1, stdout: '', stderr: '' },
    'rev-parse --path-format=absolute --git-path rebase-merge': {
      code: 0,
      stdout: '/repo/.git/rebase-merge\n',
      stderr: '',
    },
    'rev-parse --path-format=absolute --git-path rebase-apply': {
      code: 0,
      stdout: '/repo/.git/rebase-apply\n',
      stderr: '',
    },
  });
  const pathExists = (p) => p === '/repo/.git/rebase-apply';
  const result = syncMainSafely({ cwd: '/repo', git, pathExists, log: () => {} });
  assert.equal(result.status, 'blocked-existing-residue');
  assert.equal(result.marker, 'REBASE_HEAD');
});
