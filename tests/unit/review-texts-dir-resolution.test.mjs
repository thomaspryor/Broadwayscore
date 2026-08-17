/**
 * Which review-texts clone does a WRITING repair tool target?
 *
 * Two checkouts exist and are not the same tree: <main>/data/review-texts (what
 * the pipeline reads) and a legacy ~/broadway-review-texts. On 2026-08-17 they
 * were 143+ commits apart and a writing tool defaulted to the legacy one.
 *
 * THE FIRST FIX WAS WORSE THAN THE BUG, and a code review caught it by executing
 * the resolver against this machine's 32 real worktrees. Its existence-only
 * check accepted an EMPTY directory — three worktrees here have one — so the
 * tool printed "0 cycles found" and exited 0: a false all-clear. And because
 * data/review-texts is gitignored it lives in the MAIN checkout, so inside a
 * worktree (where CLAUDE.md mandates every scripts/ edit happens) the resolver
 * fell straight back to the stale legacy clone.
 *
 * The earlier version of this suite ASSERTED that worktree fallback as correct —
 * it locked the bug in and stayed green. These cases cover the states that
 * actually exist on disk.
 *
 * Run: node --test tests/unit/review-texts-dir-resolution.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveReviewTextsDir, isReviewTextsCheckout } = require('../../scripts/lib/review-texts-dir.js');

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rt-resolve-'));
/** A directory that looks like a real clone: has .git and content. */
const makeCheckout = (root) => {
  const d = path.join(root, 'data', 'review-texts');
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, '.git'), 'gitdir: /somewhere\n');
  mkdirSync(path.join(d, 'some-show-2026'), { recursive: true });
  return d;
};
/** An empty plain directory — the shape that produced the false all-clear. */
const makeEmptyDir = (root) => {
  const d = path.join(root, 'data', 'review-texts');
  mkdirSync(d, { recursive: true });
  return d;
};
/** A plain COPY with content but no .git — the stale-throwaway shape. */
const makePlainCopy = (root) => {
  const d = path.join(root, 'data', 'review-texts');
  mkdirSync(path.join(d, 'some-show-2026'), { recursive: true });
  return d;
};
const noMain = () => null;

test('review-texts resolution — an explicit env var always wins', () => {
  const repo = tmp();
  makeCheckout(repo);
  assert.equal(
    resolveReviewTextsDir({ REVIEW_TEXTS_DIR: '/explicit/path' }, repo, '/home/someone', { mainWorktree: noMain }),
    '/explicit/path',
    'an operator naming the directory is never overridden',
  );
});

test('review-texts resolution — prefers a real checkout at the repo root', () => {
  const repo = tmp();
  const home = tmp();
  const nested = makeCheckout(repo);
  makeCheckout(path.join(home, 'broadway-review-texts-parent'));
  assert.equal(
    resolveReviewTextsDir({}, repo, home, { mainWorktree: noMain }),
    nested,
    'a real nested clone wins over the legacy path',
  );
});

test('review-texts resolution — an EMPTY nested dir is NOT a checkout (the false all-clear)', () => {
  // Three worktrees on this machine carry exactly this shape. Accepting it made
  // the tool report a clean corpus for a directory containing nothing.
  const repo = tmp();
  const home = tmp();
  makeEmptyDir(repo);
  assert.equal(isReviewTextsCheckout(path.join(repo, 'data', 'review-texts')), false);
  assert.equal(
    resolveReviewTextsDir({}, repo, home, { mainWorktree: noMain }),
    path.join(home, 'broadway-review-texts'),
    'an empty dir must be skipped, not silently adopted',
  );
});

test('review-texts resolution — a plain COPY with no .git is NOT a checkout (the stale-throwaway)', () => {
  // job-805-mscboo6t had 1994 show dirs vs the real clone's 2016. --apply there
  // writes repairs nothing ever commits, and reports success.
  const repo = tmp();
  const home = tmp();
  makePlainCopy(repo);
  assert.equal(isReviewTextsCheckout(path.join(repo, 'data', 'review-texts')), false);
  assert.equal(
    resolveReviewTextsDir({}, repo, home, { mainWorktree: noMain }),
    path.join(home, 'broadway-review-texts'),
  );
});

test('review-texts resolution — from a WORKTREE, falls forward to the main checkout, not back to legacy', () => {
  // The bug the previous suite asserted as correct. data/review-texts is
  // gitignored, so a worktree has none; the clone is in the main checkout.
  const worktree = tmp();
  const main = tmp();
  const home = tmp();
  const realClone = makeCheckout(main);
  assert.equal(
    resolveReviewTextsDir({}, worktree, home, { mainWorktree: () => main }),
    realClone,
    'a worktree must reach the main checkout, NOT the stale legacy clone',
  );
});

test('review-texts resolution — the main checkout is only used when it really has a clone', () => {
  const worktree = tmp();
  const main = tmp(); // main exists but has no data/review-texts
  const home = tmp();
  assert.equal(
    resolveReviewTextsDir({}, worktree, home, { mainWorktree: () => main }),
    path.join(home, 'broadway-review-texts'),
    'no clone anywhere -> legacy fallback still works',
  );
});

test('review-texts resolution — main-worktree lookup identical to repoRoot is not consulted twice', () => {
  const repo = tmp();
  const home = tmp();
  makeEmptyDir(repo);
  assert.equal(
    resolveReviewTextsDir({}, repo, home, { mainWorktree: () => repo }),
    path.join(home, 'broadway-review-texts'),
  );
});

test('review-texts resolution — isReviewTextsCheckout tolerates a missing path', () => {
  assert.equal(isReviewTextsCheckout('/definitely/not/here'), false);
});

test('review-texts resolution — the resolver is a leaf module with no CLI side effects', () => {
  // It lives in scripts/lib/ precisely so a test can require it without the
  // repair CLI's "Refusing to run unscoped" exit(2) firing on import.
  assert.equal(typeof resolveReviewTextsDir, 'function');
});
