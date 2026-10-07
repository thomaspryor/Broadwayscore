// BRO-4243: per-show backoff for the paid Google Images tier in
// fetch-show-images-auto.js. Tests require() the real helper (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  shouldSkipGoogleImages, recordGoogleImagesAttempt, loadImageSearchAttempts, saveImageSearchAttempts, BACKOFF_DAYS,
} = require('./image-search-backoff.js');

const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.parse('2026-09-28T12:00:00Z');

test('no entry or zero failures never skips', () => {
  assert.equal(shouldSkipGoogleImages(undefined, t0).skip, false);
  assert.equal(shouldSkipGoogleImages({ failures: 0, lastAttempt: '2026-09-28T11:00:00Z' }, t0).skip, false);
  assert.equal(shouldSkipGoogleImages({ failures: 2, lastAttempt: 'garbage' }, t0).skip, false, 'unparseable time fails open');
});

test('backoff grows 1, 2, 4, 8, 14 days and caps', () => {
  for (let f = 1; f <= BACKOFF_DAYS.length + 2; f++) {
    const days = BACKOFF_DAYS[Math.min(f, BACKOFF_DAYS.length) - 1];
    const entry = { failures: f, lastAttempt: new Date(t0).toISOString() };
    assert.equal(shouldSkipGoogleImages(entry, t0 + days * DAY - 1).skip, true, `f=${f} just inside window`);
    assert.equal(shouldSkipGoogleImages(entry, t0 + days * DAY).skip, false, `f=${f} window elapsed`);
  }
});

test('a show re-searched every run (the 2026-09-28 pattern) is skipped on the next run', () => {
  let attempts = recordGoogleImagesAttempt({}, 'babymother-3', false, t0);
  // fetch-all-image-formats runs ~5h later
  assert.equal(shouldSkipGoogleImages(attempts['babymother-3'], t0 + 5 * 60 * 60 * 1000).skip, true);
  attempts = recordGoogleImagesAttempt(attempts, 'babymother-3', false, t0 + 2 * DAY);
  assert.equal(attempts['babymother-3'].failures, 2);
  // success clears it
  attempts = recordGoogleImagesAttempt(attempts, 'babymother-3', true, t0 + 5 * DAY);
  assert.equal(attempts['babymother-3'], undefined);
});

test('recordGoogleImagesAttempt does not mutate its input', () => {
  const orig = { a: { failures: 1, lastAttempt: '2026-09-27T00:00:00Z' } };
  recordGoogleImagesAttempt(orig, 'a', false, t0);
  assert.deepEqual(orig, { a: { failures: 1, lastAttempt: '2026-09-27T00:00:00Z' } });
});

test('never skips within ±14 days of openingDate (art usually appears around opening)', () => {
  const entry = { failures: 5, lastAttempt: new Date(t0).toISOString() }; // deep in backoff
  const now = t0 + DAY;
  assert.equal(shouldSkipGoogleImages(entry, now, { openingDate: '2026-10-05' }).skip, false, '6 days before opening');
  assert.equal(shouldSkipGoogleImages(entry, now, { openingDate: '2026-09-20' }).skip, false, '9 days after opening');
  assert.equal(shouldSkipGoogleImages(entry, now, { openingDate: '2026-12-01' }).skip, true, 'far from opening');
  assert.equal(shouldSkipGoogleImages(entry, now, { openingDate: null }).skip, true, 'no opening date');
  assert.equal(shouldSkipGoogleImages(entry, now, { previewsStartDate: '2026-10-02' }).skip, false, 'previews start, no opening date yet');
  assert.equal(shouldSkipGoogleImages(entry, now, { previewsStartDate: '2026-11-20', openingDate: '2026-12-10' }).skip, true, 'both dates far off');
  assert.equal(shouldSkipGoogleImages(entry, now, null).skip, true, 'no show passed');
});

test('load tolerates missing/corrupt files; save round-trips sorted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-backoff-'));
  const p = path.join(dir, 'a.json');
  assert.deepEqual(loadImageSearchAttempts(p), {});
  fs.writeFileSync(p, 'not json');
  assert.deepEqual(loadImageSearchAttempts(p), {});
  saveImageSearchAttempts({ z: { failures: 1, lastAttempt: 'x' }, a: { failures: 2, lastAttempt: 'y' } }, p);
  assert.deepEqual(Object.keys(loadImageSearchAttempts(p)), ['a', 'z']);
  fs.rmSync(dir, { recursive: true, force: true });
});
