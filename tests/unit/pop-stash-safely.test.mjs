import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../scripts/lib/pop-stash-safely.sh', import.meta.url));
const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pop-stash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, text) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  };
  const read = name => readFileSync(path.join(dir, name), 'utf8');
  const commit = message => { git('add', '-A'); git('commit', '-qm', message); };
  git('init', '-q', '--initial-branch=main');
  write('notes.txt', 'base notes\n');
  write('data/audit/snapshot.json', 'base snapshot\n');
  commit('base');
  const run = () => spawnSync('bash', ['-c', `
    set -uo pipefail
    source "$1"
    MAIN_DIR="$2"
    g() { git -C "$MAIN_DIR" "$@"; }
    log() { printf '%s\\n' "$*"; }
    pop_stash_safely
  `, 'test', helper, dir], { env, encoding: 'utf8', timeout: 10000 });
  return { dir, git, write, read, commit, run };
}

for (const conflict of ['modify/modify', 'modify/delete', 'ledger']) {
  test(`failed pop during ${conflict} merge retains unrelated tracked edits`, t => {
    const f = fixture(t);
    const name = conflict === 'ledger' ? 'data/audit/ledger.jsonl' : 'data/audit/snapshot.json';
    if (conflict === 'ledger') { f.write(name, 'base ledger\n'); f.commit('ledger'); }
    f.git('checkout', '-qb', 'incoming');
    f.write(name, 'incoming\n'); f.commit('incoming');
    f.git('checkout', '-q', 'main');
    if (conflict === 'modify/delete') f.git('rm', name);
    else f.write(name, 'main\n');
    f.commit('main');
    f.write('notes.txt', 'unrelated work\n');
    f.write('data/audit/snapshot.json', 'stashed snapshot\n');
    f.git('add', '-A');
    f.git('stash', 'push', '-qm', 'mixed edits');
    const sha = f.git('rev-parse', 'stash@{0}');
    const merge = spawnSync('git', ['merge', '--no-edit', 'incoming'], { cwd: f.dir, env, encoding: 'utf8' });
    assert.equal(merge.status, 1, 'fixture must have a real merge conflict');
    const r = f.run();
    assert.equal(r.status, conflict === 'ledger' ? 1 : 0, r.stdout + r.stderr);
    assert.equal(f.git('rev-parse', 'stash@{0}'), sha);
    assert.equal(f.git('show', `${sha}:notes.txt`), 'unrelated work');
    assert.equal(f.read('notes.txt'), 'base notes\n', 'Git never applied the stash');
    if (conflict === 'ledger') assert.equal(f.git('diff', '--name-only', '--diff-filter=U'), name);
    else {
      assert.equal(f.git('diff', '--name-only', '--diff-filter=U'), '');
      assert.match(r.stdout, /KEEPING.*stash/);
    }
  });
}

test('clean pop restores all content and drops only the popped stash', t => {
  const f = fixture(t);
  f.write('notes.txt', 'older stash\n'); f.git('stash', 'push', '-qm', 'older');
  const older = f.git('rev-parse', 'stash@{0}');
  f.write('notes.txt', 'unrelated work\n');
  f.write('data/audit/snapshot.json', 'snapshot work\n');
  f.git('stash', 'push', '-qm', 'mixed edits');
  assert.equal(f.run().status, 0);
  assert.equal(f.read('notes.txt'), 'unrelated work\n');
  assert.equal(f.read('data/audit/snapshot.json'), 'snapshot work\n');
  assert.equal(f.git('rev-parse', 'stash@{0}'), older);
});

for (const midMerge of [false, true]) {
  test(`failed pop without unmerged paths retains stash (MERGE_HEAD=${midMerge})`, t => {
    const f = fixture(t);
    f.write('notes.txt', 'stashed work\n'); f.git('stash', 'push', '-qm', 'work');
    const sha = f.git('rev-parse', 'stash@{0}');
    if (midMerge) writeFileSync(path.join(f.dir, '.git/MERGE_HEAD'), f.git('rev-parse', 'HEAD') + '\n');
    f.write('notes.txt', 'new local work\n');
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(f.git('rev-parse', 'stash@{0}'), sha);
    assert.equal(f.read('notes.txt'), 'new local work\n');
    assert.match(r.stdout, /KEEPING.*stash/);
  });
}

test('stash conflict without MERGE_HEAD retains both mixed stashed edits', t => {
  const f = fixture(t);
  f.write('notes.txt', 'stashed notes\n');
  f.write('data/audit/snapshot.json', 'stashed snapshot\n'); f.git('stash', 'push', '-qm', 'work');
  const sha = f.git('rev-parse', 'stash@{0}');
  f.write('data/audit/snapshot.json', 'new main snapshot\n'); f.commit('advance');
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.git('rev-parse', 'stash@{0}'), sha);
  assert.equal(f.git('show', `${sha}:notes.txt`), 'stashed notes');
  assert.equal(f.git('show', `${sha}:data/audit/snapshot.json`), 'stashed snapshot');
  assert.equal(f.git('status', '--porcelain'), '');
});
