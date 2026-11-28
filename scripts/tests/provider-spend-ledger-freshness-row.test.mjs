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


test('BRO-3349: the healthy real-world ledger (day = two calendar days back) PASSES', () => {
  // What data-health-check.yml actually sees: the row is evaluated before this
  // run's own reconciliation, so the newest committed `day` is utcYesterday()
  // of the PREVIOUS run — 2026-09-19 for a run on 2026-09-21.
  const raw = [row('2026-09-17'), row('2026-09-18'), row('2026-09-19')].join('\n') + '\n';
  const res = providerSpendLedgerResult(raw, RUN_AT);
  assert.equal(res.status, 'pass',
    `a ledger written by yesterday's run must not read as stale — got: ${res.message}`);
  assert.match(res.message, /day=2026-09-19/);
});

test('BRO-3349: the row measures from END of day, matching the producer exactly', () => {
  const raw = row('2026-09-19');
  const expected = ledgerFreshnessHours([{ day: '2026-09-19' }], RUN_AT);
  assert.ok(expected < STALE_HOURS_THRESHOLD, 'fixture precondition: canonical age is under the bar');
  assert.ok(Math.abs(expected - 37.42) < 0.1, `canonical age should be ~37.4h, got ${expected}`);
  const res = providerSpendLedgerResult(raw, RUN_AT);
  assert.equal(res.status, 'pass');
  // The pre-BRO-3349 start-of-day math would have produced 61.4h here.
  assert.ok((RUN_AT - new Date('2026-09-19')) / 3600000 > STALE_HOURS_THRESHOLD,
    'regression guard: start-of-day math on this same fixture IS over the bar, so a revert fails the test above');
});

test('BRO-3349: a genuinely skipped reconciliation still ERRORS (the dead-man survives)', () => {
  // One missed day: newest committed `day` is three calendar days back.
  const raw = [row('2026-09-17'), row('2026-09-18')].join('\n') + '\n';
  const res = providerSpendLedgerResult(raw, RUN_AT);
  assert.equal(res.status, 'error',
    'the >48h dead-man must still fire when a day of reconciliation is actually missing');
  assert.match(res.message, /day=2026-09-18/);
});

test('BRO-3349: the row reuses the producer threshold, never a local literal', () => {
  const raw = [row('2026-09-17'), row('2026-09-18')].join('\n') + '\n';
  const res = providerSpendLedgerResult(raw, RUN_AT);
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
  const res = providerSpendLedgerResult(raw, RUN_AT);
  assert.equal(res.status, 'pass');
  assert.match(res.message, /day=2026-09-19/);
});

test('BRO-3349: the row\'s age IS the canonical helper\'s value, not a same-direction approximation', () => {
  // Pins equality with ledgerFreshnessHours rather than just "under the bar",
  // so a hardcoded 40h/60h cutoff that happens to agree on these fixtures
  // still fails (ship-check/Codex finding on the first version of this test).
  for (const day of ['2026-09-16', '2026-09-19', '2026-09-20']) {
    const canonical = ledgerFreshnessHours([{ day }], RUN_AT);
    const expectStale = canonical > STALE_HOURS_THRESHOLD;
    const res = providerSpendLedgerResult(row(day), RUN_AT);
    assert.equal(res.status, expectStale ? 'error' : 'pass',
      `day=${day} canonical age ${canonical.toFixed(2)}h vs threshold ${STALE_HOURS_THRESHOLD}h`);
  }
});

test('BRO-3349: the bar is exactly STALE_HOURS_THRESHOLD, checked on both sides of the boundary', () => {
  const day = '2026-09-19';
  const dayEnd = new Date(`${day}T23:59:59.999Z`).getTime();
  const justUnder = new Date(dayEnd + (STALE_HOURS_THRESHOLD * 3600000) - 60000);
  const justOver = new Date(dayEnd + (STALE_HOURS_THRESHOLD * 3600000) + 60000);
  assert.equal(providerSpendLedgerResult(row(day), justUnder).status, 'pass');
  assert.equal(providerSpendLedgerResult(row(day), justOver).status, 'error');
});

test('BRO-3349: a shape-valid but UNREAL day cannot silence the dead-man', () => {
  // ship-check/Codex P1: "2026-99-99" passes VALID_DAY_RE but is Invalid Date.
  // The old lexical-max-then-convert order let one such row outrank every real
  // day, return NaN, and downgrade a long-dead reconciliation to a permanent
  // "no parseable rows" WARN.
  const raw = [row('2026-06-01'), row('2026-99-99')].join('\n') + '\n';
  const res = providerSpendLedgerResult(raw, RUN_AT);
  assert.equal(res.status, 'error', 'a months-stale ledger must still ERROR alongside an unreal day');
  assert.match(res.message, /day=2026-06-01/, 'the reported day must be the newest REAL day');
});

test('BRO-3349: an unreal day never becomes the reported newest entry on a healthy ledger', () => {
  const raw = [row('2026-09-19'), row('2026-99-99')].join('\n') + '\n';
  const res = providerSpendLedgerResult(raw, RUN_AT);
  assert.equal(res.status, 'pass');
  assert.match(res.message, /day=2026-09-19/);
});
