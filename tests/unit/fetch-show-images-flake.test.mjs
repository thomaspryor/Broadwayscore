import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { recordImageFetchOutcome, imageFetchRunHealth } = require('../../scripts/lib/image-fetch-outcome');
const freshResults = () => ({ success: [], failed: [], unavailable: [], skipped: [] });
const show = (status, title = 'A show') => ({ id: 'a-show', title, status });
const fulfilled = value => ({ status: 'fulfilled', value });

test('announced and upcoming shows with no usable art are visible misses, not failures', () => {
  const results = freshResults();
  for (const status of ['announced', 'upcoming']) {
    const row = show(status, status);
    recordImageFetchOutcome(results, row, fulfilled({ show: row, images: null }));
  }
  assert.deepEqual(results.unavailable, ['announced', 'upcoming']);
  assert.deepEqual(results.failed, []);
});

test('five recorded BRO-7550 run mixes tolerate future-show misses', () => {
  // Conservative replay: unmatched titles remain failures. Future status
  // counts were checked against the real shows.json, not inferred from URLs.
  for (const [run, success, failures, future] of [
    [43730492467, 42, 3, 46],
    [43608210732, 33, 3, 55],
    [43460547281, 31, 3, 53],
    [43264297890, 33, 3, 50],
    [43238611662, 30, 3, 48],
  ]) {
    const results = freshResults();
    for (let i = 0; i < success + failures + future; i++) {
      const row = show(i < success + failures ? 'open' : 'upcoming');
      recordImageFetchOutcome(results, row, fulfilled({ show: row, images: i < success ? { poster: 'art.webp' } : null }));
    }
    assert.equal(results.failed.length, failures, `run ${run}`);
    assert.equal(results.unavailable.length, future, `run ${run}`);
    assert.equal(imageFetchRunHealth(results).exitCode, 0, `run ${run}`);
  }
});

test('open, previews, closed and unknown statuses retain failure handling for missing art', () => {
  const results = freshResults();
  for (const status of ['open', 'previews', 'closed', undefined]) {
    const row = show(status);
    recordImageFetchOutcome(results, row, fulfilled({ show: row, images: null }));
  }
  assert.equal(results.failed.length, 4);
  assert.equal(results.unavailable.length, 0);
});

test('operational errors on future shows remain failures and identify the correct batch member', () => {
  const results = freshResults();
  const logs = [];
  const row = show('upcoming', 'Second show in batch');
  recordImageFetchOutcome(results, row, { status: 'rejected', reason: new Error('fetch timed out') }, m => logs.push(m));
  recordImageFetchOutcome(results, show('announced', 'Search outage'), fulfilled({ images: null, searchErrored: true }));
  assert.deepEqual(results.failed, ['Second show in batch', 'Search outage']);
  assert.deepEqual(results.unavailable, []);
  assert.match(logs.join('\n'), /Second show in batch.*fetch timed out/);
});

test('pinned skips are excluded from the gate and real successes still count in either phase', () => {
  const results = freshResults();
  recordImageFetchOutcome(results, show('open', 'Pinned'), fulfilled(null));
  recordImageFetchOutcome(results, show('upcoming', 'Art ready'), fulfilled({ images: { thumbnail: 'art.webp' } }));
  assert.deepEqual(results.skipped, ['Pinned']);
  assert.deepEqual(results.success, ['Art ready']);
  assert.deepEqual(results.failed, []);
});

test('a total failure still fails even if all results are future shows without art', () => {
  const results = freshResults();
  results.unavailable = Array(10).fill('Future show');
  assert.equal(imageFetchRunHealth(results).exitCode, 1);
  results.unavailable = [];
  results.failed = Array(10).fill('Outage');
  assert.equal(imageFetchRunHealth(results).exitCode, 1);
});

test('future-show misses cannot dilute the operational failure threshold', () => {
  const results = freshResults();
  results.success = Array(4).fill('OK');
  results.failed = Array(6).fill('Outage');
  results.unavailable = Array(90).fill('Future');
  assert.equal(imageFetchRunHealth(results).exitCode, 1);
  results.success = Array(5).fill('OK');
  results.failed = Array(5).fill('Miss');
  assert.equal(imageFetchRunHealth(results).exitCode, 0, 'original 50% boundary');
});

test('empty and all-pinned runs succeed; small misses retain the original ten-show sample gate', () => {
  const results = freshResults();
  assert.equal(imageFetchRunHealth(results).exitCode, 0);
  results.skipped = Array(10).fill('Pinned');
  assert.equal(imageFetchRunHealth(results).exitCode, 0);
  results.failed = Array(9).fill('Miss');
  assert.equal(imageFetchRunHealth(results).exitCode, 0);
  results.failed.push('Miss');
  assert.equal(imageFetchRunHealth(results).exitCode, 1);
});

test('both fetch phases use the outcome helper and the exit gate uses its health result', () => {
  const src = readFileSync(new URL('../../scripts/fetch-show-images-auto.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/lib\/image-fetch-outcome'\)/);
  assert.match(src, /recordImageFetchOutcome\(results, show, \{ status: 'fulfilled', value: result \}/);
  assert.match(src, /recordImageFetchOutcome\(results, batch\[index\], settled/);
  assert.match(src, /fetchShowImages\(show, todayTixInfo, apiData, verifyCtx, fetchOutcome\)/);
  assert.match(src, /if \(googleErrored\) fetchOutcome\.searchErrored = true/);
  assert.match(src, /searchErrored: fetchOutcome\.searchErrored/);
  assert.match(src, /const health = imageFetchRunHealth\(results\)/);
  assert.match(src, /process\.exit\(health\.exitCode\)/);
});
