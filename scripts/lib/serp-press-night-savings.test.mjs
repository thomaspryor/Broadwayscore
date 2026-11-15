/**
 * BRO-7531: press-night SERP coverage + spend rules.
 *  - A `site:` answer with no on-domain result is Google's "no exact match"
 *    filler. On emptyAuthoritative:false flows it must never be served from or
 *    written to the 24h cache (it hid fresh reviews for up to a day).
 *  - OB / off-West-End press nights accept a clean Scrapingdog empty for the
 *    tick without a ScrapingBee / Bright Data re-ask, and still never cache it.
 * Drives the real _serpWithChain with axios stubbed: no network, no spend.
 * Run: node --test scripts/lib/serp-press-night-savings.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-savings-'));
process.env.SCRAPINGDOG_API_KEY = 'sd-test';
process.env.SCRAPER_USE_SCRAPINGDOG = '1';
process.env.BD_SERP_CACHE_DIR = path.join(tmp, 'serp-cache');
process.env.BD_SERP_NEGATIVE_CACHE_DIR = path.join(tmp, 'serp-neg-cache');
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(tmp, 'ledger.jsonl');
process.env.BD_BREAKER_STATE_PATH = path.join(tmp, 'bd-breaker.json');
process.env.SD_BREAKER_STATE_PATH = path.join(tmp, 'sd-breaker.json');
process.env.SB_BREAKER_STATE_PATH = path.join(tmp, 'sb-breaker.json');
delete process.env.SERP_OB_SECOND_OPINION;
delete process.env.SCRAPER_SPEND_PURPOSE;

const require = createRequire(import.meta.url);
const axios = require('axios');
const calls = [];
let sdOrganic = [];
const stub = async (url) => {
  calls.push(String(url));
  const isSd = String(url).includes('scrapingdog');
  return { status: 200, data: { organic_results: isSd ? sdOrganic : [], organic_data: isSd ? sdOrganic : [] } };
};
axios.get = stub;
axios.post = stub;

const { _serpWithChainForTests: chain } = require('./url-discovery.js');
const { domainMatchesExpected } = require('./scraper.js');
const { positiveSiteDomains, isOffDomainOnlyAnswer } = require('./serp-site-filter.js');
const { isSlowTrickleMarket, serpSecondOpinionForShow, shouldSkipSecondOpinion } = require('./serp-second-opinion-policy.js');

const log = () => {};
let q = 0;
const hosts = () => calls.map((u) => new URL(u).host);
const nonSd = () => hosts().filter((h) => !h.includes('scrapingdog'));
const JUNK = [
  { title: 'A video', link: 'https://www.youtube.com/watch?v=abc', snippet: '' },
  { title: 'Roundup', link: 'https://www.broadwayworld.com/reviews/Something', snippet: '' },
];
const run = (query, emptyAuthoritative, chainOpts, negTtl = null) =>
  chain(query, 'sb-key', 'bd-key', log, null, false, undefined, undefined, emptyAuthoritative, negTtl, 0, chainOpts);

beforeEach(() => { calls.length = 0; sdOrganic = []; });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('positiveSiteDomains: groups, paths, www and negated clauses', () => {
  assert.deepEqual(positiveSiteDomains('(site:vulture.com OR site:nymag.com) "X" review'), ['vulture.com', 'nymag.com']);
  assert.deepEqual(positiveSiteDomains('site:reddit.com/r/Broadway "X"'), ['reddit.com']);
  assert.deepEqual(positiveSiteDomains('site:www.nytimes.com "X"'), ['nytimes.com']);
  assert.deepEqual(positiveSiteDomains('"Broadway Scorecard" -site:broadwayscorecard.com -site:x.com'), []);
  assert.deepEqual(positiveSiteDomains('"X" Broadway review 2026'), []);
  assert.deepEqual(positiveSiteDomains(null), []);
});

test('isOffDomainOnlyAnswer: only a non-empty, all-off-domain answer to a positive site: query', () => {
  const Q = 'site:nystagereview.com "The Visitors" Off-Broadway review 2026';
  assert.equal(isOffDomainOnlyAnswer(Q, JUNK, domainMatchesExpected), true);
  assert.equal(isOffDomainOnlyAnswer(Q, [...JUNK, { link: 'https://nystagereview.com/2026/11/09/x/' }], domainMatchesExpected), false);
  assert.equal(isOffDomainOnlyAnswer(Q, [], domainMatchesExpected), false, 'a real empty is handled elsewhere');
  assert.equal(isOffDomainOnlyAnswer(Q, null, domainMatchesExpected), false);
  assert.equal(isOffDomainOnlyAnswer('"The Visitors" review', JUNK, domainMatchesExpected), false, 'no site: clause');
  assert.equal(isOffDomainOnlyAnswer('"Brand" -site:broadwayscorecard.com', JUNK, domainMatchesExpected), false, 'exclusions are not restrictions');
  // subdomain + url field + unparsable url
  assert.equal(isOffDomainOnlyAnswer('site:nytimes.com "X"', [{ url: 'https://theater.nytimes.com/a' }], domainMatchesExpected), false);
  assert.equal(isOffDomainOnlyAnswer('site:nytimes.com "X"', [{ url: 'not a url' }], domainMatchesExpected), true);
  // alias group stays in step with discoverCorrectUrl's host gate
  assert.equal(isOffDomainOnlyAnswer('site:vulture.com "X"', [{ url: 'https://nymag.com/a' }], domainMatchesExpected), false);
});

test('policy: only off-broadway / off-west-end drop the second opinion; unknown keeps it', () => {
  assert.equal(isSlowTrickleMarket({ category: 'off-broadway' }), true);
  assert.equal(isSlowTrickleMarket({ market: 'off-west-end' }), true, 'market-only show matches the poller gate');
  assert.equal(serpSecondOpinionForShow({ category: 'off-broadway' }), false);
  assert.equal(serpSecondOpinionForShow({ category: 'off-west-end' }), false);
  assert.equal(serpSecondOpinionForShow({ category: 'broadway' }), true);
  assert.equal(serpSecondOpinionForShow({ category: 'west-end' }), true);
  assert.equal(serpSecondOpinionForShow({}), true);
  assert.equal(serpSecondOpinionForShow(null), true);
  process.env.SERP_OB_SECOND_OPINION = '1';
  try { assert.equal(serpSecondOpinionForShow({ category: 'off-broadway' }), true, 'kill switch'); }
  finally { delete process.env.SERP_OB_SECOND_OPINION; }
});

test('shouldSkipSecondOpinion: never for a failure, an opaque answer, or a cacheable flow', () => {
  assert.equal(shouldSkipSecondOpinion([], false, false, 0), true);
  assert.equal(shouldSkipSecondOpinion(null, false, false, 0), false, 'SD failure must fail over');
  assert.equal(shouldSkipSecondOpinion([], false, false, 3), false, 'opaque-dropped is not "nothing found"');
  assert.equal(shouldSkipSecondOpinion([], false, true, 0), false, 'Broadway keeps the re-ask');
  assert.equal(shouldSkipSecondOpinion([], true, false, 0), false, 'routine flow is shouldAcceptEmptyScrapingdogSerp territory');
  assert.equal(shouldSkipSecondOpinion([{ url: 'x' }], false, false, 0), false);
});

test('OB press night: clean SD empty is final for the tick, no SB/BD call, and not cached', async () => {
  const query = `site:example-outlet.com "OB Show" Off-Broadway review ${q++}`;
  const r = await run(query, false, { secondOpinion: false });
  assert.deepEqual(r.results, []);
  assert.equal(r.provider, 'scrapingdog-empty-uncached');
  assert.deepEqual(nonSd(), [], `unexpected providers: ${hosts().join(',')}`);
  const first = calls.length;
  await run(query, false, { secondOpinion: false });
  assert.ok(calls.length > first, 'next tick must ask Scrapingdog again (empty was not cached)');
});

test('Broadway press night (default): clean SD empty still gets the second opinion (BRO-5914 intact)', async () => {
  const r = await run(`site:example-outlet.com "BW Show" Broadway review ${q++}`, false, undefined);
  assert.notEqual(r.provider, 'scrapingdog-empty-uncached');
  assert.ok(nonSd().length > 0, 'SB/BD must be asked');
});

test('press night: an off-domain-only answer is returned but NOT cached, so the next tick asks again', async () => {
  const query = `site:nystagereview.com "Junk Show" Off-Broadway review ${q++}`;
  sdOrganic = JUNK;
  const r1 = await run(query, false, { secondOpinion: false });
  assert.equal(r1.provider, 'scrapingdog');
  assert.equal(r1.results.length, 2, 'results are returned unchanged');
  assert.deepEqual(nonSd(), [], 'a non-empty answer never triggered a second opinion and still does not');
  const first = calls.length;
  sdOrganic = [{ title: 'Review', link: 'https://nystagereview.com/2026/11/09/junk-show/', snippet: '' }];
  const r2 = await run(query, false, { secondOpinion: false });
  assert.ok(calls.length > first, 'second ask must be live, not a 24h cache hit');
  assert.equal(r2.provider, 'scrapingdog');
  assert.match(r2.results[0].url || r2.results[0].link, /nystagereview\.com/);
});

test('press night: an off-domain-only answer cached earlier by a routine run is not served', async () => {
  const query = `site:nystagereview.com "Stale Cache Show" Off-Broadway review ${q++}`;
  sdOrganic = JUNK;
  const routine = await run(query, true, undefined);
  assert.equal(routine.provider, 'scrapingdog', 'routine flow caches it as before');
  const cachedAgain = await run(query, true, undefined);
  assert.equal(cachedAgain.provider, 'scrapingdog-cached', 'routine flow still reads its 24h cache');
  const before = calls.length;
  const pn = await run(query, false, { secondOpinion: false });
  assert.ok(calls.length > before, 'press-night flow must go live past the cached filler');
  assert.equal(pn.provider, 'scrapingdog');
});

test('press night with the 45-min negative cache: off-domain filler is parked there, not in the 24h cache', async () => {
  const query = `site:nystagereview.com "Neg Cache Show" Off-Broadway review ${q++}`;
  sdOrganic = JUNK;
  await run(query, false, { secondOpinion: false }, 45 * 60 * 1000);
  const before = calls.length;
  const again = await run(query, false, { secondOpinion: false }, 45 * 60 * 1000);
  assert.equal(calls.length, before, 'within 45 min the negative cache answers');
  assert.match(again.provider, /negcached$/);
  const noOptIn = await run(query, false, { secondOpinion: false }, null);
  assert.ok(calls.length > before, 'a caller without the negative cache asks live (nothing in the 24h cache)');
  assert.equal(noOptIn.provider, 'scrapingdog');
});

test('routine flow: an on-domain answer is cached 24h exactly as before', async () => {
  const query = `site:nystagereview.com "Good Show" Broadway review ${q++}`;
  sdOrganic = [{ title: 'Review', link: 'https://nystagereview.com/2026/01/01/good-show/', snippet: '' }];
  await run(query, false, undefined);
  const before = calls.length;
  const again = await run(query, false, undefined);
  assert.equal(calls.length, before);
  assert.equal(again.provider, 'scrapingdog-cached');
});
