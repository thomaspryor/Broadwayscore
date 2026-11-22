// BRO-7568: ScrapingBee exhaustion stays acknowledged under the ride-out policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isScrapingBeeExhaustionAcknowledged, isScrapingBeeRideOut, scrapingBeeAckTag } = require('./scrapingbee-ack.js');

test('ride-out config acknowledges exhaustion after the dated expiry', () => {
  assert.equal(isScrapingBeeExhaustionAcknowledged('2026-11-22', { rideOutPacks: ['scrapingbee'] }), true);
  assert.equal(scrapingBeeAckTag({ rideOutPacks: ['scrapingbee'] }, '2026-11-22'), 'expires 2026-11-23');
  assert.equal(scrapingBeeAckTag({ rideOutPacks: [] }, '2026-11-22'), 'expires 2026-08-05');
});

test('the digest matchers read the ride-out tag as acknowledged (same day), and lapsed after it', () => {
  const { isRowAcknowledged } = require('./digest-autofix.js');
  const row = `0k credits left (0%) — acknowledged: ScrapingBee is a fallback [${scrapingBeeAckTag(undefined, '2026-11-22')}]`;
  assert.equal(isRowAcknowledged(row, '2026-11-22'), true);
  assert.equal(isRowAcknowledged(row, '2026-11-24'), false);
});

test('without ride-out the dated expiry still forces re-triage', () => {
  assert.equal(isScrapingBeeExhaustionAcknowledged('2026-11-22', { rideOutPacks: [] }), false);
  assert.equal(isScrapingBeeExhaustionAcknowledged('2026-08-01', null), true);
  assert.equal(isScrapingBeeRideOut({ rideOutPacks: 'scrapingbee' }), false);
});

test('the committed config is what the health checks read', () => {
  assert.equal(isScrapingBeeRideOut(), true);
  assert.equal(isScrapingBeeExhaustionAcknowledged('2026-11-22'), true);
});
