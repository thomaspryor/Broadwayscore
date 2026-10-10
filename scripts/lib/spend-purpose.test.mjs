import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { gatherPurposeForShow, HISTORICAL_BACKFILL } = require('./spend-purpose.js');

test('closed >90 days ago is historical backfill; open, recent or undated is not', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(gatherPurposeForShow({ closingDate: '1988-05-15' }, now), HISTORICAL_BACKFILL);
  assert.equal(gatherPurposeForShow({ closingDate: '2026-09-01' }, now), '');
  assert.equal(gatherPurposeForShow({ closingDate: null, status: 'open' }, now), '');
  assert.equal(gatherPurposeForShow(undefined, now), '');
});

test('provider-telemetry stamps SCRAPER_SPEND_PURPOSE when the caller passes none', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpose-'));
  const ledger = path.join(dir, 'l.jsonl');
  process.env.SCRAPER_SPEND_LEDGER_PATH = ledger;
  process.env.SCRAPER_SPEND_PURPOSE = HISTORICAL_BACKFILL;
  const { recordSdCall } = require('./provider-telemetry.js');
  recordSdCall({ host: 'serp.scrapingdog', fn: 'serp', success: true, status: 200, credits: 5 });
  recordSdCall({ host: 'serp.scrapingdog', fn: 'serp', success: true, status: 200, credits: 5, purpose: 'explicit' });
  delete process.env.SCRAPER_SPEND_PURPOSE;
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((r) => r.purpose), [HISTORICAL_BACKFILL, 'explicit']);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
