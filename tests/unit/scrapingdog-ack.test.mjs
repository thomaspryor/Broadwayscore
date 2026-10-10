import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateScrapingdogCredits } = require('../../scripts/lib/scrapingdog-ack.js');

// BRO-263: smoke-test coverage for evaluateScrapingdogCredits (comprehensive
// suite already lives at scripts/lib/scrapingdog-ack.test.mjs — this file
// covers the 4 acceptance-criteria scenarios via the manifest-registered
// tests/unit/ path).

test('healthy credits → pass', () => {
  const r = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 100000, validity: 25 }, '2026-08-20');
  assert.equal(r.status, 'pass');
  assert.match(r.message, /900k credits left \(90%\)/);
});

test('low-credit warn threshold (<=15% remaining, no imminent-exhaustion projection) → warn', () => {
  const r = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 900000 }, '2026-08-20');
  assert.equal(r.status, 'warn');
});

test('invalid/revoked key response ({success:false} shape, verified live 2026-08-11) → warn via contract guard', () => {
  // scripts/check-secrets-health.js short-circuits this shape before calling
  // evaluateScrapingdogCredits in production, but the pure function itself
  // must not silently pass a response with no requestLimit field.
  const r = evaluateScrapingdogCredits({ success: false, message: 'Internal error' }, '2026-08-20');
  assert.equal(r.status, 'warn');
  assert.match(r.message, /Unexpected account response/);
});

test('malformed API payload (null / missing fields / non-numeric) → warn, not a silent pass', () => {
  for (const bad of [null, undefined, {}, { requestLimit: 'lots', requestUsed: 5 }, { requestLimit: 0, requestUsed: 0 }]) {
    const r = evaluateScrapingdogCredits(bad, '2026-08-20');
    assert.equal(r.status, 'warn', `expected warn for ${JSON.stringify(bad)}`);
    assert.match(r.message, /Unexpected account response/);
  }
});
