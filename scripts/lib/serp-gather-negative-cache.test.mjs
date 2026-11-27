/**
 * BRO-8323: gather-reviews parks a non-Broadway press-night SERP empty for 2.5h,
 * so back-to-back re-gathers stop re-paying the same ~150 outlet queries. Broadway
 * and unknown categories keep re-asking every pass.
 * Drives the real _serpWithChain with axios stubbed (no network, no spend).
 * Run: node --test scripts/lib/serp-gather-negative-cache.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-negcache-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.SCRAPINGDOG_API_KEY = 'sd-test';
process.env.SCRAPER_USE_SCRAPINGDOG = '1';
process.env.BD_SERP_CACHE_DIR = path.join(tmp, 'serp-cache');
process.env.BD_SERP_NEGATIVE_CACHE_DIR = path.join(tmp, 'neg-cache');
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(tmp, 'ledger.jsonl');
process.env.BD_BREAKER_STATE_PATH = path.join(tmp, 'bd-breaker.json');
process.env.SD_BREAKER_STATE_PATH = path.join(tmp, 'sd-breaker.json');
process.env.SB_BREAKER_STATE_PATH = path.join(tmp, 'sb-breaker.json');
delete process.env.GATHER_SERP_NEGCACHE_DISABLED;

const require = createRequire(import.meta.url);
const axios = require('axios');
const calls = [];
const stub = async (url) => {
  calls.push(String(url));
  return { status: 200, data: { organic_results: [], organic_data: [] } };
};
axios.get = stub;
axios.post = stub;

const showsPath = path.join(tmp, 'shows.json');
fs.writeFileSync(showsPath, JSON.stringify({ shows: [
  { id: 'we-show-2026', category: 'west-end' },
  { id: 'bway-show-2026', category: 'broadway' },
] }));
const gate = require('./sb-market-gate.js');
gate._setShowsPathForTests(showsPath);

const { _serpWithChainForTests: chain } = require('./url-discovery.js');
const caps = require('./scrapingdog-caps.js');
const sp = require('./spend-purpose.js');
const policy = require('./serp-negative-cache-policy.js');
const gatherStore = require('./serp-gather-negative-cache.js');
const serpCache = require('./serp-cache.js');

const log = () => {};
let q = 0;

beforeEach(() => {
  calls.length = 0;
  caps._resetForTests();
  fs.rmSync(process.env.SCRAPER_SPEND_LEDGER_PATH, { force: true });
});

// One gather SERP call exactly as gather-reviews.js makes it on press night.
async function gatherAsk(query, showId) {
  process.env.SCRAPER_SPEND_SHOW_ID = showId;
  process.env.SCRAPER_SPEND_PURPOSE = sp.pressNightPurpose(showId, '2026-11-24');
  const opts = policy.gatherNegativeCacheOpts({ show: { id: showId, category: gate.categoryForShowId(showId) }, emptyAuthoritative: false });
  const chainOpts = { secondOpinion: true, negativeCacheStore: opts.negativeCacheStore || null };
  return chain(query, 'sb-key', 'bd-key', log, null, true, undefined, undefined, false, opts.negativeCacheTtlMs || null, 0, chainOpts);
}

test('policy: only non-Broadway press-night calls opt in, Broadway and unknown never do', () => {
  const ttl = 2.5 * 60 * 60 * 1000;
  for (const category of ['west-end', 'off-west-end', 'off-broadway', 'regional', 'tour']) {
    assert.deepEqual(policy.gatherNegativeCacheOpts({ show: { category }, emptyAuthoritative: false }), { negativeCacheTtlMs: ttl, negativeCacheStore: 'gather' }, category);
  }
  for (const category of ['broadway', null, undefined, 'opera', '']) {
    assert.deepEqual(policy.gatherNegativeCacheOpts({ show: { category }, emptyAuthoritative: false }), {}, String(category));
  }
  // Outside press night empties are already cached 24h: nothing to add.
  assert.deepEqual(policy.gatherNegativeCacheOpts({ show: { category: 'west-end' }, emptyAuthoritative: true }), {});
  assert.deepEqual(policy.gatherNegativeCacheOpts({ show: { category: 'west-end' }, emptyAuthoritative: false }, { GATHER_SERP_NEGCACHE_DISABLED: '1' }), {});
});

test('West End press night: second pass within 2.5h is answered from the cache (zero provider calls)', async () => {
  const query = `site:thestage.co.uk "We Show" review ${q++}`;
  await gatherAsk(query, 'we-show-2026');
  assert.ok(calls.length > 0, 'first pass asks providers');
  calls.length = 0;
  const r = await gatherAsk(query, 'we-show-2026');
  assert.equal(calls.length, 0, `second pass must not call providers: ${calls.join(',')}`);
  assert.deepEqual(r.results, []);
  assert.match(r.provider, /negcached$/);
});

test('West End: an entry older than 2.5h is re-asked', async () => {
  const query = `site:thestage.co.uk "We Show" review ${q++}`;
  await gatherAsk(query, 'we-show-2026');
  for (const f of fs.readdirSync(process.env.BD_SERP_CACHE_DIR)) {
    const old = (Date.now() - 2.6 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(process.env.BD_SERP_CACHE_DIR, f), old, old);
  }
  calls.length = 0;
  await gatherAsk(query, 'we-show-2026');
  assert.ok(calls.length > 0, 'expired entry must be re-asked');
});

test('Broadway press night: every pass re-asks, exactly as before', async () => {
  const query = `site:nytimes.com "Bway Show" review ${q++}`;
  await gatherAsk(query, 'bway-show-2026');
  const first = calls.length;
  assert.ok(first > 0);
  await gatherAsk(query, 'bway-show-2026');
  assert.ok(calls.length > first, 'Broadway second pass must hit providers again');
});

test('store lives flat in the 24h cache dir (so gather-reviews.yml carries it) and never answers a 24h-cache lookup', () => {
  const query = `"Collision Probe" review ${q++}`;
  const opts = { geo: 'gb', dateMin: '', dateMax: '', nosb: '1' };
  gatherStore.set(query, opts, { results: [], provider: 'scrapingdog' });
  const entries = fs.readdirSync(process.env.BD_SERP_CACHE_DIR, { withFileTypes: true });
  assert.ok(entries.every((e) => e.isFile()), 'no subdirectories: the merge step copies with a plain cp');
  assert.equal(serpCache.get(query, opts), null, 'the 24h positive cache must not read a gather empty');
  assert.deepEqual(gatherStore.get(query, opts).results, []);
});

test('key fields stay in step with serp-cache (plus the namespace tag only)', () => {
  const src = fs.readFileSync(new URL('./serp-cache.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function _normOpts'), src.indexOf('\n}\n', src.indexOf('function _normOpts')));
  const fields = [...body.matchAll(/^\s+(?:\.\.\.\(opts\.)?(\w+)[:?)]/gm)].map((m) => m[1]).filter((f) => f !== 'return');
  const mine = Object.keys(gatherStore._normOpts({ nosb: true })).filter((k) => k !== 'neg');
  for (const f of fields) assert.ok(mine.includes(f), `serp-cache key field "${f}" missing from serp-gather-negative-cache`);
});

test('wiring: gather-reviews passes the policy options into every outlet SERP call', () => {
  const src = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function searchForReviewViaSERP'), src.indexOf('\n}\n', src.indexOf('async function searchForReviewViaSERP')));
  assert.match(fn, /\.\.\.gatherNegativeCacheOpts\(\{[^}]*emptyAuthoritative: emptySerpAuthoritativeForGather\(/);
  const ud = fs.readFileSync(new URL('./url-discovery.js', import.meta.url), 'utf8');
  assert.match(ud, /negativeCacheStore: options\.negativeCacheStore/);
  assert.match(ud, /chainOpts\.negativeCacheStore === 'gather' \? _serpGatherNegativeCache/);
});
