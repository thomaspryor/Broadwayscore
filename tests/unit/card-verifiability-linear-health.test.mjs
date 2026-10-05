// BRO-2997: health decision for the daily-refreshed Linear verifiability report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkCardVerifiabilityLinear } = require('../../scripts/lib/card-verifiability-linear-health.js');
const { cardVerifiabilityLinearResults } = require('../../scripts/health-check.js');

const NOW = Date.parse('2026-10-05T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const rep = (over = {}) => ({ generatedAt: hoursAgo(2), total: 900, refused: [], ...over });

test('fresh report with a few non-regression refusals is healthy', () => {
  const r = rep({ refused: [{ id: 'BRO-1', kind: 'no-section' }] });
  assert.equal(checkCardVerifiabilityLinear(r, NOW), null);
  assert.deepEqual(cardVerifiabilityLinearResults(r, NOW), []);
});
test('missing / invalid report warns', () => {
  assert.equal(checkCardVerifiabilityLinear(null, NOW).severity, 'warn');
  assert.equal(checkCardVerifiabilityLinear({ total: 1 }, NOW).severity, 'warn');
});
test('stale report warns at 48h and errors at 96h (the 20-day-stale incident)', () => {
  assert.equal(checkCardVerifiabilityLinear(rep({ generatedAt: hoursAgo(47) }), NOW), null);
  assert.equal(checkCardVerifiabilityLinear(rep({ generatedAt: hoursAgo(49) }), NOW).severity, 'warn');
  assert.equal(checkCardVerifiabilityLinear(rep({ generatedAt: hoursAgo(480) }), NOW).severity, 'error');
});
test('shape/basename refusals and high ratio warn', () => {
  const r = checkCardVerifiabilityLinear(rep({ refused: [{ id: 'BRO-9', kind: 'shape' }] }), NOW);
  assert.match(r.reason, /BRO-9/);
  const many = Array.from({ length: 450 }, (_, i) => ({ id: `BRO-${i}`, kind: 'no-section' }));
  assert.match(checkCardVerifiabilityLinear(rep({ refused: many }), NOW).reason, /450\/900/);
});
test('health-check row maps severity and name', () => {
  const rows = cardVerifiabilityLinearResults(rep({ generatedAt: hoursAgo(480) }), NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].name, /Linear/);
});
