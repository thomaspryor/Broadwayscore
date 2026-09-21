import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { weekStart, median, bucketWeekly, detectSpikes, allWeeks, recentChange, trendsFor, newSources, indexReferralLanding, buildReport, mdCell, normalizeCampaign, withRetry, isTransientPostHogError } = require('../analyze-traffic-sources.js');

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

const W9 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'cur'];

test('trendsFor compares the last 4 full weeks with the 4 before and applies the floors', () => {
  const series = {
    reddit: { w1: 50, w2: 50, w3: 50, w4: 50, w5: 20, w6: 20, w7: 20, w8: 20, cur: 3 },   // falling -60%
    email: { w1: 20, w2: 20, w3: 20, w4: 20, w5: 40, w6: 40, w7: 40, w8: 40, cur: 9 },    // rising +100%
    tiny: { w1: 2, w2: 2, w3: 2, w4: 2, w5: 8, w6: 8, w7: 8, w8: 8 },                     // +300% but under the floor
    fresh: { w5: 30, w6: 30, w7: 30, w8: 30 },                                             // new at 30/week
  };
  const { rising, falling } = trendsFor(series, W9, 'cur');
  assert.deepEqual(rising.map((x) => [x.key, x.recentPerWeek, x.priorPerWeek, x.pct]), [['fresh', 30, 0, null], ['email', 40, 20, 100]]);
  assert.deepEqual(falling.map((x) => [x.key, x.pct]), [['reddit', -60]]);
  assert.deepEqual(trendsFor(series, W9.slice(0, 5), 'cur').rising, []); // fewer than 8 full weeks
});

test('newSources lists referrers absent from the first half of the window with 5+ visits since', () => {
  const series = {
    'blog.example': { w6: 3, w7: 4, cur: 20 },   // 7 in the second half, current week ignored
    'old.example': { w1: 1, w7: 50 },            // existed early
    'weak.example': { w8: 4 },                   // under 5
  };
  const fresh = newSources(series, W9, 'cur');
  assert.deepEqual(fresh.map((x) => [x.key, x.late, x.firstWeek]), [['blog.example', 7, 'w6']]);
});

test('indexReferralLanding ties referrers to landing pages per week and overall', () => {
  const idx = indexReferralLanding([
    { date: '2026-07-20', key: 'www.reddit.com → /show/trainspotting-the-musical-west-end', sessions: 300 },
    { date: '2026-07-22', key: 'www.reddit.com → /show/trainspotting-the-musical-west-end', sessions: 25 },
    { date: '2026-07-22', key: 'www.reddit.com → /', sessions: 10 },
    { date: '2026-08-03', key: 'blog.example → /west-end', sessions: 6 },
    { date: '2026-08-03', key: 'broken-row-without-arrow', sessions: 6 },
  ]);
  assert.equal(idx.byWeek['2026-07-20']['www.reddit.com']['/show/trainspotting-the-musical-west-end'], 325);
  assert.equal(idx.byDomain['www.reddit.com']['/'], 10);
  assert.equal(idx.byDomain['blog.example']['/west-end'], 6);
  assert.ok(!idx.byDomain['broken-row-without-arrow']);
});

test('buildReport renders rising/falling, new sites and referral landing sections with landing pages on referrer spikes', () => {
  const weeks = allWeeks('2026-06-15', '2026-09-15');
  const cur = '2026-09-14';
  const full = weeks.filter((w) => w !== cur);
  const rows = (key, perWeek, extra = {}) => full.map((w) => ({ date: w, key, sessions: perWeek(w, full.indexOf(w)), users: 1, ...extra }));
  const referringDomain = [
    ...rows('www.google.com', () => 1000),
    ...rows('www.reddit.com', (w, i) => (i === 2 ? 325 : i < 9 ? 50 : 20)),
    ...rows('blog.example', (w, i) => (i >= 10 ? 4 : 0)).filter((r) => r.sessions),
  ];
  const referralLanding = [
    ...rows('www.reddit.com → /show/trainspotting-the-musical-west-end', (w, i) => (i === 2 ? 300 : 5)),
    ...rows('www.reddit.com → /', () => 5),
    ...rows('blog.example → /west-end', (w, i) => (i >= 10 ? 4 : 0)).filter((r) => r.sessions),
  ];
  const ph = { errors: {}, channelType: [], utmSource: [], country: [], landing: [], referringDomain, referralLanding };
  const { md } = buildReport({ ga: { skipped: 'x' }, ph, startDate: '2026-06-15', endDate: '2026-09-15', weeks, currentWeek: cur });
  assert.match(md, /\*\*www\.reddit\.com\*\* \(PostHog referring domain\): 325 sessions[^\n]*landing on \/show\/trainspotting-the-musical-west-end \(300\)/);
  assert.match(md, /## Rising and falling[\s\S]*\*\*Falling\*\*[\s\S]*\*\*www\.reddit\.com\*\* \(referrer\): 20\/week now vs 50\/week before \(-60%\)/);
  assert.match(md, /## New sites linking to you[\s\S]*\*\*blog\.example\*\*: 12 visits since Aug 24, landing on \/west-end \(12\)/);
  assert.match(md, /## Where social and referral traffic lands[\s\S]*\| www\.reddit\.com \| 40 \|/);
  assert.ok(md.indexOf('## Rising and falling') < md.indexOf('## PostHog (Real Users lens)')); // in the emailed summary
});
