/**
 * BRO-2205 root-cause follow-up: swap headroom is the signal nothing in the
 * pipeline currently reads. These tests exercise the pure parser/decision
 * functions against a real captured `sysctl vm.swapusage` line (macOS,
 * encrypted swap) plus edge cases, per CLAUDE.md rule 15.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSwapUsage, isSwapPressureCritical } from '../../scripts/lib/swap-pressure.js';

test('parseSwapUsage: parses a real macOS vm.swapusage line (encrypted swap)', () => {
  const result = parseSwapUsage('vm.swapusage: total = 14336.00M  used = 13365.19M  free = 970.81M  (encrypted)');
  assert.deepEqual(result, { totalMB: 14336, usedMB: 13365.19, freeMB: 970.81 });
});

test('parseSwapUsage: parses a line without the trailing "(encrypted)" tag', () => {
  const result = parseSwapUsage('vm.swapusage: total = 2048.00M  used = 0.00M  free = 2048.00M');
  assert.deepEqual(result, { totalMB: 2048, usedMB: 0, freeMB: 2048 });
});

test('parseSwapUsage: unparseable input (missing binary, unexpected format) returns null, not a throw', () => {
  assert.equal(parseSwapUsage(''), null);
  assert.equal(parseSwapUsage('sysctl: unknown oid'), null);
  assert.equal(parseSwapUsage(undefined), null);
});

test('parseSwapUsage: a malformed multi-dot number (garbled/truncated line) returns null, not NaN', () => {
  // Adversarial review finding: [\d.]+ matches "1.2.3" and Number("1.2.3")
  // is NaN, which must not silently read as healthy (NaN < floor is always
  // false in isSwapPressureCritical).
  const result = parseSwapUsage('vm.swapusage: total = 14336.00M  used = 13365.19M  free = 1.2.3M');
  assert.equal(result, null);
});

test('isSwapPressureCritical: below the floor is critical', () => {
  assert.equal(isSwapPressureCritical({ totalMB: 14336, freeMB: 970.81, floorMB: 1024 }), true);
});

test('isSwapPressureCritical: at or above the floor is not critical', () => {
  assert.equal(isSwapPressureCritical({ totalMB: 14336, freeMB: 2048, floorMB: 1024 }), false);
  assert.equal(isSwapPressureCritical({ totalMB: 14336, freeMB: 1024, floorMB: 1024 }), false);
});

test('isSwapPressureCritical: totalMB=0 (no swap allocated yet) is never critical, even with freeMB below the floor', () => {
  // Final-pass review finding: a freshly-booted Mac with no swap pressure
  // reads {totalMB: 0, freeMB: 0}, which would trip "critical" against any
  // positive floor despite there being no actual pressure. totalMB===0
  // means "no pressure data yet", not "critical".
  assert.equal(isSwapPressureCritical({ totalMB: 0, freeMB: 0, floorMB: 1024 }), false);
});
