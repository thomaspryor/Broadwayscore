import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { checkReachableWithContentFallback } = require('../../scripts/lib/delayed-content-survival.js');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
}

function fixture(t, { added = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-content-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const origin = path.join(dir, 'origin.git');
  const writer = path.join(dir, 'writer');
  const checker = path.join(dir, 'checker');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', writer);
  git(writer, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(writer, 'README.md'), 'base\n');
  git(writer, 'add', '.');
  git(writer, 'commit', '-qm', 'base');
  const base = git(writer, 'rev-parse', 'HEAD');
  const file = added ? 'new-file.js' : 'README.md';
  fs.writeFileSync(path.join(writer, file), 'base\nour addition\n');
  git(writer, 'add', '.');
  git(writer, 'commit', '-qm', 'original');
  const sha = git(writer, 'rev-parse', 'HEAD');
  git(writer, 'remote', 'add', 'origin', origin);
  git(writer, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', '--depth=1', '--branch=main', `file://${origin}`, checker);
  function replace(content) {
    git(writer, 'checkout', '-q', '--detach', base);
    if (content !== null) {
      fs.writeFileSync(path.join(writer, file), content);
      git(writer, 'add', '.');
      git(writer, 'commit', '-qm', 'replacement');
    }
    git(writer, 'push', '-q', '--force', 'origin', 'HEAD:refs/heads/main');
  }
  function check(overrides = {}) {
    return checkReachableWithContentFallback('owner', 'repo', sha, 'main', {
      cwd: checker, compare: () => ({ ok: false, status: 'diverged' }), ...overrides,
    });
  }
  return { dir, writer, checker, base, sha, file, replace, check };
}

for (const result of [{ ok: true, status: 'ahead' }, { ok: true, status: 'identical' }, { ok: null, error: 'offline' }]) {
  test(`ancestry ${result.status || 'unavailable'} preserves the result without fetching`, () => {
    const actual = checkReachableWithContentFallback('o', 'r', 's', 'release', {
      compare: (...args) => { assert.deepEqual(args, ['o', 'r', 's', 'release']); return result; },
      contentCheck: () => assert.fail('must not fetch'),
    });
    assert.equal(actual, result);
  });
}

test('fallback receives the requested sha, branch and checkout; unconfirmed loss stays false', () => {
  const result = { ok: false, status: 'behind' };
  const actual = checkReachableWithContentFallback('o', 'r', 's', 'release', {
    cwd: '/checkout', compare: () => result,
    contentCheck: (cwd, entry) => {
      assert.equal(cwd, '/checkout');
      assert.deepEqual(entry, { sha: 's', branch: 'release' });
      return false;
    },
  });
  assert.equal(actual, result);
});

for (const added of [false, true]) {
  const kind = added ? 'added file' : 'modified file';
  test(`${kind}: equivalent content under a different sha suppresses the false alert`, t => {
    const f = fixture(t, { added });
    f.replace('base\nour addition\n');
    assert.notEqual(git(f.writer, 'rev-parse', 'HEAD'), f.sha);
    assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', f.sha, 'HEAD'], { cwd: f.writer }).status, 1);
    assert.deepEqual(f.check(), { ok: true, status: 'diverged', contentSurvived: true });
  });
  test(`${kind}: reverting to base still alerts (ACMT includes additions)`, t => {
    const f = fixture(t, { added });
    f.replace(null);
    assert.deepEqual(f.check(), { ok: false, status: 'diverged' });
  });
  test(`${kind}: a superset preserves our content`, t => {
    const f = fixture(t, { added });
    f.replace('base\nour addition\nlater addition\n');
    assert.equal(f.check().contentSurvived, true);
  });
}

test('a concurrent edit that drops our addition still alerts', t => {
  const f = fixture(t);
  f.replace('base\nunrelated addition\n');
  assert.equal(f.check().ok, false);
});

test('unfetchable sha, missing branch and parentless commit never suppress alerts', t => {
  const f = fixture(t);
  const scratchDirs = [];
  const originalMkdtemp = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (...args) => {
    const created = originalMkdtemp(...args);
    scratchDirs.push(created);
    return created;
  });
  for (const [sha, branch] of [['0'.repeat(40), 'main'], [f.sha, 'missing-branch'], [f.base, 'main']]) {
    const result = checkReachableWithContentFallback('o', 'r', sha, branch, {
      cwd: f.checker, compare: () => ({ ok: false, status: 'behind' }),
    });
    assert.equal(result.ok, false);
  }
  assert.equal(scratchDirs.length, 3);
  assert.ok(scratchDirs.every(dir => !fs.existsSync(dir)), 'scratch clones cleaned after early fetch failures');
});

test('rechecks each delayed checkpoint and preserves caller refs, shallow state and dirty files', t => {
  const f = fixture(t, { added: true });
  fs.writeFileSync(path.join(f.checker, 'README.md'), 'dirty work\n');
  fs.writeFileSync(path.join(f.checker, 'untracked'), 'keep\n');
  const before = {
    refs: git(f.checker, 'show-ref'),
    shallow: fs.readFileSync(path.join(f.checker, '.git/shallow'), 'utf8'),
    status: git(f.checker, 'status', '--porcelain'),
  };
  const scratchDirs = [];
  const originalMkdtemp = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (...args) => {
    const created = originalMkdtemp(...args);
    scratchDirs.push(created);
    return created;
  });
  f.replace('base\nour addition\n');
  assert.equal(f.check().ok, true);
  f.replace(null);
  assert.equal(f.check().ok, false, 'the first successful fallback must not cache survival');
  assert.deepEqual({
    refs: git(f.checker, 'show-ref'),
    shallow: fs.readFileSync(path.join(f.checker, '.git/shallow'), 'utf8'),
    status: git(f.checker, 'status', '--porcelain'),
  }, before);
  assert.equal(fs.readFileSync(path.join(f.checker, 'README.md'), 'utf8'), 'dirty work\n');
  assert.equal(fs.existsSync(path.join(f.checker, '.git/FETCH_HEAD')), false);
  assert.equal(scratchDirs.length, 2);
  assert.ok(scratchDirs.every(dir => !fs.existsSync(dir)), 'scratch clones cleaned on success and loss');
});

test('an actual merge commit is checked against its first parent', t => {
  const f = fixture(t);
  git(f.writer, 'checkout', '-qb', 'topic');
  fs.writeFileSync(path.join(f.writer, 'merged-file.js'), 'content from topic\n');
  git(f.writer, 'add', '.');
  git(f.writer, 'commit', '-qm', 'topic change');
  git(f.writer, 'checkout', '-q', 'main');
  git(f.writer, 'merge', '-q', '--no-ff', 'topic', '-m', 'merge topic');
  const sha = git(f.writer, 'rev-parse', 'HEAD');
  git(f.writer, 'push', '-q', 'origin', 'main');
  git(f.writer, 'checkout', '-q', '--detach', f.sha);
  fs.writeFileSync(path.join(f.writer, 'merged-file.js'), 'content from topic\n');
  git(f.writer, 'add', '.');
  git(f.writer, 'commit', '-qm', 'recreated topic content');
  git(f.writer, 'push', '-q', '--force', 'origin', 'HEAD:refs/heads/main');
  const check = () => checkReachableWithContentFallback('o', 'r', sha, 'main', {
    cwd: f.checker, compare: () => ({ ok: false, status: 'diverged' }),
  });
  assert.equal(check().contentSurvived, true);
  git(f.writer, 'push', '-q', '--force', 'origin', `${f.sha}:refs/heads/main`);
  assert.equal(check().ok, false, 'losing the merge addition must still alert');
});
