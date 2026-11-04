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
  assert.deepEqual(memo.rejected[KEY], { reason: 'date-check-failed', attempts: 1 });
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
