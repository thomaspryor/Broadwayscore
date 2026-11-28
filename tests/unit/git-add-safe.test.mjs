// BRO-2945: git_add_safe stages each path independently. Real temp git repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/lib/git-add-safe.sh');

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-'));
  const git = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, '.gitignore'), 'ignored.json\n');
  fs.writeFileSync(path.join(d, 'seed'), 'x');
  git('add', '.'); git('commit', '-qm', 'seed');
  return { d, git };
}
function run(d, args) {
  return spawnSync('bash', ['-c', 'set -euo pipefail; source "$0"; git_add_safe "$@"', HELPER, ...args], { cwd: d, encoding: 'utf8' });
}
const staged = git => git('diff', '--cached', '--name-status').trim().split('\n').filter(Boolean);

test('missing file among several still stages the rest (flat git add would stage nothing)', () => {
  const { d, git } = repo();
  fs.writeFileSync(path.join(d, 'a.json'), '1');
  fs.writeFileSync(path.join(d, 'c.json'), '3');
  const flat = spawnSync('git', ['add', 'a.json', 'b.json', 'c.json'], { cwd: d, encoding: 'utf8' });
  assert.notEqual(flat.status, 0);
  assert.deepEqual(staged(git), []);
  const r = run(d, ['a.json', 'b.json', 'c.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /b\.json does not exist/);
  assert.deepEqual(staged(git).sort(), ['A\ta.json', 'A\tc.json']);
});

test('tracked-then-deleted file is staged as a deletion alongside others', () => {
  const { d, git } = repo();
  fs.writeFileSync(path.join(d, 'cp.json'), 'x');
  fs.writeFileSync(path.join(d, 'digest.json'), 'y');
  git('add', '.'); git('commit', '-qm', 'add');
  fs.unlinkSync(path.join(d, 'cp.json'));
  fs.writeFileSync(path.join(d, 'digest.json'), 'changed');
  const r = run(d, ['cp.json', 'digest.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(staged(git).sort(), ['D\tcp.json', 'M\tdigest.json']);
});

test('gitignored path warns without failing or blocking the rest', () => {
  const { d, git } = repo();
  fs.writeFileSync(path.join(d, 'ignored.json'), 'i');
  fs.writeFileSync(path.join(d, 'ok.json'), 'o');
  const r = run(d, ['ignored.json', 'ok.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ignored\.json is gitignored/);
  assert.deepEqual(staged(git), ['A\tok.json']);
});

test('--force stages an ignored path', () => {
  const { d, git } = repo();
  fs.writeFileSync(path.join(d, 'ignored.json'), 'i');
  const r = run(d, ['--force', 'ignored.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(staged(git), ['A\tignored.json']);
});

test('real git errors surface as nonzero (no masking)', () => {
  const { d, git } = repo();
  fs.writeFileSync(path.join(d, 'ok.json'), 'o');
  fs.writeFileSync(path.join(d, '.git', 'index.lock'), '');
  const r = run(d, ['ok.json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ERROR git add failed/);
  fs.unlinkSync(path.join(d, '.git', 'index.lock'));
  assert.deepEqual(staged(git), []);
});

test('a quoted glob is a literal name: live tracked files are not untracked', () => {
  const { d, git } = repo();
  fs.mkdirSync(path.join(d, 'data'));
  fs.writeFileSync(path.join(d, 'data/a.json'), '1');
  fs.writeFileSync(path.join(d, 'data/b.json'), '2');
  git('add', '.'); git('commit', '-qm', 'data');
  run(d, ['data/*.json']);
  run(d, [':(exclude)foo']);
  assert.deepEqual(staged(git), []);
});

test('paths with spaces and a leading -- work', () => {
  const { d, git } = repo();
  fs.writeFileSync(path.join(d, 'my file.json'), '1');
  const r = run(d, ['--', 'my file.json']);
  assert.equal(r.status, 0);
  assert.deepEqual(staged(git), ['A\tmy file.json']);
});
