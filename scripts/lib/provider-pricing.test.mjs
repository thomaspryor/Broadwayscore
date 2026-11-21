// Tests for provider-pricing.js (BRO-3009 S1-T6, trimmed scope: the JSON +
// loader + pure usdFor only — no existing call sites migrated this session).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { usdFor, loadProviderPricing } = require('./provider-pricing.js');

const FIXTURE = {
  scrapingdog: { usdPerUnit: 0.0001, unit: 'credit', billing: 'prepaid' },
  brightdata: { usdPerUnit: 0.002, unit: 'request', billing: 'payg' },
};

test('usdFor computes units * usdPerUnit from a passed-in table — pure, no fs access', () => {
  assert.equal(usdFor('scrapingdog', 10, FIXTURE), 0.001);
  assert.equal(usdFor('brightdata', 1, FIXTURE), 0.002);
});

test('usdFor throws for a provider missing from the table (never returns undefined/NaN)', () => {
  assert.throws(() => usdFor('scrapingbee', 1, FIXTURE));
});

test('loadProviderPricing reads the real committed config and every provider has a finite rate + valid billing type', () => {
  const real = loadProviderPricing();
  for (const p of ['scrapingdog', 'scrapingbee', 'brightdata']) {
    assert.ok(Number.isFinite(real[p].usdPerUnit), `${p} usdPerUnit must be a finite number`);
    assert.ok(['prepaid', 'payg'].includes(real[p].billing), `${p} billing must be prepaid or payg`);
  }
});

test('usdFor defaults to the real committed pricing when no table is passed', () => {
  const real = loadProviderPricing();
  assert.equal(usdFor('brightdata', 2), 2 * real.brightdata.usdPerUnit);
});

test('usdFor throws instead of returning NaN when units is missing/non-finite (BRO-3057)', () => {
  assert.throws(() => usdFor('scrapingdog', undefined, FIXTURE));
  assert.throws(() => usdFor('scrapingdog', NaN, FIXTURE));
  assert.throws(() => usdFor('scrapingdog', Infinity, FIXTURE));
});

test('usdFor({billing: "payg"}) uses paygUsdPerUnit instead of usdPerUnit', () => {
  const real = loadProviderPricing();
  assert.equal(
    usdFor('scrapingdog', 10, real, { billing: 'payg' }),
    10 * real.scrapingdog.paygUsdPerUnit
  );
});

test('usdFor({billing: "payg"}) throws for a provider with no paygUsdPerUnit configured', () => {
  assert.throws(() => usdFor('brightdata', 1, undefined, { billing: 'payg' }));
});

test('usdFor rejects an unrecognized billing value instead of silently falling back to prepaid', () => {
  const real = loadProviderPricing();
  assert.throws(() => usdFor('scrapingdog', 1, real, { billing: 'PAYG' }));
  assert.throws(() => usdFor('scrapingdog', 1, real, { billing: 'prepaid' }));
});

test('usdFor rejects a negative configured rate even at units=0 (would otherwise pass as -0)', () => {
  const badRate = { scrapingdog: { usdPerUnit: -0.0001, unit: 'credit', billing: 'prepaid' } };
  assert.throws(() => usdFor('scrapingdog', 0, badRate));
});
