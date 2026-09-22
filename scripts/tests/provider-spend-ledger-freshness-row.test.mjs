/**
 * provider-spend-ledger-freshness-row.test.mjs — BRO-3349 acceptance.
 *
 * The "Data quality: provider spend ledger" health-check row fired EVERY day
 * from 2026-09-17 onward while the ledger was landing perfectly well. Root
 * cause was not the commit ordering BRO-3317 fixed (that fix holds — the
 * ledger has a committed entry for every day since), it was duplicated
 * freshness math: health-check.js compared `Date.now() - new Date(lastDay)`,
 * measuring from the START of the recorded day, while the producer
 * (check-provider-spend.js) measures from its END via ledgerFreshnessHours().
 * The phantom 24h stacked on top of the ~24h `day` is inherently behind
 * (DAY defaults to utcYesterday(), the last COMPLETE day) plus the row being
 * evaluated BEFORE "Provider spend reconciliation" runs later in the same
 * data-health-check.yml job — so a healthy run measured 48h + hours-into-day
 * and always tripped the >48h bar.
 *
 * These tests require() the REAL exported decision function (CLAUDE.md §15 —
 * no restated logic) and pin the two cases that matter: the healthy
 * two-calendar-days-back ledger must PASS, and a genuinely skipped
 * reconciliation must still ERROR. A future edit that re-derives the age from
 * the start of the day fails the first test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { providerSpendLedgerResult } = require('../health-check.js');
const { ledgerFreshnessHours, STALE_HOURS_THRESHOLD } = require('../lib/provider-spend-core.js');

const row = (day) => JSON.stringify({ day, providers: {}, attributedPct: {} });

// Frozen at the real timestamp of the run whose committed digest snapshot
// (data/audit/health-digest-snapshot.json @ 1465ab0dff0) recorded this row as
// an ERROR reading "day=2026-09-19 is 3d old".
const RUN_AT = new Date('2026-09-21T13:25:11.107Z');

function withFrozenNow(at, fn) {
  const RealDate = Date;
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(at.getTime()); }
    static now() { return at.getTime(); }
  };
  try { return fn(); } finally { Date = RealDate; }
}

test('BRO-3349: the healthy real-world ledger (day = two calendar days back) PASSES', () => {
  // What data-health-check.yml actually sees: the row is evaluated before this
  // run's own reconciliation, so the newest committed `day` is utcYesterday()
  // of the PREVIOUS run — 2026-09-19 for a run on 2026-09-21.
  const raw = [row('2026-09-17'), row('2026-09-18'), row('2026-09-19')].join('\n') + '\n';
  const res = withFrozenNow(RUN_AT, () => providerSpendLedgerResult(raw));
  assert.equal(res.status, 'pass',
    `a ledger written by yesterday's run must not read as stale — got: ${res.message}`);
  assert.match(res.message, /day=2026-09-19/);
});

test('BRO-3349: the row measures from END of day, matching the producer exactly', () => {
  const raw = row('2026-09-19');
  const expected = ledgerFreshnessHours([{ day: '2026-09-19' }], RUN_AT);
  assert.ok(expected < STALE_HOURS_THRESHOLD, 'fixture precondition: canonical age is under the bar');
  assert.ok(Math.abs(expected - 37.42) < 0.1, `canonical age should be ~37.4h, got ${expected}`);
  const res = withFrozenNow(RUN_AT, () => providerSpendLedgerResult(raw));
  assert.equal(res.status, 'pass');
  // The pre-BRO-3349 start-of-day math would have produced 61.4h here.
  assert.ok((RUN_AT - new Date('2026-09-19')) / 3600000 > STALE_HOURS_THRESHOLD,
    'regression guard: start-of-day math on this same fixture IS over the bar, so a revert fails the test above');
});

test('BRO-3349: a genuinely skipped reconciliation still ERRORS (the dead-man survives)', () => {
  // One missed day: newest committed `day` is three calendar days back.
  const raw = [row('2026-09-17'), row('2026-09-18')].join('\n') + '\n';
  const res = withFrozenNow(RUN_AT, () => providerSpendLedgerResult(raw));
  assert.equal(res.status, 'error',
    'the >48h dead-man must still fire when a day of reconciliation is actually missing');
  assert.match(res.message, /day=2026-09-18/);
});

test('BRO-3349: the row reuses the producer threshold, never a local literal', () => {
  const raw = [row('2026-09-17'), row('2026-09-18')].join('\n') + '\n';
  const res = withFrozenNow(RUN_AT, () => providerSpendLedgerResult(raw));
  assert.match(res.message, new RegExp(`>${STALE_HOURS_THRESHOLD}h`),
    'the error text must render STALE_HOURS_THRESHOLD from provider-spend-core.js');
});

test('BRO-3349: missing / empty / corrupt-only ledgers warn rather than error', () => {
  assert.equal(providerSpendLedgerResult(null).status, 'warn');
  assert.equal(providerSpendLedgerResult('').status, 'warn');
  assert.equal(providerSpendLedgerResult('not json\n{also not\n').status, 'warn');
});

test('BRO-3349: a corrupt line loses one day, never the whole check', () => {
  const raw = ['{ broken', row('2026-09-19'), 'also broken'].join('\n') + '\n';
  const res = withFrozenNow(RUN_AT, () => providerSpendLedgerResult(raw));
  assert.equal(res.status, 'pass');
  assert.match(res.message, /day=2026-09-19/);
});
