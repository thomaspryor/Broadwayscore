/**
 * BRO-7531: Scrapingdog ignores the site: filter on roughly 1 ask in 3 and
 * answers with unrelated domains. The chain asks it once more; only an
 * on-domain second answer replaces the first. Drives the real _serpWithChain
 * with axios stubbed: no network, no spend.
 * Run: node --test scripts/lib/serp-site-reask.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-reask-'));
process.env.SCRAPINGDOG_API_KEY = 'sd-test';
process.env.SCRAPER_USE_SCRAPINGDOG = '1';
process.env.BD_SERP_CACHE_DIR = path.join(tmp, 'serp-cache');
process.env.BD_SERP_NEGATIVE_CACHE_DIR = path.join(tmp, 'serp-neg-cache');
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(tmp, 'ledger.jsonl');
process.env.BD_BREAKER_STATE_PATH = path.join(tmp, 'bd-breaker.json');
process.env.SD_BREAKER_STATE_PATH = path.join(tmp, 'sd-breaker.json');
process.env.SB_BREAKER_STATE_PATH = path.join(tmp, 'sb-breaker.json');
delete process.env.SERP_SITE_REASK;
delete process.env.SCRAPER_SPEND_PURPOSE;

const require = createRequire(import.meta.url);
const axios = require('axios');
const calls = [];
let sdAnswers = []; // one entry per Scrapingdog ask; 'fail' throws; the last entry repeats
let otherOrganic = []; // what ScrapingBee / Bright Data answer
const stub = async (url) => {
  const u = String(url);
  calls.push(u);
  if (!u.includes('scrapingdog')) return { status: 200, data: { organic_results: otherOrganic, organic: otherOrganic } };
  const n = calls.filter((c) => c.includes('scrapingdog')).length;
  const answer = sdAnswers[Math.min(n - 1, sdAnswers.length - 1)];
  if (answer === 'fail') {
    const err = new Error('Request failed with status code 400');
    err.response = { status: 400, data: {} };
    throw err;
  }
  return { status: 200, data: { organic_results: answer } };
};
axios.get = stub;
axios.post = stub;

const { _serpWithChainForTests: chain } = require('./url-discovery.js');
const { domainMatchesExpected } = require('./scraper.js');
const { shouldReaskIgnoredSiteFilter, preferReaskAnswer } = require('./serp-site-filter.js');
const { shouldReaskEmptyWithoutSecondOpinion, shouldEscalateOffDomainAnswer } = require('./serp-second-opinion-policy.js');

const log = () => {};
let q = 0;
const sdCalls = () => calls.filter((c) => c.includes('scrapingdog')).length;
const otherCalls = () => calls.length - sdCalls();
const JUNK = [
  { title: 'A video', link: 'https://www.youtube.com/watch?v=abc', snippet: '' },
  { title: 'Forum', link: 'https://forum.broadwayworld.com/thread/Something', snippet: '' },
];
const GOOD = [{ title: 'Review: Some Show', link: 'https://variety.com/2026/legit/reviews/some-show-review-1234/', snippet: '' }];
const run = (query, emptyAuthoritative = true, chainOpts = undefined, negTtl = null, skipProviders = undefined) =>
  chain(query, 'sb-key', 'bd-key', log, null, false, undefined, skipProviders, emptyAuthoritative, negTtl, 0, chainOpts);

beforeEach(() => { calls.length = 0; sdAnswers = [[]]; otherOrganic = []; delete process.env.SERP_SITE_REASK; });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('deciders: re-ask only an off-domain-only answer to a positive site: query; kill switch', () => {
  const Q = 'site:variety.com "Some Show" Broadway review 2026';
  assert.equal(shouldReaskIgnoredSiteFilter(Q, JUNK, domainMatchesExpected, {}), true);
  assert.equal(shouldReaskIgnoredSiteFilter(Q, GOOD, domainMatchesExpected, {}), false);
  assert.equal(shouldReaskIgnoredSiteFilter(Q, [], domainMatchesExpected, {}), false, 'a clean empty is not re-asked');
  assert.equal(shouldReaskIgnoredSiteFilter(Q, null, domainMatchesExpected, {}), false, 'a failure goes to the provider chain');
  assert.equal(shouldReaskIgnoredSiteFilter('"Some Show" Broadway review', JUNK, domainMatchesExpected, {}), false);
  assert.equal(shouldReaskIgnoredSiteFilter('"Brand" -site:broadwayscorecard.com', JUNK, domainMatchesExpected, {}), false);
  assert.equal(shouldReaskIgnoredSiteFilter(Q, JUNK, domainMatchesExpected, { SERP_SITE_REASK: '0' }), false);
  assert.equal(preferReaskAnswer(Q, GOOD, domainMatchesExpected), true);
  assert.equal(preferReaskAnswer(Q, JUNK, domainMatchesExpected), false);
  assert.equal(preferReaskAnswer(Q, [], domainMatchesExpected), false, 'an empty re-ask does not replace the first answer');
  assert.equal(preferReaskAnswer(Q, null, domainMatchesExpected), false);
});

test('filter ignored, re-ask on-domain: 2 Scrapingdog asks, on-domain results returned and cached 24h', async () => {
  const query = `site:variety.com "Some Show" Broadway review ${q++}`;
  sdAnswers = [JUNK, GOOD];
  const r = await run(query);
  assert.equal(sdCalls(), 2);
  assert.equal(otherCalls(), 0);
  assert.equal(r.provider, 'scrapingdog');
  assert.match(r.results[0].url, /variety\.com/);
  const again = await run(query);
  assert.equal(sdCalls(), 2, 'second run is a cache hit');
  assert.equal(again.provider, 'scrapingdog-cached');
  assert.match(again.results[0].url, /variety\.com/);
});

test('filter ignored twice: exactly 2 asks, first answer kept and cached on a routine flow', async () => {
  const query = `site:variety.com "Some Show" Broadway review ${q++}`;
  sdAnswers = [JUNK, JUNK];
  const r = await run(query);
  assert.equal(sdCalls(), 2, 'one re-ask, never a loop');
  assert.equal(otherCalls(), 0, 'a non-empty answer never reaches ScrapingBee / Bright Data');
  assert.equal(r.provider, 'scrapingdog');
  assert.equal(r.results.length, 2);
  await run(query);
  assert.equal(sdCalls(), 2, 'routine flow still caches the answer for 24h');
});

test('re-ask comes back empty or fails: first answer kept, no other provider asked', async () => {
  for (const second of [[], 'fail']) {
    calls.length = 0;
    sdAnswers = [JUNK, second];
    const r = await run(`site:variety.com "Some Show" Broadway review ${q++}`);
    assert.equal(r.provider, 'scrapingdog');
    assert.equal(r.results.length, 2);
    assert.equal(otherCalls(), 0);
  }
});

test('no re-ask: on-domain first answer, no site: clause, clean empty, or SERP_SITE_REASK=0', async () => {
  sdAnswers = [GOOD, JUNK];
  await run(`site:variety.com "Some Show" Broadway review ${q++}`);
  assert.equal(sdCalls(), 1, 'on-domain answer');

  calls.length = 0; sdAnswers = [JUNK, GOOD];
  await run(`"Some Show" Broadway review "Variety" ${q++}`);
  assert.equal(sdCalls(), 1, 'no site: clause');

  calls.length = 0; sdAnswers = [[], GOOD];
  const empty = await run(`site:variety.com "Some Show" Broadway review ${q++}`);
  assert.equal(sdCalls(), 1, 'clean empty');
  assert.equal(empty.provider, 'scrapingdog-empty');

  calls.length = 0; sdAnswers = [JUNK, GOOD];
  process.env.SERP_SITE_REASK = '0';
  const off = await run(`site:variety.com "Some Show" Broadway review ${q++}`);
  assert.equal(sdCalls(), 1, 'kill switch');
  assert.equal(off.results.length, 2);
});

test('press night: a re-ask that finds the page is returned and cached; one that does not is still never cached', async () => {
  const found = `site:variety.com "Some Show" Broadway review ${q++}`;
  sdAnswers = [JUNK, GOOD];
  const r = await run(found, false, { secondOpinion: false });
  assert.match(r.results[0].url, /variety\.com/);
  await run(found, false, { secondOpinion: false });
  assert.equal(sdCalls(), 2, 'on-domain answer is cacheable on press night as before');

  calls.length = 0;
  const missed = `site:variety.com "Some Show" Broadway review ${q++}`;
  sdAnswers = [JUNK, JUNK];
  await run(missed, false, { secondOpinion: false });
  assert.equal(sdCalls(), 2);
  await run(missed, false, { secondOpinion: false });
  assert.equal(sdCalls(), 4, 'next tick asks again (not cached), with its own single re-ask');
});

test('deciders: empty re-ask only where the second opinion is off; off-domain escalation only where it is on', () => {
  assert.equal(shouldReaskEmptyWithoutSecondOpinion([], false, false, 0, {}), true);
  assert.equal(shouldReaskEmptyWithoutSecondOpinion([], false, true, 0, {}), false, 'Broadway asks ScrapingBee / Bright Data instead');
  assert.equal(shouldReaskEmptyWithoutSecondOpinion([], true, false, 0, {}), false, 'routine flow: the empty is authoritative');
  assert.equal(shouldReaskEmptyWithoutSecondOpinion(null, false, false, 0, {}), false, 'a failure fails over');
  assert.equal(shouldReaskEmptyWithoutSecondOpinion([], false, false, 2, {}), false, 'an all-opaque answer fails over');
  assert.equal(shouldReaskEmptyWithoutSecondOpinion([], false, false, 0, { SERP_SITE_REASK: '0' }), false, 'kill switch');
  assert.equal(shouldEscalateOffDomainAnswer(true, false, true), true);
  assert.equal(shouldEscalateOffDomainAnswer(true, false, false), false, 'OB / off-West-End keep one provider');
  assert.equal(shouldEscalateOffDomainAnswer(true, true, true), false, 'routine flow');
  assert.equal(shouldEscalateOffDomainAnswer(false, false, true), false);
});

test('OB press night: a clean empty is asked once more before it stands; never a third ask, never SB/BD', async () => {
  sdAnswers = [[], GOOD];
  const found = await run(`site:variety.com "Some Show" Off-Broadway review ${q++}`, false, { secondOpinion: false });
  assert.equal(sdCalls(), 2);
  assert.equal(otherCalls(), 0);
  assert.equal(found.provider, 'scrapingdog');
  assert.match(found.results[0].url, /variety\.com/);

  for (const second of [[], JUNK, 'fail']) {
    calls.length = 0; sdAnswers = [[], second];
    const r = await run(`site:variety.com "Some Show" Off-Broadway review ${q++}`, false, { secondOpinion: false });
    assert.equal(sdCalls(), 2, 'exactly one re-ask');
    assert.equal(otherCalls(), 0);
    assert.deepEqual(r.results, []);
    assert.equal(r.provider, 'scrapingdog-empty-uncached');
  }

  calls.length = 0; sdAnswers = [[], GOOD];
  process.env.SERP_SITE_REASK = '0';
  const off = await run(`site:variety.com "Some Show" Off-Broadway review ${q++}`, false, { secondOpinion: false });
  assert.equal(sdCalls(), 1, 'kill switch');
  assert.deepEqual(off.results, []);
});

test('Broadway press night: filler twice reaches the second opinion; its on-domain answer wins and is cached', async () => {
  const query = `site:variety.com "Some Show" Broadway review ${q++}`;
  sdAnswers = [JUNK, JUNK];
  otherOrganic = GOOD;
  const r = await run(query, false);
  assert.equal(sdCalls(), 2);
  assert.ok(otherCalls() > 0, 'ScrapingBee / Bright Data must be asked');
  assert.notEqual(r.provider, 'scrapingdog');
  assert.match(r.results[0].url, /variety\.com/);
  const before = calls.length;
  const again = await run(query, false);
  assert.equal(calls.length, before, 'an on-domain answer is cacheable');
  assert.match(again.results[0].url, /variety\.com/);
});

test('Broadway press night: filler twice and an empty second opinion returns the filler, uncached', async () => {
  const query = `site:variety.com "Some Show" Broadway review ${q++}`;
  sdAnswers = [JUNK, JUNK];
  const r = await run(query, false);
  assert.ok(otherCalls() > 0);
  assert.equal(r.provider, 'scrapingdog');
  assert.equal(r.results.length, 2, 'callers see what they saw before');
  const before = calls.length;
  await run(query, false);
  assert.ok(calls.length > before, 'next tick asks live again');
});

test('a skip-truncated run does not park an answer in the 45-min negative cache', async () => {
  const TTL = 45 * 60 * 1000;
  for (const [first, opts] of [[[[], []], { secondOpinion: false }], [[JUNK, JUNK], { secondOpinion: false }]]) {
    const query = `site:variety.com "Some Show" Off-Broadway review ${q++}`;
    calls.length = 0; sdAnswers = first;
    await run(query, false, opts, TTL, ['scrapingbee']);
    const before = calls.length;
    const normal = await run(query, false, opts, TTL);
    assert.ok(calls.length > before, 'the normal run must ask live');
    assert.doesNotMatch(normal.provider, /negcached$/);
    const parked = calls.length;
    await run(query, false, opts, TTL);
    assert.equal(calls.length, parked, 'a normal run does park it');
  }
});
