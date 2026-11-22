// BRO-7568: ScrapingBee exhaustion stays acknowledged under the ride-out policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isScrapingBeeExhaustionAcknowledged, isScrapingBeeRideOut, scrapingBeeAckTag } = require('./scrapingbee-ack.js');

test('ride-out config acknowledges exhaustion after the dated expiry', () => {
  assert.equal(isScrapingBeeExhaustionAcknowledged('2026-11-22', { rideOutPacks: ['scrapingbee'] }), true);
  assert.match(scrapingBeeAckTag({ rideOutPacks: ['scrapingbee'] }), /ride-out/);
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
