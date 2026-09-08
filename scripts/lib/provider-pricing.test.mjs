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
