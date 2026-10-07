// BRO-4323: Weekly Video Reviews went 0/514 on transcripts for six weeks and
// stayed green. require()s the real decision functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectTranscriptOutages, findStaleCreators, isVideoSpecificError } = require('../../scripts/lib/video-pipeline-health.js');

test('the 2026-09-28 run (0 extracted, every attempt errored) is an outage', () => {
  assert.deepEqual(
    detectTranscriptOutages({ tiktok: { attempted: 400, extracted: 0, errored: 400 }, youtube: { attempted: 114, extracted: 0, errored: 114 } }),
    ['tiktok', 'youtube'],
  );
});

test('caption-less videos alone are not an outage', () => {
  assert.deepEqual(detectTranscriptOutages({ tiktok: { attempted: 50, extracted: 0, errored: 0 } }), []);
});

test('one success on a platform clears it', () => {
  assert.deepEqual(detectTranscriptOutages({ tiktok: { attempted: 50, extracted: 1, errored: 49 } }), []);
});

test('a handful of errors is below the threshold', () => {
  assert.deepEqual(detectTranscriptOutages({ youtube: { attempted: 3, extracted: 0, errored: 3 } }), []);
});

test('only the broken platform is reported', () => {
  assert.deepEqual(
    detectTranscriptOutages({ tiktok: { attempted: 30, extracted: 12, errored: 5 }, youtube: { attempted: 20, extracted: 0, errored: 20 } }),
    ['youtube'],
  );
});

test('stale creator scans are flagged, fresh ones are not', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const stale = findStaleCreators([
    { handle: 'fresh', scannedAt: '2026-09-28T10:42:00Z' },
    { handle: 'oneMissed', scannedAt: '2026-09-21T09:47:15Z' },
    { handle: 'twoMissed', scannedAt: '2026-09-07T09:00:00Z' },
    { handle: 'never' },
  ], now);
  assert.deepEqual(stale.map(s => s.handle), ['twoMissed', 'never']);
  assert.equal(stale[0].ageDays, 21);
});

test('dead-video errors are video-specific; extractor breakage is not', () => {
  for (const e of [
    'ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader',
    'ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video',
    'ERROR: [youtube] abc: Join this channel to get access to members-only content like this video',
    'ERROR: [TikTok] 123: This post is unavailable',
  ]) assert.equal(isVideoSpecificError(e), true, e);
  for (const e of [
    'ERROR: [TikTok] 7689696072578501901: Unexpected response from webpage request; please report this issue',
    "ERROR: [youtube] -s0nkIWAiqw: Sign in to confirm you're not a bot. Use --cookies-from-browser",
    'ERROR: [tiktok:user] tylernabinger: Failed to parse JSON',
  ]) assert.equal(isVideoSpecificError(e), false, e);
});
