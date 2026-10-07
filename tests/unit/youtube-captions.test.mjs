// BRO-4343: YouTube captions via fetchPage when yt-dlp is bot-walled.
// require()s the real parser (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlayerResponse, pickCaptionTrack, json3ToText, toYmd, fetchYouTubeTranscript } = require('../../scripts/lib/youtube-captions.js');

const player = {
  playabilityStatus: { status: 'OK' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr', languageCode: 'en', kind: 'asr', name: { runs: [{ text: 'English (auto-generated)' }] } },
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=es', languageCode: 'es', name: { simpleText: 'Spanish "quoted" {braces}' } },
  ] } },
  microformat: { playerMicroformatRenderer: { publishDate: '2026-09-10T07:00:00-07:00' } },
};
const html = `<html><script>var foo = 1;var ytInitialPlayerResponse = ${JSON.stringify(player)};var meta = {"x":1};</script></html>`;

test('parses the player response out of a watch page, including nested brackets and quoted braces', () => {
  const p = parsePlayerResponse(html);
  assert.equal(p.playabilityStatus.status, 'OK');
  assert.equal(p.captions.playerCaptionsTracklistRenderer.captionTracks.length, 2);
});

test('bot-walled or garbage pages yield null or a non-OK status', () => {
  assert.equal(parsePlayerResponse('<html>nothing here</html>'), null);
  const walled = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } };
  assert.equal(parsePlayerResponse(`ytInitialPlayerResponse = ${JSON.stringify(walled)};`).playabilityStatus.status, 'LOGIN_REQUIRED');
});

test('prefers human English, then English auto-captions', () => {
  const tracks = player.captions.playerCaptionsTracklistRenderer.captionTracks;
  assert.equal(pickCaptionTrack(tracks).kind, 'asr');
  assert.equal(pickCaptionTrack([...tracks, { baseUrl: 'x', languageCode: 'en-US' }]).baseUrl, 'x');
  assert.equal(pickCaptionTrack([]), null);
});

test('json3 to text drops empty and repeated lines', () => {
  const payload = { events: [{ segs: [{ utf8: 'Hello and ' }, { utf8: 'welcome' }] }, { segs: [{ utf8: '\n' }] }, { segs: [{ utf8: 'welcome' }] }, { segs: [{ utf8: 'welcome' }] }, {}] };
  assert.equal(json3ToText(payload), 'Hello and welcome welcome');
});

test('publish date to YYYYMMDD', () => {
  assert.equal(toYmd('2026-09-10T07:00:00-07:00'), '20260910');
  assert.equal(toYmd(undefined), null);
});

test('end to end with injected fetchers; bot wall throws an ERROR: message', async () => {
  const fetchers = {
    fetchPage: async () => ({ content: html, source: 'brightdata' }),
    fetchJSON: async (url) => { assert.match(url, /kind=asr&fmt=json3$/); return { events: [{ segs: [{ utf8: 'Great show' }] }] }; },
  };
  assert.deepEqual(await fetchYouTubeTranscript('abc', fetchers), { transcript: 'Great show', publishedAt: '20260910', source: 'brightdata' });
  // A track with no events array is a blocked response, not "no captions".
  await assert.rejects(fetchYouTubeTranscript('abc', { ...fetchers, fetchJSON: async () => ({}) }), /caption track returned no events/);
  const walled = { fetchPage: async () => ({ content: `ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in"}};`, source: 'brightdata' }), fetchJSON: async () => ({}) };
  await assert.rejects(fetchYouTubeTranscript('abc', walled), /^Error: ERROR: \[youtube-fetchpage\] abc: LOGIN_REQUIRED/);
});

// BRO-4665: Scrapingdog's /youtube/transcripts API is tried before the watch page.
const { publishedTimeToYmd, sdTranscriptToText, sdVideoPublishedText } = require('../../scripts/lib/youtube-captions.js');

test('Scrapingdog published_time variants parse to YYYYMMDD', () => {
  assert.equal(publishedTimeToYmd('May 20, 2026'), '20260520');
  assert.equal(publishedTimeToYmd('Streamed live on Sep 3, 2026'), '20260903');
  assert.equal(publishedTimeToYmd('Premiered 3 Sept 2026'), '20260903');
  assert.equal(publishedTimeToYmd('2026-09-10T07:00:00Z'), '20260910');
  const now = new Date('2026-10-05T12:00:00Z');
  assert.equal(publishedTimeToYmd('2 days ago', now), '20261003');
  assert.equal(publishedTimeToYmd('Premiered 5 hours ago', now), '20261005');
  assert.equal(publishedTimeToYmd('Streamed live a week ago', now), '20260928');
  assert.equal(publishedTimeToYmd('3 months ago', now), null);
  assert.equal(publishedTimeToYmd(undefined), null);
});

test('sdVideoPublishedText reads the nested video.published_time (BRO-4760)', () => {
  assert.equal(sdVideoPublishedText({ video: { published_time: 'May 20, 2026' }, channel: {} }), 'May 20, 2026');
  assert.equal(sdVideoPublishedText({ published_time: 'May 20, 2026' }), 'May 20, 2026');
  assert.equal(sdVideoPublishedText({ video: {} }), null);
  assert.equal(sdVideoPublishedText(null), null);
});

test('Scrapingdog transcript payload to text decodes entities, drops [Music] and repeats', () => {
  assert.equal(sdTranscriptToText({ transcripts: [{ text: 'it&#39;s [Music] great' }, { text: 'it&#39;s great' }, { text: 'show &amp; tell' }] }), "it's great show & tell");
  assert.equal(sdTranscriptToText({ transcripts: [] }), '');
  assert.equal(sdTranscriptToText({ message: 'no transcript' }), null);
});

test('Scrapingdog route wins, fetching the date only when asked', async () => {
  const calls = [];
  const sdYouTube = async (kind) => {
    calls.push(kind);
    return kind === 'transcripts'
      ? { data: { transcripts: [{ text: 'A great show', start: 0, duration: 1 }] } }
      // Documented shape: metadata nests under `video` (BRO-4760).
      : { data: { video: { title: 'x', published_time: 'Streamed live on Sep 10, 2026' }, channel: {} } };
  };
  const fetchPage = async () => { throw new Error('watch page must not be fetched'); };
  const r = await fetchYouTubeTranscript('abc', { sdYouTube, fetchPage });
  assert.deepEqual(r, { transcript: 'A great show', publishedAt: '20260910', source: 'scrapingdog-youtube' });
  assert.deepEqual(calls, ['transcripts', 'video']);
  calls.length = 0;
  const r2 = await fetchYouTubeTranscript('abc', { sdYouTube, fetchPage }, { needDate: false });
  assert.equal(r2.publishedAt, null);
  assert.deepEqual(calls, ['transcripts']);
});

test('Scrapingdog failure or unknown payload falls back to the watch page', async () => {
  for (const sdResult of [null, { error: 'Scrapingdog HTTP 500' }, { data: { oops: true } }]) {
    let watched = false;
    const r = await fetchYouTubeTranscript('abc', {
      sdYouTube: async () => sdResult,
      fetchPage: async () => { watched = true; return { content: html, source: 'brightdata' }; },
      fetchJSON: async () => ({ events: [{ segs: [{ utf8: 'from captions' }] }] }),
    });
    assert.equal(watched, true);
    assert.equal(r.transcript, 'from captions');
  }
});

test('backfillPublishedDates re-dates NA YouTube reviews only (BRO-4760)', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { backfillPublishedDates } = require('../../scripts/lib/youtube-captions.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdates-'));
  const w = (rel, obj) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), JSON.stringify(obj)); };
  w('show-a/mh.json', { platform: 'youtube', videoId: 'v1', creatorId: 'MH', publishedAt: 'NA' });
  w('show-a/tt.json', { platform: 'tiktok', videoId: 'v2', creatorId: 'TT', publishedAt: null });
  w('show-b/mh.json', { platform: 'youtube', videoId: 'v3', creatorId: 'MH', publishedAt: '20260101' });
  w('show-b/mj.json', { platform: 'youtube', videoId: 'v4', creatorId: 'MJ', publishedAt: null });
  w('raw/v1.json', { videoId: 'v1', date: 'NA' });
  w('classified/v1.json', { id: 'v1', date: 'NA' });
  w('show-a/wp.json', { platform: 'youtube', videoId: 'v5', publishedAt: 'NA', wrongProduction: true });
  w('show-a/bad.json', {});
  fs.writeFileSync(path.join(root, 'show-a/bad.json'), '{not json');
  fs.writeFileSync(path.join(root, 'show-a/mh.json'), JSON.stringify({ platform: 'youtube', videoId: 'v1', creatorId: 'MH', publishedAt: 'NA', productionCheck: { verdict: 'same' } }));
  w('classified/v9.json', { platform: 'youtube', videoId: 'v9', publishedAt: 'NA' });
  const asked = [];
  const r = await backfillPublishedDates({ transcriptsDir: root, fetchDate: async id => { asked.push(id); return id === 'v1' ? '20260520' : null; } });
  assert.deepEqual(asked.sort(), ['v1', 'v4']);
  assert.deepEqual(r, { candidates: 2, attempted: 2, dated: 1 });
  const read = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  assert.equal(read('show-a/mh.json').publishedAt, '20260520');
  assert.equal(read('show-a/mh.json').productionCheck, undefined);
  assert.equal(read('raw/v1.json').date, '20260520');
  assert.equal(read('classified/v1.json').date, '20260520');
  assert.equal(read('show-b/mj.json').publishedAt, null);
  assert.ok(read('show-b/mj.json').dateLookupFailedAt);
  // a failed lookup waits RETRY_DAYS before it is paid for again
  const again = await backfillPublishedDates({ transcriptsDir: root, fetchDate: async () => { throw new Error('cooldown'); } });
  assert.equal(again.candidates, 0);
  const later = await backfillPublishedDates({ transcriptsDir: root, now: new Date(Date.now() + 31 * 864e5), fetchDate: async () => '20260601' });
  assert.deepEqual(later, { candidates: 1, attempted: 1, dated: 1 });
  // budget exhausted (fetch returns undefined): stop, stamp nothing
  w('show-c/x.json', { platform: 'youtube', videoId: 'v6', creatorId: 'X', publishedAt: 'NA' });
  const broke = await backfillPublishedDates({ transcriptsDir: root, fetchDate: async () => undefined });
  assert.deepEqual(broke, { candidates: 1, attempted: 0, dated: 0 });
  assert.equal(read('show-c/x.json').dateLookupFailedAt, undefined);
  const { fetchYouTubePublishedAt } = require('../../scripts/lib/youtube-captions.js');
  assert.equal(await fetchYouTubePublishedAt('v', async () => null), undefined);
  assert.equal(await fetchYouTubePublishedAt('v', async () => ({ error: 'HTTP 500' })), null);
  assert.equal(await fetchYouTubePublishedAt('v', async () => ({ data: { video: { published_time: 'Mar 3, 2026' } } })), '20260303');
  const r2 = await backfillPublishedDates({ transcriptsDir: root, creatorFilter: 'mh', fetchDate: async () => { throw new Error('should not fetch'); } });
  assert.deepEqual(r2, { candidates: 0, attempted: 0, dated: 0 });
  const r3 = await backfillPublishedDates({ transcriptsDir: root, max: 0, fetchDate: async () => { throw new Error('capped'); } });
  assert.equal(r3.attempted, 0);
  fs.rmSync(root, { recursive: true });
});
