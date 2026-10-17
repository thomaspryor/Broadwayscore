// BRO-5261: one predicate for "is this file in a show dir a review?".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isReviewTextSidecar, isReviewTextFile } = require('./review-text-sidecars.js');
const { REJECTIONS_FILENAME } = require('./ingest-rejection-cache.js');
const { BLOCKLIST_FILENAME } = require('./poller-blocklist.js');

test('known sidecars are sidecars, reviews are reviews', () => {
  for (const f of [BLOCKLIST_FILENAME, REJECTIONS_FILENAME, 'failed-fetches.json', '_anything-new.json']) {
    assert.equal(isReviewTextSidecar(f), true, f);
    assert.equal(isReviewTextFile(f), false, f);
  }
  for (const f of ['nytimes--jesse-green.json', 'time-out--unknown.json']) {
    assert.equal(isReviewTextSidecar(f), false, f);
    assert.equal(isReviewTextFile(f), true, f);
  }
  assert.equal(isReviewTextFile('_notes.txt'), false);
  assert.equal(isReviewTextFile('.DS_Store'), false);
});

test('no show-dir reader skips one sidecar by name instead of the shared predicate', async () => {
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', "(!==|===) ?(BLOCKLIST_FILENAME|'_blocklist\\.json')", '--', 'scripts', ':!*.test.*'], { cwd: repo, encoding: 'utf8' });
  } catch (e) { if (e.status !== 1) throw e; }
  assert.equal(out.trim(), '', `use isReviewTextFile/isReviewTextSidecar (scripts/lib/review-text-sidecars.js):\n${out}`);
});
