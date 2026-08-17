/**
 * Which review-texts clone does a WRITING repair tool target?
 *
 * Two checkouts exist on a dev machine: the nested data/review-texts the repo
 * actually reads, and a legacy ~/broadway-review-texts several older scripts
 * still default to. On 2026-08-17 they were 143+ commits apart, and the repair
 * tool — which writes — defaulted to the legacy one. It reported "1 cycle found"
 * for a show whose cycle had already been fixed in the real clone: a tool
 * silently operating on, and able to write to, the wrong copy while reporting
 * success.
 *
 * Run: node --test tests/unit/review-texts-dir-resolution.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveReviewTextsDir } = require('../../scripts/lib/review-texts-dir.js');

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rt-resolve-'));

test('review-texts resolution — an explicit env var always wins', () => {
  const repo = tmp();
  mkdirSync(path.join(repo, 'data', 'review-texts'), { recursive: true });
  assert.equal(
    resolveReviewTextsDir({ REVIEW_TEXTS_DIR: '/explicit/path' }, repo, '/home/someone'),
    '/explicit/path',
    'an operator naming the directory is never overridden',
  );
});

test('review-texts resolution — prefers the repo checkout the rest of the pipeline reads', () => {
  const repo = tmp();
  const home = tmp();
  mkdirSync(path.join(repo, 'data', 'review-texts'), { recursive: true });
  mkdirSync(path.join(home, 'broadway-review-texts'), { recursive: true });
  assert.equal(
    resolveReviewTextsDir({}, repo, home),
    path.join(repo, 'data', 'review-texts'),
    'when BOTH clones exist, the nested one wins — it is what validate-review-texts.js reads',
  );
});

test('review-texts resolution — falls back to the legacy clone when there is no nested one', () => {
  const repo = tmp(); // deliberately no data/review-texts (this is what a worktree looks like)
  const home = tmp();
  assert.equal(
    resolveReviewTextsDir({}, repo, home),
    path.join(home, 'broadway-review-texts'),
    'a worktree has no nested clone, so the legacy path must still work',
  );
});

test('review-texts resolution — the resolver is a leaf module with no CLI side effects', () => {
  // It lives in scripts/lib/ precisely so a test can require it without the
  // repair CLI's "Refusing to run unscoped" exit(2) firing on import.
  assert.equal(typeof resolveReviewTextsDir, 'function');
});
