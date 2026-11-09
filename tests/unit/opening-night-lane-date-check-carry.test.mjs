// BRO-6872 (p15 five-show replay): two Talkin' Broadway reviews the lane found and then dropped.
// School Girls: the index listed SchoolGirls.html with no date; the date check ran under the pass's 15 s cap while TB
// answers in 35-40 s, so the page was fetched, dated 2026-09-28, and thrown away on two passes.
// Other Desert Cities: an index sighting with bare-title anchor text was memoed 'not-review-like' (final), and the
// named-page probe's later sighting, which carries reviewSignalGiven, was skipped by the memo on every pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');

const NIGHT = '2026-09-28';
const SHOW = { id: 'school-girls-or-the-african-mean-girls-play-2026', title: 'School Girls; Or, The African Mean Girls Play', openingDate: NIGHT };
const T0 = Date.parse('2026-09-29T02:00:00Z');
const TB = 'https://www.talkinbroadway.com/page/world/SchoolGirls.html';
const KEY = d.canonicalUrl(TB);
const PAGE = '<html><head><meta property="article:published_time" content="2026-09-28T23:00:00Z"></head><body>review</body></html>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An outlet-index adapter that lists the TB page undated, with its own long cap, as talkinBroadwayAdapter does.
const tbIndex = (extra = {}) => ({
  name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
  discover: async () => [{ url: TB, title: 'School Girls; Or, The African Mean Girls Play review', source: 'outlet-index', publishDate: null, needsDate: true, ...extra }],
});
const pass = (fetchText, memo, opts = {}) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [tbIndex()], fetchText, memo, ...opts });

test('a date check runs under its adapter\'s cap, not the pass default', async () => {
  let calls = 0;
  const fetchText = async (url) => { if (url !== TB) throw new Error('404'); calls++; await sleep(120); return PAGE; };
  // Pass default 50 ms stands in for 15 s; the adapter's 1000 ms for TB's 75 s.
  const r = await pass(fetchText, { rejected: {} }, { fetchTimeoutMs: 50 });
  assert.deepEqual(r.admitted.map((a) => a.key), [KEY]);
  assert.equal(r.admitted[0].publishDate.slice(0, 10), NIGHT);
  assert.equal(calls, 1);
});

test('a date check still running at the pass deadline is read on the next pass, not fetched again', async () => {
  let calls = 0;
  const fetchText = async (url) => { if (url !== TB) throw new Error('404'); calls++; await sleep(150); return PAGE; };
  const memo = { rejected: {} };
  const first = await pass(fetchText, memo, { deadlineMs: 60 });
  assert.equal(first.admitted.length, 0);
  assert.deepEqual(first.deferredDateChecks, [KEY]);
  assert.equal(first.deadlineHit, true);
  assert.deepEqual(memo.rejected, {}, 'no strike for a check the deadline cut');
  await sleep(200); // the orphaned check answers between passes
  const second = await pass(fetchText, memo, { deadlineMs: 60 });
  assert.deepEqual(second.admitted.map((a) => a.key), [KEY]);
  assert.equal(calls, 1, 'one paid fetch across both passes');
  assert.equal(JSON.stringify(memo), '{"rejected":{}}', 'the in-flight check never reaches the saved memo');
});

test('a carried check that is still running is waited on again, and a carried failure is a strike as before', async () => {
  let calls = 0;
  const fetchText = async (url) => { if (url !== TB) throw new Error('404'); calls++; await sleep(100); throw new Error('All scraping methods failed'); };
  const memo = { rejected: {} };
  await pass(fetchText, memo, { deadlineMs: 40 });
  const second = await pass(fetchText, memo, { deadlineMs: 500 });
  assert.equal(calls, 1, 'the second pass waited on the first pass\'s fetch');
  assert.equal(second.admitted.length, 0);
  assert.deepEqual(memo.rejected[KEY], { reason: 'date-check-failed', attempts: 1, dateFails: 1 });
  await pass(fetchText, memo, { deadlineMs: 500 });
  assert.equal(calls, 2, 'a settled check is not reused: the next pass fetches afresh');
});

test('a not-review-like memo is judged again when a later sighting carries a review signal (Other Desert Cities)', async () => {
  const ODC = 'https://www.talkinbroadway.com/page/world/OtherDesertCities26.html';
  const odc = { id: 'other-desert-cities-2026', title: 'Other Desert Cities', openingDate: '2026-10-18' };
  const memo = { rejected: { [d.canonicalUrl(ODC)]: { reason: 'not-review-like', attempts: 1 } } };
  const probe = (signal) => ({ name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', discover: async () => [{ url: ODC, title: 'Other Desert Cities', source: 'outlet-index', publishDate: '2026-10-18T12:00:00Z', ...(signal ? { reviewSignalGiven: true } : {}) }] });
  const run = (signal) => d.runDiscoveryPass({ show: odc, night: '2026-10-18', now: Date.parse('2026-10-19T00:00:00Z'), startedAt: Date.parse('2026-10-18T23:00:00Z'), adapters: [probe(signal)], fetchText: async () => { throw new Error('no fetch expected'); }, memo });
  assert.equal((await run(false)).admitted.length, 0, 'the same signal-less sighting stays rejected');
  assert.deepEqual((await run(true)).admitted.map((a) => a.key), [d.canonicalUrl(ODC)]);
});

test('date checks run side by side: two slow pages both answer inside one pass (BRO-6872 review)', async () => {
  const urls = [TB, 'https://www.talkinbroadway.com/page/world/SchoolGirlsOr.html'];
  const two = { name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
    discover: async () => urls.map((url) => ({ url, title: 'School Girls review', source: 'outlet-index', publishDate: null, needsDate: true })) };
  let inFlightNow = 0; let most = 0;
  const fetchText = async () => { inFlightNow++; most = Math.max(most, inFlightNow); await sleep(120); inFlightNow--; return PAGE; };
  // Deadline 200 ms: one after another (240 ms) the second would be cut.
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [two], fetchText, memo: { rejected: {} }, deadlineMs: 200 });
  assert.equal(most, 2);
  assert.deepEqual(r.admitted.map((a) => a.key).sort(), urls.map((u) => d.canonicalUrl(u)).sort());
  assert.equal(r.deadlineHit, false);
});

const many = (urls) => ({ name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
  discover: async () => urls.map((url) => ({ url, title: 'School Girls review', source: 'outlet-index', publishDate: null, needsDate: true })) });
const tbUrl = (i) => `https://www.talkinbroadway.com/page/world/SchoolGirls${i}.html`;

test('no more than DATE_CHECK_CONCURRENCY date checks are open at once, so a burst cannot trip a provider limit (BRO-6872 review)', async () => {
  const urls = Array.from({ length: 6 }, (_, i) => tbUrl(i));
  let open = 0; let most = 0;
  const fetchText = async () => { open++; most = Math.max(most, open); await sleep(30); open--; return PAGE; };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [many(urls)], fetchText, memo: { rejected: {} }, deadlineMs: 2000 });
  assert.equal(most, 3);
  assert.equal(r.admitted.length, 6);
});

test('a check that finished before the deadline is read even when an earlier one is cut (BRO-6872 review)', async () => {
  const slow = tbUrl('slow'); const fast = tbUrl('fast');
  const fetchText = async (url) => { await sleep(url === slow ? 300 : 10); return PAGE; };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [many([slow, fast])], fetchText, memo: { rejected: {} }, deadlineMs: 80 });
  assert.deepEqual(r.admitted.map((a) => a.key), [d.canonicalUrl(fast)]);
  assert.deepEqual(r.deferredDateChecks, [d.canonicalUrl(slow)]);
});

test('a check still waiting for a slot when the pass ends is dropped, never started afterwards (BRO-6872 review)', async () => {
  const urls = Array.from({ length: 5 }, (_, i) => tbUrl(`q${i}`));
  const started = [];
  const fetchText = async (url) => { started.push(url); await sleep(100); return PAGE; };
  const memo = { rejected: {} };
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [many(urls)], fetchText, memo, deadlineMs: 40 });
  assert.equal(r.admitted.length, 0);
  await sleep(350); // the three started checks finish; nothing queued may start now
  assert.equal(started.length, 3);
  assert.deepEqual(memo.rejected, {}, 'no strikes');
  const next = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [many(urls)], fetchText, memo, deadlineMs: 1000 });
  assert.equal(next.admitted.length, 5, 'three read from the carry, two dropped ones asked again');
  assert.equal(started.length, 5);
});

// p16 replay, Other Desert Cities: the TB index listed OtherDesertCities26.html once, its date check answered (2026-10-18)
// after that pass's deadline, and every later index fetch came back as a challenge page, so the answer was never read.
test('an undated index find whose index never loads again is still read and admitted on a later pass', async () => {
  let calls = 0; let listed = 0;
  const once = { name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
    discover: async () => (listed++ === 0 ? [{ url: TB, title: 'School Girls review', source: 'outlet-index', publishDate: null, needsDate: true }] : []) };
  const fetchText = async (url) => { if (url !== TB) throw new Error('404'); calls++; await sleep(150); return PAGE; };
  const memo = { rejected: {} };
  const run = () => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [once], fetchText, memo, deadlineMs: 60 });
  assert.equal((await run()).admitted.length, 0);
  await sleep(200);
  const second = await run();
  assert.deepEqual(second.admitted.map((a) => a.key), [KEY], 'read without a second sighting');
  assert.equal(calls, 1);
  const third = await run();
  assert.equal(third.admitted.length, 0, 'admitted once, then dropped from the pending set');
  assert.equal(calls, 1);
});

test('an undated find deferred by the date-check cap is checked on a later pass without a second sighting', async () => {
  let listed = 0;
  const once = { name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
    discover: async () => (listed++ === 0 ? [{ url: TB, title: 'School Girls review', source: 'outlet-index', publishDate: null, needsDate: true }] : []) };
  const memo = { rejected: {} };
  const run = (maxDateChecks) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [once], fetchText: async () => PAGE, memo, maxDateChecks });
  assert.deepEqual((await run(0)).deferredDateChecks, [KEY]);
  assert.deepEqual((await run(10)).admitted.map((a) => a.key), [KEY]);
});

test('a pending find that keeps failing is given up after three date-check failures, not retried forever', async () => {
  let calls = 0; let listed = 0;
  const once = { name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
    discover: async () => (listed++ === 0 ? [{ url: TB, title: 'School Girls review', source: 'outlet-index', publishDate: null, needsDate: true }] : []) };
  const fetchText = async () => { calls++; throw new Error('All scraping methods failed'); };
  const memo = { rejected: {} };
  for (let i = 0; i < 6; i++) await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [once], fetchText, memo });
  assert.equal(calls, 3);
  assert.deepEqual(memo.rejected[KEY], { reason: 'date-check-failed', attempts: 3, dateFails: 3 });
});

test('a not-review-like strike from another sighting does not count toward the three date-check failures', async () => {
  const memo = { rejected: { [KEY]: { reason: 'not-review-like', attempts: 1 } } };
  let calls = 0;
  const signalled = { name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
    discover: async () => [{ url: TB, title: 'School Girls', source: 'outlet-index', publishDate: null, needsDate: true, reviewSignalGiven: true }] };
  const fetchText = async () => { calls++; throw new Error('All scraping methods failed'); };
  for (let i = 0; i < 6; i++) await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [signalled], fetchText, memo });
  assert.equal(calls, 3, 'three date-check tries, the earlier strike aside');
});

// BRO-6872 review of the pending fix: each of these spent paid fetches without end, or lost the find again.
const listedOnce = (extra = {}) => { let n = 0; return { name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
  discover: async () => (n++ === 0 ? [{ url: TB, title: 'School Girls review', source: 'outlet-index', publishDate: null, needsDate: true, ...extra }] : []) }; };
const runWith = (adapter, fetchText, memo, opts = {}) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters: [adapter], fetchText, memo, ...opts });

test('sightings that alternate between a bare title and a review signal stop after three failed date checks', async () => {
  let calls = 0; let i = 0;
  const alternating = { name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
    discover: async () => [{ url: TB, title: 'School Girls', source: 'outlet-index', publishDate: null, needsDate: true, ...(i++ % 2 === 0 ? { reviewSignalGiven: true } : {}) }] };
  const memo = { rejected: {} };
  for (let p = 0; p < 12; p++) await runWith(alternating, async () => { calls++; throw new Error('All scraping methods failed'); }, memo);
  assert.equal(calls, 3);
});

test('a pending find no index lists again is dropped after PENDING_MAX_TIMEOUTS timed-out date checks', async () => {
  let calls = 0;
  const memo = { rejected: {} };
  const slow = async () => { calls++; await sleep(80); return PAGE; };
  // The adapter's 1000 ms cap is replaced by 30 ms so each check times out inside the pass.
  const adapter = { ...listedOnce(), fetchTimeoutMs: 30 };
  for (let p = 0; p < 8; p++) await runWith(adapter, slow, memo);
  assert.equal(calls, 4, 'the listed pass plus three pending-only timeouts');
  assert.deepEqual(memo.rejected, {}, 'timeouts are no strike');
});

test('a challenge page from the date check (no date on it) is a strike and the find stays pending until the page answers', async () => {
  let calls = 0;
  const memo = { rejected: {} };
  const fetchText = async () => (++calls === 1 ? '<html><title>Just a moment...</title></html>' : PAGE);
  assert.equal((await runWith(listedOnce(), fetchText, memo)).admitted.length, 0);
  assert.deepEqual(memo.rejected[KEY], { reason: 'date-check-failed', attempts: 1, dateFails: 1 });
  assert.deepEqual((await runWith(listedOnce(), fetchText, memo)).admitted.map((a) => a.key), [KEY]);
});

test('a dated find admitted without a date check leaves the pending set', async () => {
  const memo = { rejected: {} };
  let calls = 0;
  const fetchText = async () => { calls++; throw new Error('no fetch expected'); };
  // First pass: listed undated, check cut by the cap (deferred, pending). Second pass: listed again with a date.
  let n = 0;
  const adapter = { name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
    discover: async () => (n++ === 0 ? [{ url: TB, title: 'School Girls review', source: 'outlet-index', publishDate: null, needsDate: true }]
      : n === 2 ? [{ url: TB, title: 'School Girls review', source: 'outlet-index', publishDate: '2026-09-28T23:00:00Z' }] : []) };
  await runWith(adapter, fetchText, memo, { maxDateChecks: 0 });
  assert.equal((await runWith(adapter, fetchText, memo)).admitted.length, 1);
  assert.equal((await runWith(adapter, fetchText, memo)).admitted.length, 0, 'not re-entered from pending');
  assert.equal(calls, 0);
});
