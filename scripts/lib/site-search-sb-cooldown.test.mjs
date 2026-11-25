// BRO-8280: the site-search direct ScrapingBee render must honour the shared SB host cooldown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cd-'));
const ledger = path.join(dir, 'ledger.jsonl');
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const rows = (host, n, success, h) => Array.from({ length: n }, () => JSON.stringify({ provider: 'scrapingbee', host, success, ts: hoursAgo(h) }));
fs.writeFileSync(ledger, [...rows('ew.com', 6, false, 1), ...rows('thestage.co.uk', 6, false, 1), ...rows('thestage.co.uk', 1, true, 2)].join('\n') + '\n');
process.env.SCRAPER_SPEND_LEDGER_PATH = ledger;
process.env.SCRAPINGBEE_API_KEY = 'dummy';
process.env.SCRAPER_SPEND_LEDGER_DISABLED = '1';
const { fetchJsSearchHtml } = require('./site-search-discovery');

test('a host that has failed every recent render is not sent to ScrapingBee', async () => {
  let calls = 0;
  const orig = https.get;
  https.get = () => { calls++; throw new Error('network must not be touched'); };
  try {
    await assert.rejects(() => fetchJsSearchHtml({}, 'https://ew.com/search/?q=hamilton'), /host cooldown/);
  } finally { https.get = orig; }
  assert.equal(calls, 0);
});

test('a host with a recent success is still rendered', async () => {
  let calls = 0;
  const orig = https.get;
  https.get = () => { calls++; const e = new (require('node:events').EventEmitter)(); e.setTimeout = () => {}; e.destroy = () => {}; return e; };
  try {
    fetchJsSearchHtml({}, 'https://www.thestage.co.uk/search?q=x').catch(() => {});
  } finally { https.get = orig; }
  assert.equal(calls, 1);
});

test('a timed-out probe does not let a second same-host call through', async () => {
  const { createSbHostCooldown } = require('./scrapingbee-host-cooldown');
  const old = Array.from({ length: 6 }, () => ({ provider: 'scrapingbee', host: 'ew.com', success: false, ts: hoursAgo(7) }));
  const g = createSbHostCooldown({ env: {}, readRows: () => old });
  const u = 'https://ew.com/search/?q=x';
  assert.equal(g.consult(u).probe, true);
  g.record(u, false); // timeout
  assert.equal(g.consult(u).allowed, false);
});

test('release frees the probe slot without adding a success', () => {
  const { createSbHostCooldown } = require('./scrapingbee-host-cooldown');
  const old = Array.from({ length: 6 }, () => ({ provider: 'scrapingbee', host: 'ew.com', success: false, ts: hoursAgo(7) }));
  const g = createSbHostCooldown({ env: {}, readRows: () => old });
  const u = 'https://ew.com/search/?q=x';
  assert.equal(g.consult(u).probe, true);
  g.release(u);
  assert.equal(g.consult(u).probe, true);
});
