// BRO-3067: reddit-api.js fetchViaBrightData must consult the Bright Data
// breaker/per-run budget (brightdata-caps.js) and record one budget_capped
// ledger row, like scraper.js fetchWithBrightData. Real function, no network:
// the budget is consumed up front so the capped call never reaches BD.
import { test } from 'node:test';
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
delete process.env.BD_CAPS_DISABLED;

test('fetchViaBrightData is withheld once the BD budget is spent, logs one capped row, does not latch brightDataDown', async () => {
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
  fs.rmSync(tmp, { recursive: true, force: true });
});
