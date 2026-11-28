// stage-review-texts.js (BRO-7171) against a real temp review-texts repo.
// Every CI writer used to run a whole-tree `git add -A`, which committed
// whatever sat in the checkout (screenshots, *.mergetmp, hidden temp files).
// The helper stages tracked changes (deletions and the stray-symlink removal
// included) plus new review JSON and lane-recordings, nothing else.
// Run: node --test scripts/lib/stage-review-texts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stageReviewTexts, isStageableNewPath } = require('./stage-review-texts.js');
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), 'stage-review-texts.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com' };
Object.assign(process.env, env);

function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-rt-')));
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'show-2026'));
  fs.writeFileSync(path.join(repo, 'show-2026', 'nytimes--a.json'), '{"fullText":"a"}\n');
  fs.writeFileSync(path.join(repo, 'show-2026', 'variety--b.json'), '{"fullText":"b"}\n');
  fs.mkdirSync(path.join(repo, 'aggregator-archive'));
  fs.writeFileSync(path.join(repo, 'aggregator-archive', 'page.html'), '<p>old</p>\n');
  fs.symlinkSync('/nonexistent/abs/path', path.join(repo, 'broadway-review-texts'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}
const staged = (repo) => git(repo, 'diff', '--cached', '--name-status').trim().split('\n').filter(Boolean).sort();

test('stages tracked edits, deletions, new review JSON and lane recordings; leaves strays out', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'show-2026', 'nytimes--a.json'), '{"fullText":"longer a"}\n'); // tracked edit
  fs.unlinkSync(path.join(repo, 'show-2026', 'variety--b.json')); // tracked deletion
  fs.unlinkSync(path.join(repo, 'broadway-review-texts')); // stray tracked symlink removed (push-review-texts)
  fs.writeFileSync(path.join(repo, 'aggregator-archive', 'page.html'), '<p>new</p>\n'); // tracked non-JSON edit
  fs.mkdirSync(path.join(repo, '_pending', 'show-2026'), { recursive: true });
  fs.writeFileSync(path.join(repo, '_pending', 'show-2026', 'new--c.json'), '{}\n'); // new review JSON
  fs.mkdirSync(path.join(repo, 'lane-recordings', 'show-2026', '2026-11-09', 'serp'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'lane-recordings', 'show-2026', '2026-11-09', 'serp', 'r1.json.gz'), 'gz');
  fs.writeFileSync(path.join(repo, 'lane-recordings', 'show-2026', '2026-11-09', 'index.jsonl'), '{}\n');
  // Strays a crashed step or a local session leaves behind:
  fs.writeFileSync(path.join(repo, 'tony-1.png'), 'png');
  fs.writeFileSync(path.join(repo, 'show-2026', 'nytimes--a.json.mergetmp'), 'x');
  fs.mkdirSync(path.join(repo, '.playwright-mcp'));
  fs.writeFileSync(path.join(repo, '.playwright-mcp', 'console.json'), '{}');
  fs.writeFileSync(path.join(repo, 'show-2026', '.tmp-123.json'), '{}');

  const { added, skipped } = stageReviewTexts(repo);
  assert.deepEqual(staged(repo), [
    'A\t_pending/show-2026/new--c.json',
    'A\tlane-recordings/show-2026/2026-11-09/index.jsonl',
    'A\tlane-recordings/show-2026/2026-11-09/serp/r1.json.gz',
    'D\tbroadway-review-texts',
    'D\tshow-2026/variety--b.json',
    'M\taggregator-archive/page.html',
    'M\tshow-2026/nytimes--a.json',
  ]);
  assert.equal(added.length, 3);
  assert.deepEqual(skipped.sort(), ['.playwright-mcp/console.json', 'show-2026/.tmp-123.json', 'show-2026/nytimes--a.json.mergetmp', 'tony-1.png']);
});

test('CLI stages from cwd, reports counts on stderr, exits 0; exits 1 outside a repo', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'show-2026', 'new--d.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'stray.png'), 'png');
  const r = spawnSync(process.execPath, [CLI], { cwd: repo, encoding: 'utf8', env: { ...process.env } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /staged 1 new file/);
  assert.match(r.stderr, /left 1 untracked non-content file/);
  assert.deepEqual(staged(repo), ['A\tshow-2026/new--d.json']);
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-norepo-'));
  assert.equal(spawnSync(process.execPath, [CLI, notRepo], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(notRepo) } }).status, 1);
});

test('isStageableNewPath', () => {
  assert.equal(isStageableNewPath('show/x--y.json'), true);
  assert.equal(isStageableNewPath('failed-fetches.json'), true);
  assert.equal(isStageableNewPath('lane-recordings/s/n/k/a.json.gz'), true);
  assert.equal(isStageableNewPath('show/x.png'), false);
  assert.equal(isStageableNewPath('other/x.gz'), false, 'gz only under lane-recordings/');
  assert.equal(isStageableNewPath('.claude/visual-qa/x.json'), false);
});
