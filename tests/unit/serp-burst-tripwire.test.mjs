/**
 * Tests for scripts/lib/serp-burst-tripwire.js (BRO-2438 finding 2).
 *
 * BRO-1699 post-merge review found opening-night-poller.js stamping
 * `tripwireAlerted = true` and persisting the SERP-burst ledger BEFORE
 * `routeAlert()` was awaited — the exact write-first/notify-second
 * anti-pattern that same PR removed from opening-night-broadcast.yml. If
 * sendAlert() failed (missing RESEND_API_KEY, Resend 5xx), routeAlert()
 * deliberately leaves the condition un-notified so the next call retries,
 * but the local ledger flag was already persisted — the poller's own gate
 * (`!updated.tripwireAlerted`) then suppressed the retry until the UTC-day
 * ledger rollover, with the owner never paged about a runaway SERP burst.
 *
 * The fix moved the write inside the try, after routeAlert() resolves, and
 * made it conditional on `alertResult.delivered !== false`. This suite
 * requires the REAL extracted function (scripts/lib/serp-burst-tripwire.js)
 * per CLAUDE.md rule 15 — a regression in the production write-after-notify
 * ordering fails here, not just in a re-implemented copy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { maybeAlertSerpBurstTripwire } = require('../../scripts/lib/serp-burst-tripwire.js');
const { DEFAULT_SERP_BURST_CONFIG } = require('../../scripts/lib/serp-burst-caps.js');

function tripwireLedger(overrides = {}) {
  return {
    date: '2026-08-26',
    globalBursts: DEFAULT_SERP_BURST_CONFIG.cascadeTripwire,
    perShow: {},
    tripwireAlerted: false,
    ...overrides,
  };
}

test('below the tripwire threshold: routeAlert is never called, nothing written', async () => {
  const ledger = tripwireLedger({ globalBursts: DEFAULT_SERP_BURST_CONFIG.cascadeTripwire - 1 });
  let routeAlertCalls = 0;
  let writeCalls = 0;
  const result = await maybeAlertSerpBurstTripwire({
    ledger,
    config: DEFAULT_SERP_BURST_CONFIG,
    routeAlert: async () => { routeAlertCalls++; return { delivered: true }; },
    writeSerpBurstLedger: () => { writeCalls++; },
    log: () => {},
  });
  assert.equal(result.fired, false);
  assert.equal(routeAlertCalls, 0);
  assert.equal(writeCalls, 0);
  assert.equal(ledger.tripwireAlerted, false);
});

test('already alerted today: routeAlert is never called again (local gate dedupes)', async () => {
  const ledger = tripwireLedger({ tripwireAlerted: true });
  let routeAlertCalls = 0;
  const result = await maybeAlertSerpBurstTripwire({
    ledger,
    config: DEFAULT_SERP_BURST_CONFIG,
    routeAlert: async () => { routeAlertCalls++; return { delivered: true }; },
    writeSerpBurstLedger: () => {},
    log: () => {},
  });
  assert.equal(result.fired, false);
  assert.equal(routeAlertCalls, 0);
});

test('successful delivery: tripwireAlerted is set AFTER routeAlert resolves, and persisted', async () => {
  const ledger = tripwireLedger();
  const callOrder = [];
  let writtenSnapshot = null;
  const result = await maybeAlertSerpBurstTripwire({
    ledger,
    config: DEFAULT_SERP_BURST_CONFIG,
    routeAlert: async (opts) => {
      callOrder.push('routeAlert-called');
      // At the moment routeAlert is invoked, the ledger must NOT yet be
      // marked alerted — proves the write happens after, not before.
      assert.equal(ledger.tripwireAlerted, false, 'tripwireAlerted must still be false while routeAlert is in flight');
      assert.equal(opts.conditionKey, 'serp-burst:tripwire');
      assert.equal(opts.disposition, 'human');
      return { delivered: true };
    },
    writeSerpBurstLedger: (l) => { callOrder.push('write-called'); writtenSnapshot = { ...l }; },
    log: () => {},
  });
  assert.deepEqual(callOrder, ['routeAlert-called', 'write-called'], 'write must happen strictly after routeAlert resolves');
  assert.equal(result.fired, true);
  assert.equal(result.delivered, true);
  assert.equal(ledger.tripwireAlerted, true);
  assert.equal(writtenSnapshot.tripwireAlerted, true);
});

// The core BRO-2438 finding 2 regression case.
test('sendAlert failure (delivered:false): tripwireAlerted is NOT persisted, so the next run retries', async () => {
  const ledger = tripwireLedger();
  let writeCalls = 0;
  const result = await maybeAlertSerpBurstTripwire({
    ledger,
    config: DEFAULT_SERP_BURST_CONFIG,
    // Simulates routeAlert's real behavior when sendAlert() returns false
    // (RESEND_API_KEY missing / Resend 5xx): it resolves (does not throw)
    // with delivered:false and does NOT touch its own ledger.
    routeAlert: async () => ({ action: 'human', delivered: false }),
    writeSerpBurstLedger: () => { writeCalls++; },
    log: () => {},
  });
  assert.equal(result.fired, true);
  assert.equal(result.delivered, false);
  assert.equal(writeCalls, 0, 'writeSerpBurstLedger must not be called on a failed delivery');
  assert.equal(ledger.tripwireAlerted, false, 'the local ledger flag must stay false so the next poller cycle retries the alert');
});

test('routeAlert throwing (network error) is swallowed non-fatally, and tripwireAlerted is NOT persisted', async () => {
  const ledger = tripwireLedger();
  let writeCalls = 0;
  const logs = [];
  const result = await maybeAlertSerpBurstTripwire({
    ledger,
    config: DEFAULT_SERP_BURST_CONFIG,
    routeAlert: async () => { throw new Error('ECONNRESET'); },
    writeSerpBurstLedger: () => { writeCalls++; },
    log: (msg) => logs.push(msg),
  });
  assert.equal(result.fired, true);
  assert.equal(result.delivered, false);
  assert.equal(writeCalls, 0);
  assert.equal(ledger.tripwireAlerted, false);
  assert.ok(logs.some(l => l.includes('tripwire alert failed')), 'must log the non-fatal failure');
});
