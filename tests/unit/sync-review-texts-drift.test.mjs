import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syncDrift, selectFilesToSync, showIdsFromPaths, main } = require('../../scripts/sync-review-texts-drift.js');

// Real git repos, no mocks: an "upstream" bare repo, a writer clone that
// pushes concurrently, and the job's shallow clone the guard runs against.
function sh(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}
function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-drift-'));
  const bare = path.join(root, 'upstream.git');
  const writer = path.join(root, 'writer');
  const job = path.join(root, 'job');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, writer]);
  sh(writer, 'checkout', '-q', '-b', 'main');
  write(writer, 'show-a/outlet--critic.json', '{"v":1}');
  write(writer, 'show-b/outlet--critic.json', '{"v":1}');
  write(writer, 'show-c/old.json', '{"v":1}');
  sh(writer, 'add', '-A'); sh(writer, 'commit', '-qm', 'init'); sh(writer, '-c', 'push.negotiate=false', 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${bare}`, job]);
  const checkoutSha = sh(job, 'rev-parse', 'HEAD');
  return { root, writer, job, checkoutSha };
}
function push(writer, files, del = []) {
  for (const [rel, c] of Object.entries(files)) write(writer, rel, c);
  for (const rel of del) fs.rmSync(path.join(writer, rel));
  sh(writer, 'add', '-A'); sh(writer, 'commit', '-qm', 'concurrent'); sh(writer, '-c', 'push.negotiate=false', 'push', '-q', 'origin', 'main');
}

test('pure helpers', () => {
  assert.deepEqual(showIdsFromPaths(['b/x.json', 'a/y.json', 'a/z.json', 'README.md']), ['a', 'b']);
  assert.deepEqual(selectFilesToSync(['a/1', 'a/2', 'b/1'], ['a/2']), ['a/1', 'b/1']);
});

test('no drift: nothing synced, no shows', () => {
  const { job, checkoutSha } = setup();
  const r = syncDrift({ dir: job, checkoutSha });
  assert.equal(r.drifted, false);
  assert.deepEqual(r.showIds, []);
});

test('drift: concurrent new review lands locally, job-written files are never clobbered', () => {
  const { writer, job, checkoutSha } = setup();
  // The job scrapes: modifies a tracked file and adds a new one.
  write(job, 'show-b/outlet--critic.json', '{"v":"job"}');
  write(job, 'show-d/new--critic.json', '{"v":"job"}');
  // Meanwhile another workflow pushes: a brand-new review, an edit to the
  // same file the job modified, a colliding new path, and a deletion.
  push(writer, {
    'show-a/new-outlet--critic.json': '{"v":"upstream"}',
    'show-b/outlet--critic.json': '{"v":"upstream"}',
    'show-d/new--critic.json': '{"v":"upstream"}',
  }, ['show-c/old.json']);

  const r = syncDrift({ dir: job, checkoutSha });
  assert.equal(r.drifted, true);
  assert.deepEqual(r.showIds, ['show-a', 'show-b', 'show-c', 'show-d']);
  assert.deepEqual(r.synced, ['show-a/new-outlet--critic.json']);
  assert.deepEqual(r.skippedLocal.sort(), ['show-b/outlet--critic.json', 'show-d/new--critic.json']);
  assert.equal(fs.readFileSync(path.join(job, 'show-a/new-outlet--critic.json'), 'utf8'), '{"v":"upstream"}');
  assert.equal(fs.readFileSync(path.join(job, 'show-b/outlet--critic.json'), 'utf8'), '{"v":"job"}');
  assert.equal(fs.readFileSync(path.join(job, 'show-d/new--critic.json'), 'utf8'), '{"v":"job"}');
});

test('drift: files the job committed locally since checkout are kept too', () => {
  const { writer, job, checkoutSha } = setup();
  write(job, 'show-a/outlet--critic.json', '{"v":"job-committed"}');
  sh(job, 'add', '-A');
  execFileSync('git', ['-C', job, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'job']);
  push(writer, { 'show-a/outlet--critic.json': '{"v":"upstream"}', 'show-b/x--y.json': '{}' });
  const r = syncDrift({ dir: job, checkoutSha });
  assert.deepEqual(r.synced, ['show-b/x--y.json']);
  assert.equal(fs.readFileSync(path.join(job, 'show-a/outlet--critic.json'), 'utf8'), '{"v":"job-committed"}');
});

test('CLI: writes shows file on drift; fails open (exit 0, empty file) on git error or missing SHA', () => {
  const { root, writer, job, checkoutSha } = setup();
  push(writer, { 'show-a/new--x.json': '{}' });
  const showsFile = path.join(root, 'shows.txt');
  assert.equal(main([`--dir=${job}`, `--checkout-sha=${checkoutSha}`, `--shows-file=${showsFile}`], {}), 0);
  assert.equal(fs.readFileSync(showsFile, 'utf8'), 'show-a\n');

  // Recorded-SHA file path (what checkout-review-texts writes).
  fs.writeFileSync(path.join(root, 'review-texts-checkout-sha'), `${checkoutSha}\n`);
  assert.equal(main([`--dir=${job}`, `--shows-file=${showsFile}`], { RUNNER_TEMP: root }), 0);
  assert.equal(fs.readFileSync(showsFile, 'utf8'), 'show-a\n');

  assert.equal(main([`--dir=${path.join(root, 'nope')}`, `--checkout-sha=${checkoutSha}`, `--shows-file=${showsFile}`], {}), 0);
  assert.equal(fs.readFileSync(showsFile, 'utf8'), '');

  fs.writeFileSync(showsFile, 'stale\n');
  assert.equal(main([`--dir=${job}`, `--shows-file=${showsFile}`], { RUNNER_TEMP: path.join(root, 'empty') }), 0);
  assert.equal(fs.readFileSync(showsFile, 'utf8'), '');
});
