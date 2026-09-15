import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { weekStart, median, bucketWeekly, detectSpikes, allWeeks, recentChange, buildReport, mdCell, normalizeCampaign, withRetry, isTransientPostHogError } = require('../analyze-traffic-sources.js');

test('weekStart maps any day to its ISO Monday, for both GA4 and ISO date formats', () => {
  assert.equal(weekStart('20260915'), '2026-09-14'); // Tue → Mon
  assert.equal(weekStart('2026-09-14'), '2026-09-14'); // Mon stays
  assert.equal(weekStart('2026-09-20'), '2026-09-14'); // Sun belongs to the prior Monday
  assert.equal(weekStart('2026-01-01'), '2025-12-29'); // year boundary
});

test('median handles empty, odd and even lengths', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('allWeeks lists every Monday from the start week through the end week', () => {
  const w = allWeeks('2026-09-01', '2026-09-15');
  assert.deepEqual(w, ['2026-08-31', '2026-09-07', '2026-09-14']);
});

test('bucketWeekly sums daily rows into per-key ISO weeks', () => {
  const s = bucketWeekly([
    { date: '20260907', key: 'google', value: 10 },
    { date: '20260909', key: 'google', value: 5 },
    { date: '20260914', key: 'google', value: 7 },
    { date: '20260908', key: 'reddit.com', value: 2 },
  ]);
  assert.deepEqual(s, {
    google: { '2026-09-07': 15, '2026-09-14': 7 },
    'reddit.com': { '2026-09-07': 2 },
  });
});

test('detectSpikes flags a brand-new source and a 3x jump, ignores the current partial week', () => {
  const weeks = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14'];
  const series = {
    steady: { '2026-08-17': 100, '2026-08-24': 110, '2026-08-31': 95, '2026-09-07': 105, '2026-09-14': 40 },
    jump: { '2026-08-17': 20, '2026-08-24': 25, '2026-08-31': 90, '2026-09-07': 30, '2026-09-14': 5 },
    brandNew: { '2026-09-07': 60, '2026-09-14': 400 },
    tiny: { '2026-08-17': 1, '2026-09-07': 9 },
  };
  const spikes = detectSpikes(series, weeks, { minAbs: 30, ratio: 3, currentWeek: '2026-09-14' });
  const keys = spikes.map((s) => `${s.key}@${s.week}`);
  assert.deepEqual(keys.sort(), ['brandNew@2026-09-07', 'jump@2026-08-31']);
  const j = spikes.find((s) => s.key === 'jump');
  assert.equal(j.priorMedian, 22.5);
  assert.equal(j.multiple, 4);
  assert.equal(j.next, 30);
  const n = spikes.find((s) => s.key === 'brandNew');
  assert.equal(n.isNew, true);
  assert.equal(n.multiple, null);
  // The 400 in the current week is never reported as a spike.
  assert.ok(!keys.includes('brandNew@2026-09-14'));
});

test('detectSpikes treats missing weeks as zero rather than skipping them', () => {
  const weeks = ['2026-08-24', '2026-08-31', '2026-09-07'];
  const series = { flaky: { '2026-08-24': 50, '2026-09-07': 50 } };
  // Prior weeks [50, 0] → median 25, 50 is only 2x → no spike.
  assert.deepEqual(detectSpikes(series, weeks, { minAbs: 30, ratio: 3 }), []);
});

test('detectSpikes never treats a zero baseline as a spike unless the source is genuinely new (ship-check P1)', () => {
  const weeks = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9'];
  const series = {
    // Appears mid-window and keeps growing: only w5 (new) and w9 (3x median 20) qualify.
    midWindow: { w5: 40, w6: 45, w7: 50, w8: 55, w9: 60 },
    // Codex case: [100, 0, 0, 30] — 30 is below what it did before, not a spike.
    faded: { w1: 100, w4: 30 },
  };
  const keys = detectSpikes(series, weeks, { minAbs: 30, ratio: 3 }).map((s) => `${s.key}@${s.week}`).sort();
  assert.deepEqual(keys, ['midWindow@w5', 'midWindow@w9']);
});

test('recentChange compares the last full week to the average of the 4 before it and skips the current week', () => {
  const weeks = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];
  const series = { search: { w1: 999, w2: 100, w3: 100, w4: 100, w5: 100, w6: 200, w7: 5 }, fresh: { w6: 50, w7: 1 } };
  const rc = recentChange(series, weeks, 'w7');
  assert.deepEqual(rc, [
    { key: 'search', last: 200, avg: 100, pct: 100 },
    { key: 'fresh', last: 50, avg: 0, pct: null },
  ]);
});

test('mdCell escapes pipes so referrer strings cannot break a table row', () => {
  assert.equal(mdCell('a|b'), 'a\\|b');
  assert.equal(mdCell(null), '—');
});

test('buildReport surfaces failures at the top and still renders the working tool', () => {
  const weeks = ['2026-08-31', '2026-09-07', '2026-09-14'];
  const ph = {
    errors: { landing: 'boom' },
    channelType: [
      { date: '2026-08-31', key: 'Organic Search', sessions: 100, users: 90 },
      { date: '2026-09-07', key: 'Organic Search', sessions: 120, users: 100 },
      { date: '2026-09-07', key: 'Referral', sessions: 90, users: 80 },
    ],
    referringDomain: [], utmSource: [], country: [], landing: [],
  };
  const ga = { skipped: 'GA4_PROPERTY_ID / GA credentials not set' };
  const { md, problems, spikes } = buildReport({ ga, ph, startDate: '2026-08-31', endDate: '2026-09-15', weeks, currentWeek: '2026-09-14' });
  assert.equal(problems.length, 2);
  assert.match(md, /Incomplete report/);
  assert.match(md, /GA4 skipped/);
  assert.match(md, /PostHog landing query failed: boom/);
  assert.match(md, /## What changed/);
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].key, 'Referral');
  assert.match(md, /\*\*Referral\*\* \(PostHog channel type\): new source, 90 sessions in the week of Sep 7/);
  assert.match(md, /\| Organic Search \| 120 \| 100 \| \+20% \|/);
  assert.match(md, /PostHog sessions:\n/); // section label, not "undefined undefined"
});

test('normalizeCampaign folds dated newsletter sends into one family', () => {
  assert.equal(normalizeCampaign('weekly-2026-07-12'), 'weekly-(dated sends)');
  assert.equal(normalizeCampaign('we-weekly-2026-07-12'), 'we-weekly-(dated sends)');
  assert.equal(normalizeCampaign('opening-paranormal-activity-2026'), 'opening-(dated sends)');
  assert.equal(normalizeCampaign('(direct)'), '(direct)');
});

test('buildReport lists each spiking source once in the summary, at its biggest week', () => {
  const weeks = ['w1', 'w2', 'w3', 'w4', 'w5'];
  const ph = {
    errors: {},
    channelType: [], referringDomain: [], utmSource: [], landing: [],
    country: [
      { date: '2026-08-03', key: 'Hong Kong', sessions: 5, users: 5 },
      { date: '2026-08-10', key: 'Hong Kong', sessions: 5, users: 5 },
      { date: '2026-08-17', key: 'Hong Kong', sessions: 500, users: 400 },
      { date: '2026-08-24', key: 'Hong Kong', sessions: 700, users: 500 },
    ],
  };
  const wk = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];
  const { md, spikes } = buildReport({ ga: { skipped: 'x' }, ph, startDate: wk[0], endDate: '2026-09-01', weeks: wk, currentWeek: wk[4] });
  assert.equal(spikes.length, 2); // two spiking weeks in the section table
  assert.equal((md.match(/\*\*Hong Kong\*\* \(PostHog country\)/g) || []).length, 1); // one summary line
  assert.match(md, /700 sessions in the week of Aug 24/);
});

test('withRetry retries a transient PostHog error once and rethrows non-transient errors immediately', async () => {
  const sleep = async () => {};
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new Error('PostHog API 504: <html>504 Gateway Time-out'); return 'ok'; };
  assert.equal(await withRetry(flaky, { sleep }), 'ok');
  assert.equal(calls, 2);

  calls = 0;
  const bad = async () => { calls++; throw new Error('PostHog API 400: bad hogql'); };
  await assert.rejects(() => withRetry(bad, { sleep }), /400/);
  assert.equal(calls, 1);

  calls = 0;
  const dead = async () => { calls++; throw new Error('PostHog API 503: down'); };
  await assert.rejects(() => withRetry(dead, { sleep }), /503/);
  assert.equal(calls, 2); // gives up after the single retry

  assert.equal(isTransientPostHogError(new Error('PostHog API 429: rate limited')), true);
  assert.equal(isTransientPostHogError(new Error('PostHog API 401: nope')), false);
  assert.equal(isTransientPostHogError(new Error('PostHog API 400: Timeout exceeded: estimated query execution time too long')), false);
  assert.equal(isTransientPostHogError(new TypeError('fetch failed')), true);
});
