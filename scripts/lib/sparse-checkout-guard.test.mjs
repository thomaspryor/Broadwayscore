// Regression: a write from a SPARSE review-texts clone must never "create" a
// file that already exists on origin but sits outside the sparse set
// (2026-09-25: the-children-2017/wsj--edward-rothstein.json was replaced
// wholesale this way, losing assignedScore 76 and its excerpts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isShowDirHiddenBySparseCheckout, isPathHiddenBySparseCheckout } = require('./sparse-checkout-guard.js');
const { safeWriteReview } = require('./review-write-guard.js');
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

const SCORED = {
  showId: 'hidden-show-2017', outletId: 'wsj', outlet: 'The Wall Street Journal',
  criticName: 'Edward Rothstein', url: 'https://www.wsj.com/articles/hidden-show-review-1',
  publishDate: '2017-12-14', fullText: 'x '.repeat(600), assignedScore: 76, contentTier: 'complete',
};

function makeRepos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-guard-'));
  const origin = path.join(base, 'origin');
  fs.mkdirSync(path.join(origin, 'visible-show-2026'), { recursive: true });
  fs.mkdirSync(path.join(origin, 'hidden-show-2017'), { recursive: true });
  fs.writeFileSync(path.join(origin, 'visible-show-2026', 'a--b.json'), '{}\n');
  fs.writeFileSync(path.join(origin, 'hidden-show-2017', 'wsj--edward-rothstein.json'), JSON.stringify(SCORED, null, 2));
  git(origin, 'init', '-q');
  git(origin, 'add', '-A');
  git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed');
  const sparse = path.join(base, 'sparse');
  git(base, 'clone', '-q', '--no-checkout', origin, sparse);
  git(sparse, 'sparse-checkout', 'set', 'visible-show-2026');
  git(sparse, 'checkout', '-q');
  const full = path.join(base, 'full');
  git(base, 'clone', '-q', origin, full);
  return { base, sparse, full };
}

test('directory check: hidden only when sparse AND tracked', () => {
  const { base, sparse, full } = makeRepos();
  try {
    assert.equal(fs.existsSync(path.join(sparse, 'hidden-show-2017')), false, 'fixture: dir absent in sparse clone');
    assert.equal(isShowDirHiddenBySparseCheckout(sparse, 'hidden-show-2017'), true);
    assert.equal(isShowDirHiddenBySparseCheckout(sparse, 'visible-show-2026'), false, 'present on disk');
    assert.equal(isShowDirHiddenBySparseCheckout(sparse, 'brand-new-show-2026'), false, 'genuinely new show');
    assert.equal(isShowDirHiddenBySparseCheckout(full, 'brand-new-show-2026'), false, 'non-sparse clone');
    assert.equal(isShowDirHiddenBySparseCheckout(base, 'anything'), false, 'not a git repo: fail open');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('safeWriteReview refuses to "create" a tracked file hidden by sparse checkout, even with force', () => {
  const { base, sparse } = makeRepos();
  try {
    const dir = path.join(sparse, 'hidden-show-2017');
    fs.mkdirSync(dir, { recursive: true }); // writers mkdir before writing
    const fp = path.join(dir, 'wsj--edward-rothstein.json');
    assert.equal(isPathHiddenBySparseCheckout(fp), true);
    const r = safeWriteReview(fp, { ...SCORED, assignedScore: undefined, contentTier: 'truncated', fullText: 'short' }, { merge: false, force: true });
    assert.equal(r.wrote, false);
    assert.equal(r.skipped, 'hidden-by-sparse-checkout');
    assert.equal(fs.existsSync(fp), false, 'nothing written');
    // A genuinely new file in the same sparse clone still writes.
    const fresh = path.join(sparse, 'visible-show-2026', 'new--critic.json');
    assert.equal(isPathHiddenBySparseCheckout(fresh), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a file deleted by hand INSIDE the sparse set stays writable (not "hidden")', () => {
  const { base, sparse } = makeRepos();
  try {
    const fp = path.join(sparse, 'visible-show-2026', 'a--b.json');
    fs.rmSync(fp);
    assert.equal(isPathHiddenBySparseCheckout(fp), false);
    const r = safeWriteReview(fp, { showId: 'visible-show-2026', outletId: 'a', criticName: 'B' }, { merge: false });
    assert.notEqual(r.skipped, 'hidden-by-sparse-checkout');
    assert.equal(fs.existsSync(fp), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('safeWriteReview refuses to overwrite a file whose on-disk copy has conflict markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-guard-'));
  try {
    const fp = path.join(dir, 'show-2026', 'thestage--unknown.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const conflicted = '{\n  "showId": "show-2026",\n<<<<<<< HEAD\n  "a": 1\n=======\n  "a": 2,\n  "humanReviewScore": 80\n>>>>>>> x\n}\n';
    fs.writeFileSync(fp, conflicted);
    const r = safeWriteReview(fp, { showId: 'show-2026', a: 1 }, { force: true });
    assert.equal(r.wrote, false);
    assert.equal(r.skipped, 'on-disk-conflict-markers');
    assert.equal(fs.readFileSync(fp, 'utf8'), conflicted, 'untouched');
    const r2 = safeWriteReview(fp, { showId: 'show-2026', a: 2, humanReviewScore: 80 }, { overwriteConflicted: true });
    assert.notEqual(r2.skipped, 'on-disk-conflict-markers', 'explicit repair allowed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createOrMergeReviewFile refuses (guardRefused) instead of creating over a hidden show dir', () => {
  const { base, sparse } = makeRepos();
  try {
    const r = createOrMergeReviewFile('hidden-show-2017', {
      outletId: 'wsj', outlet: 'The Wall Street Journal', criticName: 'Edward Rothstein',
      url: SCORED.url, source: 'submit-review-form', fields: { fullText: 'short text', publishDate: '2017-12-14' },
    }, { reviewTextsDir: sparse });
    assert.equal(r.action, 'skipped');
    assert.equal(r.reason, 'show-dir-outside-sparse-checkout');
    assert.equal(r.guardRefused, true);
    assert.equal(fs.existsSync(path.join(sparse, 'hidden-show-2017')), false, 'no directory or file created');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
