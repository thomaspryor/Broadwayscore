import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The lib reads/writes a fixed audit path. We monkey-patch the module's
// COUNTS_FILE by re-requiring with a swapped path via a thin shim — but
// that requires module mutation. Simpler: write the file there directly
// and ensure tests don't pollute each other.

const lib = require('../../scripts/lib/venue-anomaly.js');
const { checkVenueAnomaly, COUNTS_FILE } = lib;
const fs = require('node:fs');

function clearCounts() {
  try { fs.unlinkSync(COUNTS_FILE); } catch { /* ok */ }
}

function seedHistory(venue, countsByDate) {
  const data = { [venue]: countsByDate };
  fs.mkdirSync(require('node:path').dirname(COUNTS_FILE), { recursive: true });
  fs.writeFileSync(COUNTS_FILE, JSON.stringify(data, null, 2));
}

test('checkVenueAnomaly: no baseline → no alarm', () => {
  clearCounts();
  const r = checkVenueAnomaly('TestVenueA', 5, { dateOverride: '2026-05-10' });
  assert.equal(r.status, 'no-baseline');
  assert.notEqual(process.exitCode, 1);
});

test('checkVenueAnomaly: within range → ok', () => {
  clearCounts();
  process.exitCode = 0;
  seedHistory('TestVenueB', {
    '2026-05-03': 3, '2026-05-04': 4, '2026-05-05': 3,
    '2026-05-06': 4, '2026-05-07': 3, '2026-05-08': 4, '2026-05-09': 3,
  });
  const r = checkVenueAnomaly('TestVenueB', 5, { dateOverride: '2026-05-10' });
  assert.equal(r.status, 'ok');
  assert.equal(r.median, 3);
  assert.notEqual(process.exitCode, 1);
});

test('checkVenueAnomaly: anomalous spike → warning + exitCode 1', () => {
  clearCounts();
  process.exitCode = 0;
  seedHistory('TestVenueC', {
    '2026-05-03': 3, '2026-05-04': 4, '2026-05-05': 3,
    '2026-05-06': 4, '2026-05-07': 3, '2026-05-08': 4, '2026-05-09': 3,
  });
  // today's count 9 > 2 * median(3) = 6
  const r = checkVenueAnomaly('TestVenueC', 9, { dateOverride: '2026-05-10' });
  assert.equal(r.status, 'anomalous');
  assert.equal(process.exitCode, 1);
  // Restore so other tests don't inherit
  process.exitCode = 0;
});

test('checkVenueAnomaly: today=2x median exactly → still ok', () => {
  clearCounts();
  process.exitCode = 0;
  seedHistory('TestVenueD', {
    '2026-05-03': 3, '2026-05-04': 3, '2026-05-05': 3,
    '2026-05-06': 3, '2026-05-07': 3, '2026-05-08': 3, '2026-05-09': 3,
  });
  // 2 * 3 = 6 — not > so OK
  const r = checkVenueAnomaly('TestVenueD', 6, { dateOverride: '2026-05-10' });
  assert.equal(r.status, 'ok');
  assert.notEqual(process.exitCode, 1);
});

test('checkVenueAnomaly: median 0 (baseline all zeros) skips alarm', () => {
  clearCounts();
  process.exitCode = 0;
  seedHistory('TestVenueE', {
    '2026-05-03': 0, '2026-05-04': 0, '2026-05-05': 0,
    '2026-05-06': 0, '2026-05-07': 0, '2026-05-08': 0, '2026-05-09': 0,
  });
  // Don't fire when baseline median is 0 — first non-zero day is just bootstrap
  const r = checkVenueAnomaly('TestVenueE', 5, { dateOverride: '2026-05-10' });
  assert.equal(r.status, 'ok');
  assert.notEqual(process.exitCode, 1);
});
