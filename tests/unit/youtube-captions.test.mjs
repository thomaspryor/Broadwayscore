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
