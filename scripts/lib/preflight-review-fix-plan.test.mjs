import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { copyUrlOwnerFolder } = require('./preflight-review-fix-plan.js');

// BRO-3065: a url repair proven by another show's folder holding the url must
// replay with that folder present, or preflight reports a false FAIL.
test('copyUrlOwnerFolder copies the folder that already holds the current url', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-src-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tmp-'));
  const url = 'https://www.whatsonstage.com/news/here-we-are-at-the-national-theatre-review_1676732/';
  fs.mkdirSync(path.join(src, 'blueberries-2026'));
  fs.writeFileSync(path.join(src, 'blueberries-2026', 'wos.json'), JSON.stringify({ url, publishDate: '2026-02-12' }));
  fs.mkdirSync(path.join(src, 'here-we-are-2025'));
  fs.writeFileSync(path.join(src, 'here-we-are-2025', 'wos--crompton.json'), JSON.stringify({ url }));
  const detect = (folder, u) => (u.includes('here-we-are') ? { matchedShowId: 'here-we-are-2025' } : null);
  const copied = new Set(['blueberries-2026']);
  copyUrlOwnerFolder(src, tmp, 'blueberries-2026/wos.json', copied, { detect });
  assert.ok(copied.has('here-we-are-2025'));
  assert.ok(fs.existsSync(path.join(tmp, 'here-we-are-2025', 'wos--crompton.json')));
  // nothing to copy when no other folder holds it
  const copied2 = new Set();
  copyUrlOwnerFolder(src, fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tmp-')), 'blueberries-2026/wos.json', copied2, { detect: () => null });
  assert.equal(copied2.size, 0);
});

// BRO-5386: a delete/move planned against a stale review-texts copy was refused at apply time.
test('fileOpSourceProblem fails a delete/move whose source is gone, and tracks earlier actions in the plan', () => {
  const { fileOpSourceProblem } = require('./preflight-review-fix-plan.js');
  const have = new Set(['a/x.json', 'a/y.json']);
  const exists = (rel) => have.has(rel);
  const removed = new Set(); const created = new Set();
  // present source passes
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/x.json' }, exists, removed, created), null);
  // the same file twice: the second delete finds it gone
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/x.json' }, exists, removed, created), /^Source not found/);
  // a move's destination can be the source of a later action
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'move', sourcePath: 'a/y.json', destPath: 'b/y.json' }, exists, removed, created), null);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'b/y.json' }, exists, removed, created), null);
  // a source that never existed (the real incident: already re-homed by another process)
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'move', sourcePath: 'cruise-west-end-2022/standard--nick-curtis.json', destPath: 'cruise-west-end-2021/standard--nick-curtis.json' }, exists, new Set(), new Set()), /Source not found/);
  // restore and field edits are not this check's business
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'restore', sourcePath: 'zzz/q.json' }, exists, new Set(), new Set()), null);
  assert.equal(fileOpSourceProblem({ type: 'review-field-edit', file: 'zzz/q.json' }, exists, new Set(), new Set()), null);
  // delete then restore of the same path (BRO-5373 shape): the restore puts it back, so a later move has a source
  const r2 = new Set(); const c2 = new Set();
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/y.json' }, exists, r2, c2), null);
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'move', sourcePath: 'a/y.json', destPath: 'c/y.json' }, exists, r2, c2), /^Source not found/);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'restore', sourcePath: 'a/y.json', fromCommit: 'abc' }, exists, r2, c2), null);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'move', sourcePath: 'a/y.json', destPath: 'c/y.json' }, exists, r2, c2), null);
});

test('preflight() reports a missing review-file-op source as a FAIL against a given tree', () => {
  const { preflight } = require('./preflight-review-fix-plan.js');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tree-'));
  fs.mkdirSync(path.join(tree, 'show-a'));
  fs.writeFileSync(path.join(tree, 'show-a', 'o--c.json'), '{}');
  const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-plan-')), 'p.json');
  fs.writeFileSync(planPath, JSON.stringify({ issueNumber: 'bro-x', status: 'pending', plan: { actions: [
    { type: 'review-file-op', operation: 'delete', sourcePath: 'show-a/o--c.json' },
    { type: 'review-file-op', operation: 'move', sourcePath: 'show-a/gone.json', destPath: 'show-b/gone.json' },
  ] } }));
  const lines = [];
  const { failed } = preflight([planPath], { reviewTextsDir: tree, log: (l) => lines.push(l) });
  assert.equal(failed, 1);
  assert.ok(lines.some((l) => /FAIL bro-x move show-a\/gone\.json: Source not found/.test(l)));
});

test('a rename is checked and tracked like a move (the executor treats them alike)', () => {
  const { fileOpSourceProblem } = require('./preflight-review-fix-plan.js');
  const exists = (rel) => rel === 'a/x.json';
  const removed = new Set(); const created = new Set();
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'rename', sourcePath: 'a/gone.json', destPath: 'a/z.json' }, exists, removed, created), /^Source not found/);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'rename', sourcePath: 'a/x.json', destPath: 'a/z.json' }, exists, removed, created), null);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/z.json' }, exists, removed, created), null);
});

// BRO-5386 regression: resolveReviewTextsDir() named /root/broadway-review-texts (HOME=/root) while the cloud clone is at
// /home/user/broadway-review-texts, so the preflight checked a directory that did not exist and FAILed every action.
test('pickReviewTextsTree skips a missing or empty directory and falls through to the first real tree', () => {
  const { pickReviewTextsTree } = require('./preflight-review-fix-plan.js');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-empty-'));
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-real-'));
  fs.mkdirSync(path.join(real, 'show-a'));
  const dotOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dot-'));
  fs.mkdirSync(path.join(dotOnly, '.git'));
  assert.equal(pickReviewTextsTree(['/nonexistent/broadway-review-texts', empty, dotOnly, real]), real);
  assert.equal(pickReviewTextsTree([real, empty]), real);
  // nothing usable: the data/review-texts default, never undefined
  assert.match(pickReviewTextsTree(['/nonexistent/a', empty]), /data[\\/]review-texts$/);
});

test('fileOpSourceProblem refuses a path that escapes the tree and normalizes ./ segments', () => {
  const { fileOpSourceProblem } = require('./preflight-review-fix-plan.js');
  const exists = (rel) => rel === 'a/x.json';
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: '../etc/passwd' }, exists, new Set(), new Set()), /escapes/);
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: '/abs/a.json' }, exists, new Set(), new Set()), /escapes/);
  const removed = new Set(); const created = new Set();
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/./x.json' }, exists, removed, created), null);
  // the normalized path is what was removed
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/x.json' }, exists, removed, created), /Source not found/);
});
