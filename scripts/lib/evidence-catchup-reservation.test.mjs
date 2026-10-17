// BRO-4290 review follow-up: the $20/month cap must not fail open.
//   1. reserve before each fetch, true up after; spend the rollup lost stops the next run
//   2. a failed fetch writes no retryable stub; incomplete text holds a collect-retry allowance
//   3. the workflow's `candidates` output is the cap-allowed count
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
const { loadProviderPricing } = require('./provider-pricing.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'seed-evidence-review-stubs.js');
const PRICING = loadProviderPricing();
const NOW = Date.parse('2026-10-15T12:00:00Z');
const DAY = 86400000;
const empty = () => ({ version: 1, fetches: [] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-reserve-'));

function writeRollup(dir, rollup = empty()) {
  const file = path.join(dir, 'rollup.json');
  fs.writeFileSync(file, JSON.stringify(rollup));
  return file;
}

// --- 1. reservation ------------------------------------------------------

test('a reservation counts at the worst case and blocks the show before any fetch result exists', () => {
  const file = writeRollup(tmp());
  const reserve = spend.projectedReservationUsd(PRICING);
  spend.reserveFetch(file, { showId: 'a', url: 'https://x/a', nowMs: NOW, usd: reserve });
  // Simulated crash: never settled.
  const r = spend.loadRollup(file);
  assert.equal(r.fetches[0].status, 'reserved');
  assert.ok(Math.abs(spend.monthToDateUsd(r, [], NOW, PRICING) - reserve) < 1e-6);
  assert.ok(spend.blockedShowIds(r, NOW + 365 * DAY).has('a'), 'an unsettled reservation is never re-fetched');
});

test('settling trues the reservation down to the priced actual', () => {
  const file = writeRollup(tmp());
  const id = spend.reserveFetch(file, { showId: 'a', url: 'u', nowMs: NOW, usd: 5 });
  spend.settleFetch(file, id, { usd: 0.002, rows: 2, estimated: false, exit: 0, nowMs: NOW + 1000 });
  const row = spend.loadRollup(file).fetches[0];
  assert.equal(row.status, 'done');
  assert.equal(row.usd, 0.002);
  assert.throws(() => spend.settleFetch(file, 'nope', { usd: 0, exit: 0, nowMs: NOW }), /no reservation/);
});

test('tagged ledger spend the rollup does not record fails closed', () => {
  const ledgerRow = { ts: '2026-10-15T12:00:05Z', provider: 'brightdata', status: 200, purpose: 'evidence-catchup', showId: 'a' };
  assert.throws(() => spend.assertRollupCoversLedger(empty(), [ledgerRow]), /does not record/);
  // A tagged row without a showId cannot be matched: it counts, it does not block.
  assert.doesNotThrow(() => spend.assertRollupCoversLedger(empty(), [{ ...ledgerRow, showId: null }]));
  assert.ok(spend.monthToDateUsd(empty(), [{ ...ledgerRow, showId: null }], Date.parse(ledgerRow.ts), PRICING) > 0);
  const later = { version: 1, fetches: [{ id: 'a@x', ts: '2026-10-15T12:00:09Z', month: '2026-10', showId: 'a', usd: 1, status: 'done' }] };
  assert.throws(() => spend.assertRollupCoversLedger(later, [ledgerRow]), /does not record/);
  const covering = { version: 1, fetches: [{ ...later.fetches[0], ts: '2026-10-15T12:00:00Z' }] };
  assert.doesNotThrow(() => spend.assertRollupCoversLedger(covering, [ledgerRow]));
});

test('in CI the reservation is pushed before the fetch; a failed push stops the run', () => {
  const pushes = [];
  const ok = (file, msg) => { pushes.push([file, msg]); return true; };
  const ci = { GITHUB_ACTIONS: 'true' };
  assert.equal(spend.persistReservation({ rollupFile: 'r.json', showId: 'a', dryRun: false, env: ci, pushRollup: ok }), 'pushed');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0][1], /reservation for a/);
  assert.throws(() => spend.persistReservation({ rollupFile: 'r.json', showId: 'a', dryRun: false, env: ci, pushRollup: () => false }), /no fetch made/);
  assert.throws(() => spend.persistReservation({ rollupFile: 'r.json', showId: 'a', dryRun: false, env: ci, pushRollup: () => { throw new Error('rejected'); } }), /rejected/);
  // Never in dry runs or outside GitHub Actions.
  const never = () => { throw new Error('must not push'); };
  assert.equal(spend.persistReservation({ rollupFile: 'r.json', showId: 'a', dryRun: true, env: ci, pushRollup: never }), 'skipped');
  assert.equal(spend.persistReservation({ rollupFile: 'r.json', showId: 'a', dryRun: false, env: {}, pushRollup: never }), 'skipped');
});

// --- 2. failures and downstream retries ---------------------------------

test('a failed fetch waits FAILED_RETRY_DAYS and stops after MAX_SEED_ATTEMPTS', () => {
  const file = writeRollup(tmp());
  const id = spend.reserveFetch(file, { showId: 'a', url: 'u', nowMs: NOW, usd: 1 });
  spend.settleFetch(file, id, { usd: 0.001, rows: 1, estimated: false, exit: 3, nowMs: NOW });
  let r = spend.loadRollup(file);
  assert.equal(r.fetches[0].status, 'failed');
  assert.equal(Date.parse(r.fetches[0].notBefore), NOW + spend.FAILED_RETRY_DAYS * DAY);
  assert.ok(spend.blockedShowIds(r, NOW + 29 * DAY).has('a'));
  assert.ok(!spend.blockedShowIds(r, NOW + 31 * DAY).has('a'));
  const id2 = spend.reserveFetch(file, { showId: 'a', url: 'u', nowMs: NOW + 31 * DAY, usd: 1 });
  spend.settleFetch(file, id2, { usd: 0.001, rows: 1, estimated: false, exit: 3, nowMs: NOW + 31 * DAY });
  r = spend.loadRollup(file);
  assert.equal(spend.MAX_SEED_ATTEMPTS, 2);
  assert.ok(spend.blockedShowIds(r, NOW + 400 * DAY).has('a'));
});

test('the collect-retry allowance covers the largest retry budget in review-guards.js', () => {
  const src = fs.readFileSync(path.join(HERE, 'review-guards.js'), 'utf8');
  const table = src.match(/const MAX_RETRIES_FETCH_LENIENT = Object\.freeze\(\{([^}]*)\}\)/);
  assert.ok(table, 'MAX_RETRIES_FETCH_LENIENT not found in review-guards.js');
  const maxRetries = Math.max(...[...table[1].matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1])));
  assert.ok(spend.DOWNSTREAM_COLLECT_FETCHES >= maxRetries + 1);
  assert.ok(spend.isCollectComplete({ contentTier: 'complete' }));
  assert.ok(!spend.isCollectComplete({ contentTier: 'truncated' }));
  assert.ok(!spend.isCollectComplete(null));
});

// --- CLI end to end with a fake ingest -----------------------------------

const FAKE_INGEST = `
const fs = require('fs'); const path = require('path');
const show = process.env.SCRAPER_SPEND_SHOW_ID;
const rollup = JSON.parse(fs.readFileSync(process.env.EVIDENCE_CATCHUP_ROLLUP_PATH, 'utf8'));
const reserved = rollup.fetches.some((f) => f.showId === show && f.status === 'reserved');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), show, reserved, purpose: process.env.SCRAPER_SPEND_PURPOSE }) + '\\n');
fs.appendFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), provider: 'scrapingdog', credits: 1, purpose: process.env.SCRAPER_SPEND_PURPOSE, showId: show }) + '\\n');
const exit = Number((process.env.FAKE_EXITS || '').split(',')[Number(process.env.FAKE_N || 0)] || 0);
if (exit === 0 && process.env.FAKE_TIER) {
  const dir = path.join(process.env.EVIDENCE_CATCHUP_REVIEW_TEXTS_DIR, show);
  fs.mkdirSync(dir, { recursive: true });
  const url = process.argv.find((a) => a.startsWith('--url=')).slice(6);
  fs.writeFileSync(path.join(dir, 'outlet--critic.json'), JSON.stringify({ url, contentTier: process.env.FAKE_TIER }));
}
process.exit(exit);
`;

function fixture({ rollup = empty(), ledger = '', ids = ['e1', 'e2', 'e3'] } = {}) {
  const dir = tmp();
  const evidence = (id) => ({
    id, status: 'closed', discoverySource: 'audit-review-evidence',
    discoveredAt: new Date(Date.now() - 5 * DAY).toISOString(), evidenceUrls: [`https://example.com/${id}`],
  });
  fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows: ids.map(evidence) }));
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ reviews: [] }));
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), ledger);
  fs.writeFileSync(path.join(dir, 'fake-ingest.js'), FAKE_INGEST);
  fs.mkdirSync(path.join(dir, 'texts'));
  const rollupFile = writeRollup(dir, rollup);
  return { dir, rollupFile };
}

function runCli(fx, args, extraEnv = {}) {
  const out = path.join(fx.dir, 'gh-output');
  fs.writeFileSync(out, '');
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BSC_TEST_RUN: '1',
      EVIDENCE_CATCHUP_SHOWS_PATH: path.join(fx.dir, 'shows.json'),
      EVIDENCE_CATCHUP_REVIEWS_PATH: path.join(fx.dir, 'reviews.json'),
      EVIDENCE_CATCHUP_REVIEW_TEXTS_DIR: path.join(fx.dir, 'texts'),
      EVIDENCE_CATCHUP_INGEST: path.join(fx.dir, 'fake-ingest.js'),
      EVIDENCE_CATCHUP_SPACING_MS: '1',
      EVIDENCE_CATCHUP_ROLLUP_PATH: fx.rollupFile,
      SCRAPER_SPEND_LEDGER_PATH: path.join(fx.dir, 'ledger.jsonl'),
      FAKE_LOG: path.join(fx.dir, 'calls.jsonl'),
      GITHUB_OUTPUT: out,
      GITHUB_ACTIONS: '',
      ...extraEnv,
    },
  });
  const calls = fs.existsSync(path.join(fx.dir, 'calls.jsonl'))
    ? fs.readFileSync(path.join(fx.dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...r, calls, output: fs.readFileSync(out, 'utf8'), rollup: JSON.parse(fs.readFileSync(fx.rollupFile, 'utf8')) };
}

test('CLI: each fetch runs with its reservation already written, tagged, without --stub-on-failure', () => {
  const fx = fixture();
  const r = runCli(fx, ['--limit=2'], { FAKE_TIER: 'complete' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 2);
  for (const c of r.calls) {
    assert.equal(c.reserved, true, 'reservation must exist before the fetch');
    assert.equal(c.purpose, 'evidence-catchup');
    assert.ok(!c.argv.includes('--stub-on-failure'), 'no retryable stub for collect-review-texts');
  }
  assert.deepEqual(r.rollup.fetches.map((f) => f.status), ['done', 'done']);
  assert.ok(r.rollup.fetches.every((f) => f.downstreamUsd === 0 && f.rows === 1));
});

test('CLI: a failed fetch is recorded failed; an incomplete text keeps the collect-retry allowance', () => {
  const fx = fixture();
  const r = runCli(fx, ['--limit=2'], { FAKE_EXITS: '3', FAKE_TIER: 'truncated' });
  assert.equal(r.status, 0, r.stderr);
  // FAKE_N is unset, so every call uses the first exit code (3): both fail.
  assert.deepEqual(r.rollup.fetches.map((f) => f.status), ['failed', 'failed']);
  assert.ok(r.rollup.fetches.every((f) => f.notBefore && f.downstreamUsd === 0));
  const fx2 = fixture();
  const r2 = runCli(fx2, ['--limit=1'], { FAKE_TIER: 'truncated' });
  const row = r2.rollup.fetches[0];
  assert.equal(row.status, 'done');
  assert.ok(Math.abs(row.downstreamUsd - spend.downstreamAllowanceUsd(PRICING)) < 1e-6);
});

test('CLI: tagged spend the rollup lost stops the run before any fetch', () => {
  const lost = JSON.stringify({ ts: new Date().toISOString(), provider: 'brightdata', status: 200, purpose: 'evidence-catchup', showId: 'e1' }) + '\n';
  const fx = fixture({ ledger: lost });
  const r = runCli(fx, ['--limit=2']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not record/);
  assert.equal(r.calls.length, 0);
});

test('CLI: `candidates` output is the cap-allowed count, so a bound cap skips the heavy steps', () => {
  const reserve = spend.projectedReservationUsd(PRICING);
  const nearCap = { version: 1, fetches: [{ id: 'old@x', ts: new Date().toISOString(), month: spend.monthKey(Date.now()), showId: 'old', usd: spend.EVIDENCE_CATCHUP_MONTHLY_CAP_USD - 1.5 * reserve, status: 'done' }] };
  const fx = fixture({ rollup: nearCap });
  const r = runCli(fx, ['--dry-run', '--limit=3']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.output, /^candidates=1$/m);
  const full = { ...nearCap, fetches: [{ ...nearCap.fetches[0], usd: spend.EVIDENCE_CATCHUP_MONTHLY_CAP_USD }] };
  const r2 = runCli(fixture({ rollup: full }), ['--dry-run', '--limit=3']);
  assert.match(r2.output, /^candidates=0$/m);
  assert.equal(spend.allowedFetchCount({ mtdUsd: 0, projectedUsd: 1, capUsd: 2.5, count: 5 }), 2);
});

const FAKE_PUSH = `
const fs = require('fs');
const [file, message] = process.argv.slice(2);
const rollup = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ push: message, reservedRows: rollup.fetches.filter((f) => f.status === 'reserved').length }) + '\\n');
process.exit(Number(process.env.FAKE_PUSH_EXIT || 0));
`;

test('CLI in CI: the reservation is pushed before the ingest runs', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.dir, 'fake-push.js'), FAKE_PUSH);
  const r = runCli(fx, ['--limit=1'], { GITHUB_ACTIONS: 'true', EVIDENCE_CATCHUP_PUSH_CMD: path.join(fx.dir, 'fake-push.js'), FAKE_TIER: 'complete' });
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(path.join(fx.dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(log[0].push, 'push happens first');
  assert.equal(log[0].reservedRows, 1, 'the pushed rollup already holds the reservation');
  assert.ok(log[1].show, 'then the fetch');
});

test('CLI in CI: a failed reservation push exits nonzero with no fetch', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.dir, 'fake-push.js'), FAKE_PUSH);
  const r = runCli(fx, ['--limit=2'], { GITHUB_ACTIONS: 'true', EVIDENCE_CATCHUP_PUSH_CMD: path.join(fx.dir, 'fake-push.js'), FAKE_PUSH_EXIT: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no fetch made/);
  assert.equal(r.calls.filter((c) => c.show).length, 0);
});

test('CLI in CI under test with no fake push command refuses rather than pushing the real repo', () => {
  const fx = fixture();
  const r = runCli(fx, ['--limit=1'], { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 1);
  assert.equal(r.calls.filter((c) => c.show).length, 0);
});
