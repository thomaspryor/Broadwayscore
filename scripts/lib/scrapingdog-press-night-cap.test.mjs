/**
 * BRO-5914: hard per-show, per-press-night spend cap (scrapingdog-caps.js).
 * Run: node --test scripts/lib/scrapingdog-press-night-cap.test.mjs
 * Requires the real modules (CLAUDE.md rule 15).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caps = require('./scrapingdog-caps.js');
const sp = require('./spend-purpose.js');
const { loadProviderPricing } = require('./provider-pricing.js');

const TAG_A = sp.pressNightPurpose('show-a-2026', '2026-10-29');
const TAG_B = sp.pressNightPurpose('show-b-2026', '2026-10-29');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-cap-'));
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
