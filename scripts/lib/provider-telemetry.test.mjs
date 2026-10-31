// Per-show spend attribution on scraper-spend-ledger rows (BRO-3386).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEDGER = path.join(os.tmpdir(), `provider-telemetry-showid-${process.pid}.jsonl`);
process.env.SCRAPER_SPEND_LEDGER_PATH = LEDGER;
delete process.env.SCRAPER_SPEND_SHOW_ID;

const require = createRequire(import.meta.url);
const { recordSbCall, recordSdCall, withSpendShow, currentSpendShowId, withSpendFallback } = require('./provider-telemetry.js');

function rows() {
  try { return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
}
function quiet(fn) {
  const orig = console.log; console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
}

test('row outside any show context records showId null', () => {
  fs.rmSync(LEDGER, { force: true });
  quiet(() => recordSbCall({ host: 'serp.scrapingbee', fn: 'serp', success: true, credits: 25 }));
  assert.equal(rows()[0].showId, null);
});

test('withSpendShow stamps showId, and concurrent shows stay apart', async () => {
  fs.rmSync(LEDGER, { force: true });
  const call = (host) => new Promise((r) => setTimeout(() => { quiet(() => recordSdCall({ host, fn: 'page', success: true, credits: 1 })); r(); }, 5));
  await Promise.all([
    withSpendShow('show-a', async () => { await call('a1.com'); await call('a2.com'); }),
    withSpendShow('show-b', async () => { await call('b1.com'); }),
  ]);
  const byHost = Object.fromEntries(rows().map((r) => [r.host, r.showId]));
  assert.deepEqual(byHost, { 'a1.com': 'show-a', 'a2.com': 'show-a', 'b1.com': 'show-b' });
  assert.equal(currentSpendShowId(), null, 'context does not leak after the wrapped call');
});

test('explicit opts.showId beats context, context beats env', () => {
  process.env.SCRAPER_SPEND_SHOW_ID = 'env-show';
  try {
    assert.equal(currentSpendShowId(), 'env-show');
    withSpendShow('ctx-show', () => {
      assert.equal(currentSpendShowId(), 'ctx-show');
      assert.equal(currentSpendShowId('explicit-show'), 'explicit-show');
    });
  } finally {
    delete process.env.SCRAPER_SPEND_SHOW_ID;
    fs.rmSync(LEDGER, { force: true });
  }
});

test('withSpendFallback tags fallback_from and keeps the surrounding showId (BRO-3344)', async () => {
  fs.rmSync(LEDGER, { force: true });
  await withSpendShow('show-x', () => withSpendFallback('scrapingdog', async () => {
    quiet(() => recordSbCall({ host: 'serp.scrapingbee', fn: 'serp', success: true, credits: 25 }));
  }));
  quiet(() => recordSbCall({ host: 'outside', fn: 'serp', success: true, credits: 25, detail: { msg: 'm' } }));
  const [inside, outside] = rows();
  assert.deepEqual([inside.fallback_from, inside.showId, 'detail' in inside], ['scrapingdog', 'show-x', false]);
  assert.deepEqual([outside.fallback_from, outside.detail], [null, { msg: 'm' }]);
  fs.rmSync(LEDGER, { force: true });
});
