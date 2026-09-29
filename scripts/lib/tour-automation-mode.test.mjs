import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { tourAutomationMode } = createRequire(import.meta.url)('./tour-automation-mode.js');

test('explicit variable wins; unset is report-only until the live date', () => {
  assert.equal(tourAutomationMode('off', new Date('2027-01-01')), 'off');
  assert.equal(tourAutomationMode('REPORT', new Date('2027-01-01')), 'report');
  assert.equal(tourAutomationMode('write', new Date('2026-09-01')), 'write');
  assert.equal(tourAutomationMode('', new Date('2026-10-05T23:00:00Z')), 'report');
  assert.equal(tourAutomationMode(undefined, new Date('2026-10-06T00:00:00Z')), 'write');
  assert.equal(tourAutomationMode('nonsense', new Date('2026-09-01')), 'report');
});
