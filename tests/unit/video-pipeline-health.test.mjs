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

// BRO-5366: a TikTok profile listing that fails once must be retried.
const { runWithRetries, scanErrorLine } = require('../../scripts/lib/video-pipeline-health.js');

test('runWithRetries recovers from a transient failure and pauses between attempts', () => {
  const pauses = [];
  let calls = 0;
  const r = runWithRetries(() => { if (++calls < 3) throw new Error('boom'); return 'ok'; }, { pause: n => pauses.push(n) });
  assert.deepEqual(r, { ok: true, value: 'ok', attempts: 3 });
  assert.deepEqual(pauses, [1, 2]);
});

test('runWithRetries gives up after the last attempt and reports the yt-dlp ERROR line', () => {
  const err = Object.assign(new Error('Command failed: yt-dlp ...'), { stdout: 'x\nERROR: ashley: Failed to parse JSON\n' });
  const r = runWithRetries(() => { throw err; }, { attempts: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 2);
  assert.match(r.error, /Failed to parse JSON/);
  assert.equal(scanErrorLine(new Error('plain\nsecond')), 'plain');
});

test('runWithRetries does not retry a timeout and never pauses after the last attempt', () => {
  let calls = 0;
  const t = runWithRetries(() => { calls++; throw Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }); });
  assert.equal(calls, 1);
  assert.equal(t.ok, false);
  const pauses = [];
  runWithRetries(() => { throw Object.assign(new Error('x'), { stderr: 'ERROR: from stderr' }); }, { attempts: 2, pause: n => pauses.push(n) });
  assert.deepEqual(pauses, [1]);
  assert.equal(scanErrorLine(Object.assign(new Error('x'), { stderr: 'ERROR: from stderr' })), 'ERROR: from stderr');
  assert.equal(scanErrorLine(null), '');
});

test('runWithRetries survives a throwing pause and defaults to 3 attempts', () => {
  let calls = 0;
  const r = runWithRetries(() => { calls++; throw new Error('x'); }, { pause: () => { throw new Error('sleep failed'); } });
  assert.equal(calls, 3);
  assert.equal(r.ok, false);
});

// BRO-5537: TikTok rejects yt-dlp's un-impersonated item_list API calls, so
// every TikTok listing must go through curl_cffi; YouTube must stay unchanged.
const { buildListingCommand, TIKTOK_IMPERSONATE_TARGET } = require('../../scripts/lib/video-pipeline-health.js');

test('buildListingCommand impersonates a browser for TikTok listings only', () => {
  const tt = buildListingCommand({ platform: 'tiktok', url: 'https://www.tiktok.com/@broadwayben', limit: 300 });
  assert.match(tt, new RegExp(`^yt-dlp --impersonate ${TIKTOK_IMPERSONATE_TARGET} `));
  assert.ok(tt.includes('"https://www.tiktok.com/@broadwayben"'));
  assert.ok(tt.includes('--playlist-items 1-300'));
  // A creator with no primaryPlatform is listed from its TikTok URL, so it is impersonated too.
  assert.match(buildListingCommand({ platform: undefined, url: 'https://www.tiktok.com/@x', limit: 5 }), /--impersonate /);
  const yt = buildListingCommand({ platform: 'youtube', url: 'https://www.youtube.com/@mickeyjotheatre/videos', limit: 200 });
  assert.equal(yt.includes('--impersonate'), false);
  assert.ok(yt.startsWith('yt-dlp --flat-playlist --print "%(id)s\t%(title)s\t%(upload_date)s\t%(duration_string)s\t%(view_count)s"'));
  assert.ok(yt.endsWith('--playlist-items 1-200 --sleep-interval 1 2>&1'));
});
