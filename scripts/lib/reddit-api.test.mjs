// BRO-3067: reddit-api.js fetchViaBrightData must consult the Bright Data
// breaker/per-run budget (brightdata-caps.js) and record one budget_capped
// ledger row, like scraper.js fetchWithBrightData. Real function, no network:
// the budget is consumed up front so the capped call never reaches BD.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reddit-bd-cap-'));
const ledgerPath = path.join(tmp, 'ledger.jsonl');
process.env.SCRAPER_SPEND_LEDGER_PATH = ledgerPath;
process.env.BRIGHTDATA_TOKEN = 'test-token';
process.env.BD_REQ_BUDGET = '1';
process.env.BD_BREAKER_STATE_PATH = path.join(tmp, 'no-breaker.json'); // never read the committed breaker file
delete process.env.BD_CAPS_DISABLED;
// Exempt callers get an unlimited budget and would send a real BD request
// with the fake token (BRO-5261): isolate every exemption signal.
for (const k of ['BD_OPENING_NIGHT', 'GITHUB_WORKFLOW', 'BD_EXEMPT_SCRIPTS', 'BD_REQ_BUDGET_OPENING_NIGHT', 'SCRAPINGDOG_API_KEY', 'SCRAPINGBEE_API_KEY']) delete process.env[k];

test('fetchViaBrightData is withheld once the BD budget is spent and logs one capped row', async () => {
  const caps = require('./brightdata-caps.js');
  caps._resetForTests();
  const api = require('./reddit-api.js');
  api.resetFallbackState();
  assert.equal(caps.consultBrightData({ zone: 'web_unlocker2' }).allowed, true); // spend the 1-request budget
  const url = 'https://www.reddit.com/r/Broadway/search.json?q=x';
  for (let i = 0; i < 3; i++) {
    await assert.rejects(api.fetchViaBrightData(url), /cap reached/);
  }
  const rows = fs.existsSync(ledgerPath)
    ? fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  assert.equal(rows.filter((r) => r.status === 'budget_capped').length, 1, JSON.stringify(rows));
  assert.equal(caps.getBrightDataRunStats().blocked, 3);
});

test('a spent budget latches BD off for the run and is named when every proxy is out', async () => {
  const caps = require('./brightdata-caps.js');
  caps._resetForTests();
  const api = require('./reddit-api.js');
  api.resetFallbackState();
  assert.equal(caps.consultBrightData({ zone: 'web_unlocker2' }).allowed, true); // spend the budget
  const url = 'https://www.reddit.com/r/Broadway/search.json?q=y';
  await assert.rejects(api.switchToProxy(url), /all proxies unavailable: .*Bright Data \(per-run budget spent\)/);
  const blockedAfterFirst = caps.getBrightDataRunStats().blocked;
  await assert.rejects(api.switchToProxy(url), /per-run budget spent/);
  assert.equal(caps.getBrightDataRunStats().blocked, blockedAfterFirst, 'latched: no second consult, no second warning');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
