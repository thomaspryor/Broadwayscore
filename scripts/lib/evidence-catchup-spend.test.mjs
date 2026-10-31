// BRO-4290: hard $20/month cap on the evidence-promoted review catch-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const spend = require('./evidence-catchup-spend.js');
const { usdFor, loadProviderPricing } = require('./provider-pricing.js');

const PRICING = loadProviderPricing();
const CAP = spend.EVIDENCE_CATCHUP_MONTHLY_CAP_USD;
const OCT = Date.parse('2026-10-15T12:00:00Z');
const NOV = Date.parse('2026-11-01T00:05:00Z');
const rollupOf = (fetches) => ({ version: 1, fetches });
const fetchRow = (showId, usd, month = '2026-10') => ({ showId, usd, month, ts: `${month}-02T00:00:00Z`, status: 'done' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-catchup-'));

test('the cap is the owner-approved $20 and the tag is distinct', () => {
  assert.equal(CAP, 20);
  assert.equal(spend.EVIDENCE_CATCHUP_PURPOSE, 'evidence-catchup');
});

test('under the cap a fetch proceeds', () => {
  const mtd = spend.monthToDateUsd(rollupOf([fetchRow('a', 5)]), [], OCT, PRICING);
  assert.equal(mtd, 5);
  assert.equal(spend.decideFetch({ mtdUsd: mtd, projectedUsd: 0.01, capUsd: CAP }).proceed, true);
});

test('landing exactly on the cap proceeds; any amount past it stops', () => {
  assert.equal(spend.decideFetch({ mtdUsd: 19.99, projectedUsd: 0.01, capUsd: 20 }).proceed, true);
  assert.equal(spend.decideFetch({ mtdUsd: 20, projectedUsd: 0, capUsd: 20 }).proceed, true);
  assert.equal(spend.decideFetch({ mtdUsd: 20, projectedUsd: 0.0001, capUsd: 20 }).proceed, false);
});

test('a batch that would cross the cap stops mid-batch, re-reading spend before each fetch', () => {
  const dir = tmp();
  const file = path.join(dir, 'rollup.json');
  const projected = spend.projectedFetchUsd(PRICING);
  // Room for exactly two more worst-case fetches.
  fs.writeFileSync(file, JSON.stringify(rollupOf([fetchRow('earlier', CAP - 2.5 * projected)])));
  const done = [];
  for (const id of ['s1', 's2', 's3', 's4']) {
    const mtd = spend.monthToDateUsd(spend.loadRollup(file), [], OCT, PRICING);
    if (!spend.decideFetch({ mtdUsd: mtd, projectedUsd: projected, capUsd: CAP }).proceed) break;
    spend.appendRollupFetch(file, { ...fetchRow(id, projected), ts: new Date(OCT).toISOString() });
    done.push(id);
  }
  assert.deepEqual(done, ['s1', 's2']);
  assert.ok(spend.monthToDateUsd(spend.loadRollup(file), [], OCT, PRICING) <= CAP);
});

test('a new UTC month starts from zero', () => {
  const full = rollupOf([fetchRow('a', 20)]);
  const ledger = [{ ts: '2026-10-31T23:00:00Z', provider: 'brightdata', status: 200, purpose: 'evidence-catchup', showId: 'a' }];
  assert.equal(spend.decideFetch({ mtdUsd: spend.monthToDateUsd(full, ledger, OCT, PRICING), projectedUsd: 0.01 }).proceed, false);
  assert.equal(spend.monthToDateUsd(full, ledger, NOV, PRICING), 0);
  assert.equal(spend.decideFetch({ mtdUsd: 0, projectedUsd: 0.01 }).proceed, true);
});

test('a missing or corrupt rollup fails closed (throws, so no fetch)', () => {
  const dir = tmp();
  assert.throws(() => spend.loadRollup(path.join(dir, 'absent.json')));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"version":1,"fetches":[');
  assert.throws(() => spend.loadRollup(bad));
  fs.writeFileSync(bad, JSON.stringify({ fetches: [] }));
  assert.throws(() => spend.loadRollup(bad), /version/);
  fs.writeFileSync(bad, JSON.stringify(rollupOf([{ showId: 'x', month: '2026-10', usd: 'NaN' }])));
  assert.throws(() => spend.loadRollup(bad), /malformed/);
  assert.equal(spend.decideFetch({ mtdUsd: NaN, projectedUsd: 0.01 }).proceed, false);
});

test('a missing ledger, or an unreadable line carrying the tag, fails closed', () => {
  const dir = tmp();
  assert.throws(() => spend.loadTaggedLedgerRows(path.join(dir, 'none.jsonl')));
  assert.throws(() => spend.parseTaggedLedgerRows('{"ts":"2026-10-01","purpose":"evidence-catchup",'), /unreadable/);
  // untagged junk (merge=union leftovers) is ignored
  assert.deepEqual(spend.parseTaggedLedgerRows('garbage\n{"ts":"2026-10-01","purpose":null}\n'), []);
});

test('the CLI makes no fetch when the rollup is missing', () => {
  const dir = tmp();
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledger, '');
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed-evidence-review-stubs.js'), '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, EVIDENCE_CATCHUP_ROLLUP_PATH: path.join(dir, 'absent.json'), SCRAPER_SPEND_LEDGER_PATH: ledger },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no further fetches/);
  assert.doesNotMatch(r.stdout, /would fetch|fetching/);
});

test('ledger rows are priced through provider-pricing.json', () => {
  const p = (row) => spend.priceLedgerRow(row, PRICING);
  assert.equal(p({ provider: 'scrapingbee', credits: 10 }), usdFor('scrapingbee', 10, PRICING));
  assert.equal(p({ provider: 'scrapingdog', credits: 5 }), usdFor('scrapingdog', 5, PRICING));
  assert.equal(p({ provider: 'brightdata', status: 200 }), usdFor('brightdata', 1, PRICING));
  assert.equal(p({ provider: 'brightdata', status: 'budget_capped' }), 0);
  assert.throws(() => p({ provider: 'mystery' }), /cannot price/);
});

test('month to date takes the larger of the rollup and the tagged ledger', () => {
  const ledger = Array.from({ length: 4 }, (_, i) => ({ ts: `2026-10-15T0${i}:00:00Z`, provider: 'brightdata', status: 200, purpose: 'evidence-catchup' }));
  const fromLedger = 4 * usdFor('brightdata', 1, PRICING);
  assert.equal(spend.monthToDateUsd(rollupOf([]), ledger, OCT, PRICING), fromLedger);
  assert.equal(spend.monthToDateUsd(rollupOf([fetchRow('a', 1)]), ledger, OCT, PRICING), 1);
});

test('a fetch with no ledger rows is charged the projected worst case', () => {
  const start = '2026-10-15T10:00:00Z';
  const none = spend.spendForFetch([], 'x', start, PRICING);
  assert.equal(none.estimated, true);
  assert.equal(none.usd, spend.projectedFetchUsd(PRICING));
  const rows = [
    { ts: '2026-10-15T10:00:05Z', provider: 'scrapingdog', credits: 1, showId: 'x' },
    { ts: '2026-10-15T09:00:00Z', provider: 'scrapingdog', credits: 99, showId: 'x' }, // before start
    { ts: '2026-10-15T10:00:06Z', provider: 'scrapingdog', credits: 99, showId: 'y' }, // other show
  ];
  const got = spend.spendForFetch(rows, 'x', start, PRICING);
  assert.equal(got.rows, 1);
  assert.equal(got.usd, usdFor('scrapingdog', 1, PRICING));
});
