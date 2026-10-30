// BRO-6651 (plan v2 Step 8): each lane pass records the aggregator/index pages it read, encrypted, and the recorded-night
// loader replays that recording. The repo is public, so page bodies must never reach disk in the clear.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rec = require('../../scripts/lib/opening-night-lane/fetch-recording.js');
const { loadRecording, replayFetchFrom } = require('../../scripts/lib/lane-recorded-nights/recording-night.js');
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const { EXPECTED, replayNight } = require('../../scripts/lib/lane-recorded-nights/the-imaginary-invalid-2026.js');

const KEY = rec.keyFromEnv({ LANE_RECORDING_KEY: 'test-key' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bro6651-'));
const allFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());

test('keyFromEnv: LANE_RECORDING_KEY, else derived from REVIEW_TEXTS_TOKEN, else null', () => {
  assert.equal(rec.keyFromEnv({}), null);
  assert.equal(rec.keyFromEnv({ LANE_RECORDING_KEY: 'a' }).length, 32);
  assert.deepEqual(rec.keyFromEnv({ REVIEW_TEXTS_TOKEN: 't' }), rec.keyFromEnv({ REVIEW_TEXTS_TOKEN: 't' }));
  assert.notDeepEqual(rec.keyFromEnv({ REVIEW_TEXTS_TOKEN: 't' }), rec.keyFromEnv({ LANE_RECORDING_KEY: 't' }));
});

test('no key: recorder is off, wraps nothing and writes nothing', async () => {
  const dir = tmp();
  const r = rec.createFetchRecorder({ dir, key: null });
  const f = async () => 'x';
  assert.equal(r.enabled, false);
  assert.equal(r.wrapFetchText(f), f);
  assert.equal(fs.existsSync(path.join(dir, 'fetches.jsonl')), false);
});

test('bodies are encrypted on disk, deduped by content hash, and decrypt back', async () => {
  const dir = tmp();
  let clock = 1000;
  const r = rec.createFetchRecorder({ dir, key: KEY, now: () => clock });
  const page = '<html>SECRET-COPYRIGHTED-ROUNDUP</html>';
  const f = r.wrapFetchText(async () => page);
  await f('https://a.example/');
  clock += 120000; await f('https://a.example/');
  clock += 120000; await f('https://b.example/');
  const s = r.stats();
  assert.equal(s.bodies, 1, 'one body for three fetches of the same content');
  assert.equal(s.deduped, 2);
  for (const file of allFiles(dir)) assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET-COPYRIGHTED'), `${file} holds plaintext`);
  const loaded = loadRecording(dir, { key: KEY });
  assert.equal(loaded.entries.length, 3);
  assert.deepEqual(loaded.entries.map((e) => e.t), [0, 120000, 240000]);
  assert.equal(loaded.page(loaded.entries[0].sha), page);
  assert.throws(() => loaded.page(loaded.entries[0].sha) && rec.decrypt(rec.keyFromEnv({ LANE_RECORDING_KEY: 'other' }), fs.readFileSync(path.join(dir, 'pages', `${loaded.entries[0].sha}.enc`))));
});

test('errors, finalUrl and date-checks are recorded; a date-check keeps the date, not the page', async () => {
  const dir = tmp();
  const r = rec.createFetchRecorder({ dir, key: KEY, dateOf: (h) => d.extractPublishDate(h) });
  const article = '<html><head><meta property="article:published_time" content="2026-10-22T20:00:00Z"></head><body>FULL-ARTICLE-TEXT</body></html>';
  const f = r.wrapFetchText(async (url, opts) => {
    if (url.includes('missing')) throw Object.assign(new Error('404 gone'), { status: 404 });
    if (opts && opts.withFinalUrl) return { content: '<rss/>', finalUrl: 'https://pub.example/x' };
    return article;
  });
  await assert.rejects(f('https://x.example/missing'), /404/);
  await f('https://x.example/wrapper', { withFinalUrl: true });
  await f('https://x.example/article', { recordAs: 'date-check' });
  const e = loadRecording(dir, { key: KEY }).entries;
  assert.equal(e[0].status, 'error'); assert.equal(e[0].httpStatus, 404);
  assert.equal(e[1].finalUrl, 'https://pub.example/x');
  assert.equal(e[2].kind, 'date-check'); assert.ok(e[2].publishDate); assert.equal(e[2].sha, undefined);
  for (const file of allFiles(dir)) assert.ok(!fs.readFileSync(file, 'utf8').includes('FULL-ARTICLE-TEXT'));
});

test('size caps drop bodies but keep the manifest, and say so', async () => {
  const dir = tmp();
  const r = rec.createFetchRecorder({ dir, key: KEY, maxPageBytes: 50, maxRunBytes: 120 });
  const f = r.wrapFetchText(async (u) => `<p>${u}</p>`.padEnd(u.endsWith('big') ? 80 : 40, '.'));
  await f('https://a/1'); await f('https://a/2'); await f('https://a/big'); await f('https://a/3'); await f('https://a/4'); await f('https://a/5');
  const s = r.stats();
  assert.equal(s.oversize, 1);
  assert.equal(s.capped, true);
  assert.ok(s.bytes <= 120);
  const lines = fs.readFileSync(path.join(dir, 'fetches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.capped), 'a capped marker line');
  assert.equal(lines.filter((l) => l.url).length, 6, 'every fetch is still in the manifest');
});

test('a write failure never reaches the lane', async () => {
  const dir = path.join(tmp(), 'blocked'); fs.writeFileSync(dir, 'a file where the directory should be');
  const r = rec.createFetchRecorder({ dir, key: KEY });
  assert.equal(await r.wrapFetchText(async () => 'ok')('https://a/'), 'ok');
  assert.ok(r.stats().errors > 0);
});

test('timing: a replay serves the page that was current at the virtual time', async () => {
  const dir = tmp();
  let clock = 0;
  const r = rec.createFetchRecorder({ dir, key: KEY, now: () => clock });
  let body = null;
  const f = r.wrapFetchText(async () => { if (!body) throw new Error('404'); return body; });
  await f('https://p/').catch(() => {});
  clock = 120000; body = '<a>v1</a>'; await f('https://p/');
  clock = 600000; body = '<a>v2</a>'; await f('https://p/');
  let vnow = 5000;
  const fetch = replayFetchFrom(loadRecording(dir, { key: KEY }), { now: () => vnow, startMs: 0 });
  await assert.rejects(fetch('https://p/'), /404/);
  vnow = 130000; assert.equal((await fetch('https://p/')).content, '<a>v1</a>');
  vnow = 700000; assert.equal((await fetch('https://p/')).content, '<a>v2</a>');
  await assert.rejects(fetch('https://never/'), /404/);
});

test('round trip: record the 2026-10-22 night through wireLaneNight, replay the recording, same reviews found', async () => {
  const dir = tmp();
  const recorded = await replayNight({
    recorder: ({ now }) => rec.createFetchRecorder({ dir, key: KEY, now, dateOf: (h) => d.extractPublishDate(h) }),
  });
  const entries = loadRecording(dir, { key: KEY }).entries;
  assert.ok(entries.length > 10, `recorded ${entries.length} fetches`);
  assert.ok(entries.some((e) => /broadwayworld\.com\/$/.test(e.url)), 'the BWW homepage is in the recording');
  assert.ok(entries.some((e) => /playbill\.com\/category\/the-verdict/.test(e.url)), 'the Playbill category page is in the recording');
  assert.ok(entries.some((e) => /didtheylikeit\.com\/$/.test(e.url)), 'the DTLI homepage is in the recording');
  const reviewUrls = new Set(Object.values(EXPECTED).map((u) => d.canonicalUrl(u)));
  // The one review page discovery itself reads is a Talkin' Broadway named page (it is verified and dated there); it is recorded, encrypted.
  assert.ok(!entries.some((e) => reviewUrls.has(d.canonicalUrl(e.url)) && e.kind !== 'date-check' && !/talkinbroadway\.com/.test(e.url)), 'review articles fetched for scoring are not recorded');

  const loaded = loadRecording(dir, { key: KEY });
  const replayed = await replayNight({
    // Only review articles may fall through to the synthetic fixture; every index page must come from the recording.
    fetchPageFrom: ({ now, T0, fallback }) => replayFetchFrom(loaded, {
      now, startMs: T0,
      fallback: (url, opts) => (reviewUrls.has(d.canonicalUrl(url)) || /cititour|stagebuddy|theaterpizzazz|1minutecritic|vulture/.test(url) ? fallback(url, opts) : Promise.reject(Object.assign(new Error(`404 ${url}`), { status: 404 }))),
    }),
  });
  assert.deepEqual([...replayed.keys].sort(), [...recorded.keys].sort(), 'the replay finds exactly what the recorded night found');
  assert.ok(replayed.keys.size >= 18);
});

test('manifest starts with a key-version header; the loader ignores it; HKDF keys are stable', async () => {
  const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-hdr-'));
  const r = rec.createFetchRecorder({ dir, key: KEY });
  await r.wrapFetchText(async () => ({ content: '<html>x</html>' }))('https://a.example/p');
  const lines = fs.readFileSync(path.join(dir, 'fetches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { header: true, keyVersion: rec.KEY_VERSION });
  const { loadRecording } = await import('../../scripts/lib/lane-recorded-nights/recording-night.js');
  assert.equal(loadRecording(dir, { key: KEY }).entries.length, 1);
  assert.equal(rec.KEY_VERSION, 1);
  assert.equal(rec.keyFromEnv({ LANE_RECORDING_KEY: 'k' }).toString('hex'), rec.keyFromEnv({ LANE_RECORDING_KEY: 'k' }).toString('hex'));
});
