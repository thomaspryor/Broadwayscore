import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseWorktreePorcelain } = require('./worktree-lock-parse.js');
const cli = fileURLToPath(new URL('./worktree-lock-parse.js', import.meta.url));

const fixtures = [
  {
    name: 'locked with reason',
    text: 'worktree /repo/with reason\nHEAD abc\nbranch refs/heads/topic/one\nlocked session owner (pid 123)\n',
    expected: { path: '/repo/with reason', branch: 'topic/one', locked: true, lockReason: 'session owner (pid 123)' },
  },
  {
    name: 'locked without reason',
    text: 'worktree /repo/no-reason\nHEAD def\nbranch refs/heads/topic/two\nlocked\n',
    expected: { path: '/repo/no-reason', branch: 'topic/two', locked: true, lockReason: '' },
  },
  {
    name: 'unlocked',
    text: 'worktree /repo/unlocked\nHEAD abc\nbranch refs/heads/main\n',
    expected: { path: '/repo/unlocked', branch: 'main', locked: false, lockReason: null },
  },
  {
    name: 'detached',
    text: 'worktree /repo/detached\nHEAD abc\ndetached\n',
    expected: { path: '/repo/detached', branch: null, locked: false, lockReason: null },
  },
  {
    name: 'locked detached with escaped multiline reason',
    text: 'worktree /repo/detached-locked\nHEAD abc\ndetached\nlocked "first\\nsecond\\tline"\n',
    expected: { path: '/repo/detached-locked', branch: null, locked: true, lockReason: '"first\\nsecond\\tline"' },
  },
  {
    name: 'bare with unknown fields',
    text: 'worktree /repo/bare\nbare\nlockedSince yesterday\nprunable missing directory\n',
    expected: { path: '/repo/bare', branch: null, locked: false, lockReason: null },
  },
];

for (const { name, text, expected } of fixtures) {
  test(name, () => assert.deepEqual(parseWorktreePorcelain(text), [expected]));
}

test('each worktree resets branch and lock state, with or without a final separator', () => {
  const expected = fixtures.map(f => f.expected);
  const text = fixtures.map(f => f.text).join('\n');
  assert.deepEqual(parseWorktreePorcelain(text + '\n'), expected);
  assert.deepEqual(parseWorktreePorcelain(text.trimEnd()), expected);
  assert.deepEqual(parseWorktreePorcelain(fixtures.map(f => f.text).join('')), expected);
});

test('empty output and fields outside records do not create worktrees', () => {
  assert.deepEqual(parseWorktreePorcelain(''), []);
  assert.deepEqual(parseWorktreePorcelain('\nHEAD abc\nlocked stray reason\n'), []);
  assert.deepEqual(parseWorktreePorcelain(fixtures[2].text + '\nlocked stray reason\n'), [fixtures[2].expected]);
});

function assertCliRecords(text, expected) {
  const output = execFileSync(process.execPath, [cli], { input: text, encoding: 'utf8' });
  const fields = expected.flatMap(entry => [
    entry.path, entry.branch || '', entry.locked ? '1' : '0', entry.lockReason || '',
  ]);
  assert.equal(output, fields.length ? fields.join('\0') + '\0' : '');
}

test('GC shell adapter preserves field boundaries, including empty fields and spaces', () => {
  assertCliRecords(fixtures.map(f => f.text).join('\n'), fixtures.map(f => f.expected));
  assertCliRecords('', []);
});

test('real Git output agrees with both the parser and shell adapter', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-lock-parse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  // Resolve macOS /var -> /private/var so expected paths match Git's output.
  const repo = fs.realpathSync(root);
  const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  const cases = [
    { name: 'a-reason', branch: 'a-reason', locked: true, lockReason: 'session owner (pid 123)' },
    { name: 'b-reasonless', branch: 'b-reasonless', locked: true, lockReason: '' },
    { name: 'c-detached', branch: null, locked: false, lockReason: null },
    { name: 'd-unlocked with spaces', branch: 'd-unlocked', locked: false, lockReason: null },
  ];
  const expected = [{ path: repo, branch: 'main', locked: false, lockReason: null }];
  for (const { name, branch, locked, lockReason } of cases) {
    const wtPath = path.join(repo, 'worktrees', name);
    git('worktree', 'add', '-q', ...(branch ? ['-b', branch] : ['--detach']), wtPath, 'main');
    if (locked) git('worktree', 'lock', ...(lockReason ? ['--reason', lockReason] : []), wtPath);
    expected.push({ path: wtPath, branch, locked, lockReason });
  }
  const porcelain = git('worktree', 'list', '--porcelain');
  assert.deepEqual(parseWorktreePorcelain(porcelain), expected);
  assertCliRecords(porcelain, expected);
});
