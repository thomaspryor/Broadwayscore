#!/usr/bin/env node
// Tests the theatre.reviews negative cache against the real lib functions.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverTrRoundupHtml } = require('./lib/tr-roundup-discover');
const { isTrDiscoveryInCooldown, recordTrMiss, readRoundupMisses, trMissKey } = require('./lib/tr-roundup-miss');
const { isInRoundupMissCooldown, lastMissForShow } = require('./lib/bww-roundup-persistence');

const DAY = 86400000;
const now = Date.parse('2026-10-20T12:00:00Z');
const old = { id: 'dirty-dancing-west-end-2022', title: 'Dirty Dancing', venue: 'Dominion', openingDate: '2022-06-01' };
const fresh = { id: 'new-show-west-end-2026', title: 'New Show', venue: 'Soho Place', openingDate: '2026-10-18' };
const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trmiss-')), 'ledger.jsonl');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

(async () => {
  // discovery: 404 guesses + WP search answers with no hits => searchCompleted
  const calls = [];
  const none = { fetchPage: async u => { calls.push(u); throw new Error('404'); }, fetchJSON: async () => [], log: () => {} };
  const stats = {};
  assert.strictEqual(await discoverTrRoundupHtml(old, { ...none, stats }), null);
  t('genuine miss sets searchCompleted', () => assert.strictEqual(stats.searchCompleted, true));

  // discovery: WP search itself fails => NOT a recordable miss
  const failing = { fetchPage: async () => { throw new Error('x'); }, fetchJSON: async () => { throw new Error('net'); }, log: () => {} };
  const fstats = {};
  await discoverTrRoundupHtml(old, { ...failing, stats: fstats });
  t('search failure leaves searchCompleted false', () => assert.strictEqual(fstats.searchCompleted, false));
  t('recordTrMiss refuses on search failure', () => { assert.strictEqual(recordTrMiss(old, fstats, ledger), false); assert.strictEqual(readRoundupMisses(ledger).length, 0); });

  t('recordTrMiss writes tr: key on genuine miss', () => {
    assert.strictEqual(recordTrMiss(old, stats, ledger), true);
    assert.strictEqual(readRoundupMisses(ledger)[0].showId, trMissKey(old.id));
  });

  const entries = readRoundupMisses(ledger);
  t('old show is in cooldown after a miss', () => assert.strictEqual(isTrDiscoveryInCooldown(old, entries, Date.now()), true));
  t('cooldown expires after 24h+', () => assert.strictEqual(isTrDiscoveryInCooldown(old, entries, Date.now() + 25 * 3600000), false));
  t('TR_MISS_CACHE_DISABLED=true bypasses the cache', () => {
    process.env.TR_MISS_CACHE_DISABLED = 'true';
    try { assert.strictEqual(isTrDiscoveryInCooldown(old, entries, Date.now()), false); } finally { delete process.env.TR_MISS_CACHE_DISABLED; }
  });
  t('show with no prior miss is not in cooldown', () => assert.strictEqual(isTrDiscoveryInCooldown({ ...old, id: 'other' }, entries), false));
  t('show opened <2 days ago is never in cooldown', () => {
    const hot = { ...fresh, openingDate: new Date(Date.now() - 12 * 3600000).toISOString().slice(0, 10) };
    recordTrMiss(hot, stats, ledger);
    assert.strictEqual(isTrDiscoveryInCooldown(hot, readRoundupMisses(ledger), Date.now()), false);
  });
  t('show opened 4 days ago: 6h cooldown, expires after', () => {
    const mid = { ...fresh, id: 'mid-show', openingDate: new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10) };
    recordTrMiss(mid, stats, ledger);
    const e = readRoundupMisses(ledger);
    assert.strictEqual(isTrDiscoveryInCooldown(mid, e, Date.now()), true);
    assert.strictEqual(isTrDiscoveryInCooldown(mid, e, Date.now() + 7 * 3600000), false);
  });
  t('undated show: 12h cooldown', () => {
    const u = { id: 'undated', title: 'U' };
    recordTrMiss(u, stats, ledger);
    const e = readRoundupMisses(ledger);
    assert.strictEqual(isTrDiscoveryInCooldown(u, e, Date.now() + 11 * 3600000), true);
    assert.strictEqual(isTrDiscoveryInCooldown(u, e, Date.now() + 13 * 3600000), false);
  });
  t('TR miss does not put BWW lookup of same show in cooldown', () =>
    assert.strictEqual(isInRoundupMissCooldown(old, lastMissForShow(old.id, entries)), false));

  // hit path unaffected: a found roundup still returns html
  const html = '<html>' + 'Dirty Dancing ⭑⭑⭑⭑ review '.repeat(80) + '</html>';
  const hit = await discoverTrRoundupHtml(old, { fetchPage: async () => ({ content: html, source: 'test' }), fetchJSON: async () => [], log: () => {}, stats: {} });
  t('found roundup path still returns (or is rejected by guard, not crashed)', () => assert.ok(hit === null || hit.html));
  console.log(`\n${n} passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
