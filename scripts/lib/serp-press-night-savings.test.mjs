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
// No real ScrapingBee key: its credit check is a live HTTPS call that could
// switch ScrapingBee off mid-test when the account runs low.
delete process.env.SCRAPINGBEE_API_KEY;
delete process.env.SCRAPER_SPEND_PURPOSE;

const require = createRequire(import.meta.url);
const axios = require('axios');
const calls = [];
let sdOrganic = [];
let sbOrganic = [];
let bdData = null; // null: Bright Data returns an unparsed page (the old default)
let sdFails = false; // true: Scrapingdog's request errors (a real failure, not an answer)
const stub = async (url) => {
  const u = String(url);
  calls.push(u);
  if (sdFails && u.includes('scrapingdog')) { const e = new Error('Request failed with status code 403'); e.response = { status: 403, data: {} }; throw e; }
  if (u.includes('brightdata') && bdData) return { status: 200, data: bdData };
  const organic = u.includes('scrapingdog') ? sdOrganic : u.includes('scrapingbee') ? sbOrganic : [];
  return { status: 200, data: { organic_results: organic, organic_data: organic } };
};
axios.get = stub;
axios.post = stub;

const { _serpWithChainForTests: chain } = require('./url-discovery.js');
const { domainMatchesExpected } = require('./scraper.js');
const { positiveSiteDomains, isOffDomainOnlyAnswer } = require('./serp-site-filter.js');
const {
  isSlowTrickleMarket, serpSecondOpinionForShow, shouldSkipSecondOpinion,
  shouldAskOtherSecondOpinion, shouldAuditThirdOpinion, isParsedSerpAnswer, effectivePreferSpeed,
} = require('./serp-second-opinion-policy.js');

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

beforeEach(() => {
  calls.length = 0; sdOrganic = []; sbOrganic = []; bdData = null; sdFails = false;
  process.env.SERP_THIRD_OPINION_AUDIT_RATE = '0';
  delete process.env.SERP_THIRD_OPINION;
  delete process.env.SERP_SB_SECOND_OPINION;
});
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

// ---- BRO-7531: ScrapingBee as a third vendor on press nights ----
const BD_EMPTY = { general: { query: 'x' }, organic: [] };
const asked = (name) => hosts().filter((h) => h.includes(name)).length;
const runSpeed = (query) => chain(query, 'sb-key', 'bd-key', log, null, true, undefined, undefined, false, null, 0, undefined);

test('shouldAskOtherSecondOpinion: a parsed Bright Data empty after any Scrapingdog reply on a press night skips (BRO-6867)', () => {
  const skip = { primaryName: 'brightdata', primaryResults: [], primaryStructured: true, tokensDropped: 0, sdClean: true, sdAnswered: true, emptyAuthoritative: false, env: {} };
  assert.equal(shouldAskOtherSecondOpinion(skip), false);
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, sdClean: false }), false, 'filler or all-opaque Scrapingdog reply still counts as a reply');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, sdClean: false, sdAnswered: false }), true, 'Scrapingdog failed or was not asked');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, sdClean: false, env: { SERP_SB_SECOND_OPINION: '1' } }), true, 'kill switch restores the clean-only rule');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, env: { SERP_SB_SECOND_OPINION: '1' } }), false, 'kill switch: clean empty still skips, as in BRO-7531');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, primaryResults: null }), true, 'Bright Data failed');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, primaryStructured: false }), true, 'short / unparsed Bright Data page');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, tokensDropped: 2 }), true, 'unreadable links dropped');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, emptyAuthoritative: true }), true, 'routine flow');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, emptyAuthoritative: undefined }), true, 'routine flow (default)');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, primaryName: 'scrapingbee' }), true, 'ScrapingBee asked first');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, env: { SERP_THIRD_OPINION: '1' } }), true, 'third-opinion kill switch');
  assert.equal(shouldAskOtherSecondOpinion({ ...skip, primaryResults: [{ url: 'https://a.com/x' }] }), false, 'primary found something');
  assert.equal(shouldAskOtherSecondOpinion(), true, 'no context: ask');
});

test('effectivePreferSpeed: press night with a Scrapingdog reply puts Bright Data first; everything else unchanged', () => {
  const pn = { preferSpeed: true, emptyAuthoritative: false, sdAnswered: true, env: {} };
  assert.equal(effectivePreferSpeed(pn), false);
  assert.equal(effectivePreferSpeed({ ...pn, sdAnswered: false }), true, 'Scrapingdog failed: keep the fast vendor first');
  assert.equal(effectivePreferSpeed({ ...pn, emptyAuthoritative: true }), true, 'routine flow');
  assert.equal(effectivePreferSpeed({ ...pn, preferSpeed: false }), false);
  assert.equal(effectivePreferSpeed({ ...pn, env: { SERP_SB_SECOND_OPINION: '1' } }), true, 'kill switch');
});

test('shouldAuditThirdOpinion: 5% by default, env override, bad values fall back', () => {
  assert.equal(shouldAuditThirdOpinion(() => 0.04, {}), true);
  assert.equal(shouldAuditThirdOpinion(() => 0.06, {}), false);
  assert.equal(shouldAuditThirdOpinion(() => 0.5, { SERP_THIRD_OPINION_AUDIT_RATE: '1' }), true);
  assert.equal(shouldAuditThirdOpinion(() => 0, { SERP_THIRD_OPINION_AUDIT_RATE: '0' }), false);
  assert.equal(shouldAuditThirdOpinion(() => 0.04, { SERP_THIRD_OPINION_AUDIT_RATE: 'abc' }), true);
  assert.equal(shouldAuditThirdOpinion(() => 0.04, { SERP_THIRD_OPINION_AUDIT_RATE: '7' }), true);
});

test('Broadway press night: a real Bright Data empty after a clean Scrapingdog empty does not reach ScrapingBee, and nothing is cached', async () => {
  bdData = BD_EMPTY;
  const query = `site:example-outlet.com "BW Third" Broadway review ${q++}`;
  const r = await run(query, false, undefined);
  assert.deepEqual(r.results, []);
  assert.ok(asked('brightdata') > 0, 'Bright Data must still be asked');
  assert.equal(asked('scrapingbee'), 0, `ScrapingBee asked: ${hosts().join(',')}`);
  const first = calls.length;
  await run(query, false, undefined);
  assert.ok(calls.length > first, 'next pass must ask again (empty was not cached)');
});

test('Broadway press night: off-domain Scrapingdog filler plus a Bright Data empty does not reach ScrapingBee (BRO-6867)', async () => {
  bdData = BD_EMPTY;
  sdOrganic = JUNK;
  const r = await run(`site:example-outlet.com "BW Filler" Broadway review ${q++}`, false, undefined);
  assert.equal(r.provider, 'scrapingdog');
  assert.ok(asked('brightdata') > 0, 'Bright Data is the second opinion');
  assert.equal(asked('scrapingbee'), 0, `ScrapingBee asked: ${hosts().join(',')}`);
});

test('Broadway press night: kill switch SERP_SB_SECOND_OPINION=1 asks ScrapingBee after filler and a Bright Data empty', async () => {
  bdData = BD_EMPTY;
  sdOrganic = JUNK;
  process.env.SERP_SB_SECOND_OPINION = '1';
  await run(`site:example-outlet.com "BW FillerKill" Broadway review ${q++}`, false, undefined);
  assert.ok(asked('scrapingbee') > 0);
});

test('West End press night: a two-vendor empty is never parked in the 45-min negative cache', async () => {
  bdData = BD_EMPTY;
  const query = `site:example-outlet.com "WE Third" West End review ${q++}`;
  await run(query, false, undefined, 45 * 60 * 1000);
  assert.equal(asked('scrapingbee'), 0);
  const first = calls.length;
  await run(query, false, undefined, 45 * 60 * 1000);
  assert.ok(calls.length > first, 'next pass must ask the vendors again');
});

test('West End press night: an empty from all three vendors (audit sample) is parked for 45 minutes as before', async () => {
  bdData = BD_EMPTY;
  process.env.SERP_THIRD_OPINION_AUDIT_RATE = '1';
  const query = `site:example-outlet.com "WE Parked" West End review ${q++}`;
  await run(query, false, undefined, 45 * 60 * 1000);
  assert.ok(asked('scrapingbee') > 0);
  const first = calls.length;
  await run(query, false, undefined, 45 * 60 * 1000);
  assert.equal(calls.length, first, 'served from the negative cache, no new vendor calls');
});

test('Broadway press night: an unparsed Bright Data page is not an answer, ScrapingBee is still asked', async () => {
  bdData = null;
  await run(`site:example-outlet.com "BW Short" Broadway review ${q++}`, false, undefined);
  assert.ok(asked('brightdata') > 0);
  assert.ok(asked('scrapingbee') > 0, 'ScrapingBee must be asked after a Bright Data non-answer');
});

test('Broadway press night: an organic list without the parsed-page block is not an answer, ScrapingBee is still asked', async () => {
  bdData = { organic: [] };
  assert.equal(isParsedSerpAnswer(bdData), false);
  assert.equal(isParsedSerpAnswer(BD_EMPTY), true);
  assert.equal(isParsedSerpAnswer('<html></html>'), false);
  assert.equal(isParsedSerpAnswer(null), false);
  await run(`site:example-outlet.com "BW Bare" Broadway review ${q++}`, false, undefined);
  assert.ok(asked('scrapingbee') > 0);
});

test('Broadway press night: kill switch SERP_THIRD_OPINION=1 asks ScrapingBee after a real Bright Data empty', async () => {
  bdData = BD_EMPTY;
  process.env.SERP_THIRD_OPINION = '1';
  await run(`site:example-outlet.com "BW Kill" Broadway review ${q++}`, false, undefined);
  assert.ok(asked('scrapingbee') > 0);
});

test('Broadway press night: the audit sample still asks ScrapingBee and its find is returned', async () => {
  bdData = BD_EMPTY;
  process.env.SERP_THIRD_OPINION_AUDIT_RATE = '1';
  const hit = { title: 'BW Audit review', url: 'https://example-outlet.com/2026/11/bw-audit-review/', link: 'https://example-outlet.com/2026/11/bw-audit-review/', snippet: '' };
  sbOrganic = [hit];
  const r = await run(`site:example-outlet.com "BW Audit" Broadway review ${q++}`, false, undefined);
  assert.ok(asked('scrapingbee') > 0);
  assert.equal(r.provider, 'scrapingbee');
  assert.equal(r.results.length, 1);
});

test('press night with preferSpeed: after a Scrapingdog reply, Bright Data goes first and ScrapingBee is not asked (BRO-6867)', async () => {
  bdData = BD_EMPTY;
  await runSpeed(`site:example-outlet.com "BW Speed" Broadway review ${q++}`);
  assert.ok(asked('brightdata') > 0, 'Bright Data is the second opinion');
  assert.equal(asked('scrapingbee'), 0, `ScrapingBee asked: ${hosts().join(',')}`);
});

test('press night with preferSpeed: a failed Bright Data page still falls back to ScrapingBee', async () => {
  bdData = null;
  await runSpeed(`site:example-outlet.com "BW SpeedBdDown" Broadway review ${q++}`);
  const h = hosts().filter((x) => !x.includes('scrapingdog'));
  assert.ok(h[0].includes('brightdata'), `Bright Data first: ${h.join(',')}`);
  assert.ok(asked('scrapingbee') > 0, 'ScrapingBee is the backup when Bright Data fails');
});

test('press night with preferSpeed: when Scrapingdog fails, ScrapingBee is still asked first as before', async () => {
  bdData = BD_EMPTY;
  sdFails = true;
  await runSpeed(`site:example-outlet.com "BW SpeedSdDown" Broadway review ${q++}`);
  const h = hosts().filter((x) => !x.includes('scrapingdog'));
  assert.ok(h[0] && h[0].includes('scrapingbee'), `ScrapingBee first: ${h.join(',')}`);
  assert.ok(asked('brightdata') > 0, 'both vendors asked when Scrapingdog gave no reply');
});

test('press night with preferSpeed: kill switch SERP_SB_SECOND_OPINION=1 restores ScrapingBee first', async () => {
  bdData = BD_EMPTY;
  process.env.SERP_SB_SECOND_OPINION = '1';
  await runSpeed(`site:example-outlet.com "BW SpeedKill" Broadway review ${q++}`);
  const h = hosts().filter((x) => !x.includes('scrapingdog'));
  assert.ok(h[0] && h[0].includes('scrapingbee'), `ScrapingBee first: ${h.join(',')}`);
});
