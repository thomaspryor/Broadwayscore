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

// BRO-5342: ~186 readers filtered only `f !== 'failed-fetches.json'` and so read
// _blocklist.json / _ingest-rejections.json as reviews. Files below are the
// remaining by-name uses: dev test harnesses and simulators, not pipeline readers.
const FAILED_FETCHES_BY_NAME_OK = new Set([
  'scripts/llm-scoring/test-consistency.ts',
  'scripts/llm-scoring/test-prompt-variations.ts',
  'scripts/simulate-opening-night-full.sh',
  'scripts/simulate-opening-night.sh',
  'scripts/test-consistency.js',
  'scripts/test-content-verifier.js',
  'scripts/test-review-submission.js',
  'scripts/test-temporal-override-regression.js',
]);

test('no show-dir reader skips only failed-fetches.json by name', async () => {
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', "[!=]== ?'failed-fetches\\.json'", '--', 'scripts', ':!*.test.*', ':!scripts/lib/review-text-sidecars.js'], { cwd: repo, encoding: 'utf8' });
  } catch (e) { if (e.status !== 1) throw e; }
  const bad = out.split('\n').filter(l => l && !FAILED_FETCHES_BY_NAME_OK.has(l.split(':')[0]));
  assert.deepEqual(bad, [], `use isReviewTextFile from scripts/lib/review-text-sidecars.js:\n${bad.join('\n')}`);
});
