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

test('standalone tours (BRO-4931) default to report, follow their own variable, and are never louder than TOUR_AUTOCREATE', () => {
  const { standaloneTourMode } = createRequire(import.meta.url)('./tour-automation-mode.js');
  // Unset or nonsense is report, whatever the date: it is not switched on by LIVE_FROM.
  assert.equal(standaloneTourMode(undefined, 'write'), 'report');
  assert.equal(standaloneTourMode('', 'write'), 'report');
  assert.equal(standaloneTourMode('nonsense', 'write'), 'report');
  // An explicit value wins up to the main switch.
  assert.equal(standaloneTourMode('write', 'write'), 'write');
  assert.equal(standaloneTourMode('WRITE', 'write'), 'write');
  assert.equal(standaloneTourMode('off', 'write'), 'off');
  assert.equal(standaloneTourMode('report', 'write'), 'report');
  // Never louder than the main switch: TOUR_AUTOCREATE=report or off caps it.
  assert.equal(standaloneTourMode('write', 'report'), 'report');
  assert.equal(standaloneTourMode('write', 'off'), 'off');
  assert.equal(standaloneTourMode('report', 'off'), 'off');
  assert.equal(standaloneTourMode(undefined, 'off'), 'off');
  // An unknown main mode is treated as report.
  assert.equal(standaloneTourMode('write', 'bogus'), 'report');
});
