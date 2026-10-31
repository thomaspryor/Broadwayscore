// BRO-5133: restore a review-texts file from git history (execute-approved-fix review-file-op "restore").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { restoreReviewFileFromCommit } = require('./review-file-restore.js');

function repoWithDeletedFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'show-a'));
  const rec = { showId: 'show-a', url: 'https://example.com/review', outletId: 'vulture', criticName: 'A B', fullText: 'text '.repeat(50) };
  fs.writeFileSync(path.join(dir, 'show-a', 'vulture--a-b.json'), JSON.stringify(rec));
  g('add', '-A'); g('commit', '-qm', 'add');
  fs.unlinkSync(path.join(dir, 'show-a', 'vulture--a-b.json'));
  g('add', '-A'); g('commit', '-qm', 'delete');
  const head = g('rev-parse', 'HEAD');
  // Local history stands in for the CI fetch.
  const git = (args) => (args[0] === 'fetch' ? '' : execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }));
  return { dir, head, rec, git };
}

test('restores a deleted file from <sha>^ with its text intact', () => {
  const { dir, head, rec, git } = repoWithDeletedFile();
  const r = restoreReviewFileFromCommit(dir, { sourcePath: 'show-a/vulture--a-b.json', fromCommit: `${head}^` }, { git });
  assert.equal(r.ok, true, r.reason);
  const back = JSON.parse(fs.readFileSync(path.join(dir, 'show-a', 'vulture--a-b.json'), 'utf8'));
  assert.equal(back.fullText, rec.fullText);
  assert.equal(back.url, rec.url);
});

test('a restore into another show folder carries that show id (BRO-5285)', () => {
  const { dir, head, rec, git } = repoWithDeletedFile();
  const r = restoreReviewFileFromCommit(dir, { sourcePath: 'show-a/vulture--a-b.json', fromCommit: `${head}^`, destPath: 'show-b/vulture--a-b.json' }, { git });
  assert.equal(r.ok, true, r.reason);
  const back = JSON.parse(fs.readFileSync(path.join(dir, 'show-b', 'vulture--a-b.json'), 'utf8'));
  assert.equal(back.showId, 'show-b');
  assert.equal(back.fullText, rec.fullText);
  assert.equal(fs.existsSync(path.join(dir, 'show-a', 'vulture--a-b.json')), false);
});

test('refuses short shas, existing destinations and path escapes', () => {
  const { dir, head, git } = repoWithDeletedFile();
  assert.equal(restoreReviewFileFromCommit(dir, { sourcePath: 'show-a/vulture--a-b.json', fromCommit: head.slice(0, 9) }, { git }).ok, false);
  assert.equal(restoreReviewFileFromCommit(dir, { sourcePath: '../x.json', fromCommit: `${head}^` }, { git }).ok, false);
  fs.writeFileSync(path.join(dir, 'show-a', 'vulture--a-b.json'), '{}');
  const r = restoreReviewFileFromCommit(dir, { sourcePath: 'show-a/vulture--a-b.json', fromCommit: `${head}^` }, { git });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already exists/);
});

test('a path missing at that commit fails cleanly', () => {
  const { dir, head, git } = repoWithDeletedFile();
  const r = restoreReviewFileFromCommit(dir, { sourcePath: 'show-a/nope.json', fromCommit: `${head}^` }, { git });
  assert.equal(r.ok, false);
  assert.match(r.reason, /git could not read/);
});
