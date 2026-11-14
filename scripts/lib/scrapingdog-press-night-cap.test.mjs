/**
 * BRO-5914: hard per-show, per-press-night spend cap (scrapingdog-caps.js).
 * Run: node --test scripts/lib/scrapingdog-press-night-cap.test.mjs
 * Requires the real modules (CLAUDE.md rule 15).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const caps = require('./scrapingdog-caps.js');
const sp = require('./spend-purpose.js');
const { loadProviderPricing } = require('./provider-pricing.js');

const TAG_A = sp.pressNightPurpose('show-a-2026', '2026-10-29');
const TAG_B = sp.pressNightPurpose('show-b-2026', '2026-10-29');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-cap-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let ledger;
let n = 0;

function rows(list) {
  fs.writeFileSync(ledger, list.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function row(purpose, provider, credits) {
  return { ts: '2026-10-29T20:00:00Z', provider, fn: 'serp', success: true, credits, purpose };
}
function status(tag, extraEnv = {}) {
  return caps.pressNightCapStatus({ env: { ...extraEnv }, purpose: tag, ledgerPath: ledger });
}

beforeEach(() => {
  ledger = path.join(dir, `ledger-${n++}.jsonl`);
  caps._resetForTests();
});

test('untagged and non-press-night purposes: cap does not apply, no file read', () => {
  ledger = path.join(dir, 'does-not-exist-and-must-not-matter');
  for (const tag of [undefined, '', 'historical-backfill', 'evidence-catchup', null]) {
    const r = caps.pressNightCapStatus({ env: {}, purpose: tag === undefined ? '' : tag, ledgerPath: ledger });
    assert.deepEqual([r.applies, r.exceeded], [false, false], String(tag));
  }
});

test('tag helpers round-trip; malformed press-night tags are detected', () => {
  assert.deepEqual(sp.parsePressNightPurpose(TAG_A), { showId: 'show-a-2026', night: '2026-10-29' });
  for (const bad of ['press-night', 'press-night:x', 'press-night:x:2026-1-1', 'press-night::2026-10-29', 'press-night:a:b:2026-10-29']) {
    assert.equal(sp.parsePressNightPurpose(bad), 'malformed', bad);
  }
  assert.equal(sp.parsePressNightPurpose('press-nightly'), null);
});

test('under the cap: allowed; at/over the cap: exceeded', () => {
  rows([row(TAG_A, 'scrapingdog', 5)]);
  const ok = status(TAG_A);
  assert.equal(ok.exceeded, false);
  assert.ok(ok.spentUsd > 0 && ok.spentUsd < 0.01);
  // 1,400 Bright Data requests at $0.0015 = $2.10 >= $2.00
  rows(Array.from({ length: 1400 }, () => row(TAG_A, 'brightdata', null)));
  const over = status(TAG_A);
  assert.equal(over.exceeded, true);
  assert.equal(over.reason, 'press-night-cap');
  assert.equal(over.capUsd, caps.PRESS_NIGHT_CAP_USD);
});

test('per show: one show over its cap does not block another show-night', () => {
  rows(Array.from({ length: 1400 }, () => row(TAG_A, 'brightdata', null)).concat([row(TAG_B, 'scrapingdog', 5)]));
  assert.equal(status(TAG_A).exceeded, true);
  assert.equal(status(TAG_B).exceeded, false);
  // untagged rows and other nights never count
  const nextNight = sp.pressNightPurpose('show-a-2026', '2026-10-30');
  assert.equal(status(nextNight).exceeded, false);
});

test('fails closed PER SHOW: unreadable ledger or malformed tag denies that show only', () => {
  fs.mkdirSync(ledger); // a directory: readFileSync throws EISDIR, not ENOENT
  const r = status(TAG_A);
  assert.equal(r.exceeded, true);
  assert.match(r.reason, /ledger-unreadable/);
  assert.equal(status('press-night:broken').exceeded, true);
  assert.equal(status('historical-backfill').exceeded, false); // off-night purposes unaffected
});

test('missing ledger file counts as zero spend (fresh checkout)', () => {
  assert.equal(status(TAG_A).exceeded, false);
});

test('a partial/garbage ledger line is skipped, not fatal', () => {
  fs.writeFileSync(ledger, `{"purpose":${JSON.stringify(TAG_A)},"provider":"scrapingdog",\n` + JSON.stringify(row(TAG_A, 'scrapingdog', 5)) + '\n');
  const r = status(TAG_A);
  assert.equal(r.exceeded, false);
  assert.ok(r.spentUsd > 0);
});

test('unknown providers (browserbase) are priced at the Bright Data rate, never thrown or ignored', () => {
  const table = loadProviderPricing();
  const bd = caps.pressNightSpentUsd; // exercised through the file reader below
  rows([row(TAG_A, 'browserbase', null), row(TAG_A, 'brightdata', null)]);
  const spent = bd(TAG_A, { ledgerPath: ledger, table });
  assert.ok(Math.abs(spent - 2 * table.brightdata.usdPerUnit) < 1e-12);
});

test('SD_PRESS_NIGHT_CAP_USD can only LOWER the cap', () => {
  assert.equal(caps.resolvePressNightCapUsd({}), caps.PRESS_NIGHT_CAP_USD);
  assert.equal(caps.resolvePressNightCapUsd({ SD_PRESS_NIGHT_CAP_USD: '0.5' }), 0.5);
  for (const raise of ['100', '2.01', '0', '-1', 'abc', '']) {
    assert.equal(caps.resolvePressNightCapUsd({ SD_PRESS_NIGHT_CAP_USD: raise }), caps.PRESS_NIGHT_CAP_USD, raise);
  }
  rows([row(TAG_A, 'brightdata', 100)]); // $0.15
  assert.equal(status(TAG_A).exceeded, false);
  assert.equal(status(TAG_A, { SD_PRESS_NIGHT_CAP_USD: '0.1' }).exceeded, true);
});

test('explicit off switch disables the cap', () => {
  rows(Array.from({ length: 1400 }, () => row(TAG_A, 'brightdata', null)));
  assert.equal(status(TAG_A, { SD_PRESS_NIGHT_CAP_DISABLED: '1' }).exceeded, false);
});

test('warn-only mode reports an exceeded cap without blocking; hard mode still blocks', (t) => {
  rows([row(TAG_A, 'brightdata', 1400)]);
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const env = { SCRAPER_SPEND_PURPOSE: TAG_A, SCRAPER_SPEND_LEDGER_PATH: ledger, SD_CAPS_DISABLED: '1' };
  assert.equal(caps.consultScrapingdog({ env: { ...env, SD_PRESS_NIGHT_CAP_MODE: 'warn' } }).allowed, true);
  assert.equal(caps.consultScrapingdog({ env: { ...env, SD_PRESS_NIGHT_CAP_MODE: 'warn' } }).allowed, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /press-night:show-a-2026:2026-10-29.*continuing fetches/);
  assert.equal(caps.consultScrapingdog({ env }).allowed, false);
});

test('per-show scope restores both environment values and clears stale tags off-night', () => {
  const keys = ['SCRAPER_SPEND_PURPOSE', 'SD_PRESS_NIGHT_CAP_MODE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const show = { id: 'show-a-2026', category: 'broadway', openingDate: '2026-10-29' };
    const restore = sp.beginPressNightSpend(show, Date.parse('2026-10-29T23:00:00Z'));
    assert.equal(process.env.SCRAPER_SPEND_PURPOSE, TAG_A);
    assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, 'warn');
    const restoreOff = sp.beginPressNightSpend(show, Date.parse('2026-12-01T23:00:00Z'));
    assert.equal(process.env.SCRAPER_SPEND_PURPOSE, '');
    assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, undefined);
    restoreOff();
    assert.equal(process.env.SCRAPER_SPEND_PURPOSE, TAG_A);
    restore();
    for (const key of keys) assert.equal(process.env[key], undefined);
    process.env.SCRAPER_SPEND_PURPOSE = 'evidence-catchup';
    process.env.SD_PRESS_NIGHT_CAP_MODE = 'hard';
    const restoreDispatch = sp.beginPressNightSpend(show, Date.parse('2026-10-29T23:00:00Z'));
    restoreDispatch();
    assert.equal(process.env.SCRAPER_SPEND_PURPOSE, 'evidence-catchup');
    assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, 'hard');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

function scopeEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const openingShow = { id: 'show-a-2026', title: 'Show A', category: 'broadway', openingDate: '2026-10-29', status: 'open' };
const openingNow = Date.parse('2026-10-29T23:00:00Z');

test('lane production driver scopes the real runNight on success and failure', async (t) => {
  const { runProductionLane } = require('./opening-night-lane/driver');
  t.mock.method(Date, 'now', () => openingNow);
  scopeEnv(t, { SCRAPER_SPEND_PURPOSE: 'dispatch-purpose', SD_PRESS_NIGHT_CAP_MODE: undefined });
  for (const fail of [false, true]) {
    const result = await runProductionLane({
      show: openingShow, night: openingShow.openingDate, holder: 'test',
      deps: {
        armCheck: async () => ({ arm: true }), claim: async () => ({ ok: true }),
        heartbeat: async () => ({ ok: true }), release: async () => {}, page: async () => {},
        setInterval: () => 1, clearInterval: () => {},
        runNight: async () => {
          await Promise.resolve();
          assert.equal(process.env.SCRAPER_SPEND_PURPOSE, TAG_A);
          assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, 'warn');
          if (fail) throw new Error('injected lane failure');
          return { passes: 1 };
        },
      },
    });
    assert.equal(result.exit, fail ? 1 : 0);
    assert.equal(process.env.SCRAPER_SPEND_PURPOSE, 'dispatch-purpose');
    assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, undefined);
  }
});

test('poller scopes its loaded show before discovery and restores on an exception', async (t) => {
  t.mock.method(Date, 'now', () => openingNow);
  scopeEnv(t, { SCRAPER_SPEND_PURPOSE: undefined, SD_PRESS_NIGHT_CAP_MODE: undefined });
  const savedArgv = process.argv;
  process.argv = [...savedArgv, `--show=${openingShow.id}`];
  t.after(() => { process.argv = savedArgv; });
  const gather = require('../gather-reviews');
  const policy = require('./opening-night-discovery-policy');
  const lease = require('./opening-night-lane/lease-guard');
  t.mock.method(gather, 'loadShowData', () => openingShow);
  t.mock.method(lease, 'leaseSkipReason', () => null);
  const stop = new Error('stop before discovery side effects');
  let observed;
  t.mock.method(policy, 'warnStalledReviewStubs', () => {
    observed = [process.env.SCRAPER_SPEND_PURPOSE, process.env.SD_PRESS_NIGHT_CAP_MODE];
    throw stop;
  });
  const pollerPath = require.resolve('../opening-night-poller');
  delete require.cache[pollerPath];
  t.after(() => { delete require.cache[pollerPath]; });
  const { pollCycle } = require('../opening-night-poller');
  await assert.rejects(pollCycle(), error => error === stop);
  assert.deepEqual(observed, [TAG_A, 'warn']);
  assert.equal(process.env.SCRAPER_SPEND_PURPOSE, undefined);
  assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, undefined);
});

test('outlet collector scopes each show at its SERP caller and clears off-night tags', async (t) => {
  t.mock.method(Date, 'now', () => openingNow);
  scopeEnv(t, { SCRAPER_SPEND_PURPOSE: TAG_B, SD_PRESS_NIGHT_CAP_MODE: 'hard', SCRAPINGBEE_API_KEY: 'test-only' });
  const shows = [openingShow, { ...openingShow, id: 'show-b-2026' }, { ...openingShow, id: 'off-night', openingDate: '2025-01-01' }];
  const savedArgv = process.argv;
  process.argv = [...savedArgv.slice(0, 2), '--shows', shows.map(show => show.id).join(','), '--no-skip-existing', '--dry-run'];
  t.after(() => { process.argv = savedArgv; });
  const discovery = require('./url-discovery');
  const observed = [];
  t.mock.method(discovery, 'discoverCorrectUrl', async () => {
    await Promise.resolve();
    observed.push([process.env.SCRAPER_SPEND_PURPOSE, process.env.SD_PRESS_NIGHT_CAP_MODE]);
    return '__SERP_UNAVAILABLE__'; // End this show's outlet loop without sleeping or writing.
  });
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).endsWith('/data/shows.json')) return JSON.stringify({ shows });
    if (String(file).endsWith('/data/outlet-registry.json')) return JSON.stringify({ outlets: { nytimes: { tier: 1, domain: 'nytimes.com' } } });
    return read(file, ...args);
  });
  const collectorPath = require.resolve('../collect-outlet-reviews');
  delete require.cache[collectorPath];
  t.after(() => { delete require.cache[collectorPath]; });
  const { main } = require('../collect-outlet-reviews');
  await main();
  assert.deepEqual(observed, [[TAG_A, 'warn'], [TAG_B, 'warn'], ['', undefined]]);
  assert.equal(process.env.SCRAPER_SPEND_PURPOSE, TAG_B);
  assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, 'hard');
});

test('real paid fetch proceeds and records the show above cap in warn mode; gather mode blocks', async (t) => {
  rows([row(TAG_A, 'brightdata', 1400)]);
  scopeEnv(t, {
    SCRAPINGDOG_API_KEY: 'test-only', SCRAPER_SPEND_LEDGER_PATH: ledger,
    SCRAPER_SPEND_PURPOSE: TAG_A, SD_PRESS_NIGHT_CAP_MODE: undefined,
    SD_PRESS_NIGHT_CAP_DISABLED: undefined, SD_CAPS_DISABLED: '1', BD_TELEMETRY_DISABLED: undefined,
  });
  let paidFetches = 0;
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  t.mock.method(https, 'get', (url, options, callback) => {
    const response = new EventEmitter();
    response.statusCode = 200;
    const account = String(url).includes('/account?');
    if (!account) paidFetches++;
    queueMicrotask(() => {
      callback(response);
      response.emit('data', account ? '{}' : '<html>review</html>');
      response.emit('end');
    });
    return new EventEmitter();
  });
  const scraperPath = require.resolve('./scraper');
  delete require.cache[scraperPath];
  t.after(() => { delete require.cache[scraperPath]; });
  const { fetchWithScrapingdog } = require('./scraper');
  assert.equal(await fetchWithScrapingdog('https://example.com/review'), null);
  assert.equal(paidFetches, 0);
  const restore = sp.beginPressNightSpend(openingShow, openingNow);
  try {
    assert.equal((await fetchWithScrapingdog('https://example.com/review')).source, 'scrapingdog');
    assert.equal(paidFetches, 1);
    assert.equal(warnings.filter(message => /continuing fetches/.test(message)).length, 1);
    const recorded = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1));
    assert.equal(recorded.purpose, TAG_A);
    assert.equal(recorded.provider, 'scrapingdog');
  } finally { restore(); }
  assert.equal(await fetchWithScrapingdog('https://example.com/review'), null);
  assert.equal(paidFetches, 1);
});

test('warn-only warns again at the cap after the 80% warning, and fails open on unreadable ledgers', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const env = { SD_PRESS_NIGHT_CAP_MODE: 'warn' };
  rows([row(TAG_A, 'brightdata', 1200)]);
  assert.equal(status(TAG_A, env).exceeded, false);
  rows([row(TAG_A, 'brightdata', 1400)]);
  assert.equal(status(TAG_A, env).exceeded, false);
  assert.equal(warnings.length, 1);
  fs.unlinkSync(ledger);
  fs.mkdirSync(ledger);
  assert.equal(status(TAG_A, env).exceeded, false);
  assert.match(warnings[1], /ledger-unreadable/);
  assert.equal(status('press-night:broken', env).exceeded, false);
  assert.match(warnings[2], /malformed-tag/);
  assert.equal(status(TAG_A).exceeded, true);
});

test('consultScrapingdog: capped show is blocked even for an exempt caller and with SD_CAPS_DISABLED', () => {
  rows(Array.from({ length: 1400 }, () => row(TAG_A, 'brightdata', null)));
  const env = {
    SCRAPER_SPEND_PURPOSE: TAG_A,
    SCRAPER_SPEND_LEDGER_PATH: ledger,
    BD_OPENING_NIGHT: '1', // exempt-caller signal
    SD_CAPS_DISABLED: '1',
  };
  const v = caps.consultScrapingdog({ env });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'press-night-cap');
  assert.equal(caps.getScrapingdogCapStats().blockedByPressNightCap, 1);
  // same env, an untagged (off-night) call: unchanged behaviour
  const off = caps.consultScrapingdog({ env: { ...env, SCRAPER_SPEND_PURPOSE: '' } });
  assert.equal(off.allowed, true);
});

test('pressNightPurposeForShow: tags a show inside its window only (stored opening date)', () => {
  const show = { id: 'x-2026', category: 'broadway', openingDate: '2026-10-29' };
  const at = (iso) => sp.pressNightPurposeForShow(show, Date.parse(iso));
  assert.equal(at('2026-10-29T23:00:00Z'), 'press-night:x-2026:2026-10-29');
  assert.equal(at('2026-10-30T12:00:00Z'), 'press-night:x-2026:2026-10-29');
  assert.equal(at('2026-10-27T12:00:00Z'), '');
  assert.equal(at('2026-11-05T12:00:00Z'), '');
  assert.equal(sp.pressNightPurposeForShow({ id: 'y', category: 'broadway' }, Date.parse('2026-10-29T23:00:00Z')), '');
});

test('emptySerpAuthoritativeForGather: false only for an opening-night gather of a press-night show', () => {
  const show = { id: 'x-2026', category: 'broadway', openingDate: '2026-10-29' };
  const t = Date.parse('2026-10-29T23:00:00Z');
  assert.equal(sp.emptySerpAuthoritativeForGather({ openingNight: true, show, nowMs: t }), false);
  assert.equal(sp.emptySerpAuthoritativeForGather({ openingNight: false, show, nowMs: t }), true);
  assert.equal(sp.emptySerpAuthoritativeForGather({ openingNight: true, show, nowMs: Date.parse('2026-12-01T00:00:00Z') }), true);
  assert.equal(sp.emptySerpAuthoritativeForGather({ openingNight: true, show: undefined, nowMs: t }), true);
});

test('emptySerpAuthoritativeForGather: GATHER_EMPTY_SERP_RETRY_DISABLED=1 restores accept-empty', () => {
  const show = { id: 'x-2026', category: 'broadway', openingDate: '2026-10-29' };
  const t = Date.parse('2026-10-29T23:00:00Z');
  process.env.GATHER_EMPTY_SERP_RETRY_DISABLED = '1';
  try {
    assert.equal(sp.emptySerpAuthoritativeForGather({ openingNight: true, show, nowMs: t }), true);
  } finally {
    delete process.env.GATHER_EMPTY_SERP_RETRY_DISABLED;
  }
  assert.equal(sp.emptySerpAuthoritativeForGather({ openingNight: true, show, nowMs: t }), false);
});
