/**
 * Unit tests for buildVerdict/decideExit (BRO-365) — the pure verdict-
 * assembly and exit-code policy behind scripts/check-corpus-drift.js's daily
 * corpus-drift digest. Pattern: require() the real functions; never copy
 * logic into tests (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildVerdict, decideExit } = require('../check-corpus-drift.js');

function auditResult({ name = 'a', ok = true, crashed = false } = {}) {
  return { name, label: name, command: `node scripts/${name}.js`, exitCode: ok ? 0 : 1, ok, crashed, detail: '' };
}

describe('buildVerdict', () => {
  test('all-clean run: no drift, no crash', () => {
    const v = buildVerdict([auditResult({ name: 'a' }), auditResult({ name: 'b' })], '2026-09-08T00:00:00.000Z');
    assert.strictEqual(v.summary.auditsRun, 2);
    assert.strictEqual(v.summary.driftCount, 0);
    assert.strictEqual(v.summary.crashCount, 0);
    assert.strictEqual(v.summary.anyDrift, false);
    assert.strictEqual(v.summary.anyCrashed, false);
    assert.strictEqual(v._meta.generatedAt, '2026-09-08T00:00:00.000Z');
  });

  test('a failed-but-not-crashed audit counts as drift, not crash', () => {
    const v = buildVerdict([auditResult({ name: 'cross-show-url', ok: false, crashed: false })], 'now');
    assert.strictEqual(v.summary.driftCount, 1);
    assert.strictEqual(v.summary.crashCount, 0);
    assert.strictEqual(v.summary.anyDrift, true);
    assert.strictEqual(v.summary.anyCrashed, false);
  });

  test('a crashed audit counts as crash, not drift', () => {
    const v = buildVerdict([auditResult({ name: 'text-quality', ok: false, crashed: true })], 'now');
    assert.strictEqual(v.summary.driftCount, 0);
    assert.strictEqual(v.summary.crashCount, 1);
    assert.strictEqual(v.summary.anyDrift, false);
    assert.strictEqual(v.summary.anyCrashed, true);
  });

  test('mixed run: drift and crash counted independently', () => {
    const v = buildVerdict(
      [
        auditResult({ name: 'ok-one', ok: true }),
        auditResult({ name: 'drifted', ok: false, crashed: false }),
        auditResult({ name: 'crashed-one', ok: false, crashed: true }),
      ],
      'now',
    );
    assert.strictEqual(v.summary.auditsRun, 3);
    assert.strictEqual(v.summary.driftCount, 1);
    assert.strictEqual(v.summary.crashCount, 1);
    assert.strictEqual(v.summary.anyDrift, true);
    assert.strictEqual(v.summary.anyCrashed, true);
    assert.deepStrictEqual(v.audits.map((a) => a.name), ['ok-one', 'drifted', 'crashed-one']);
  });
});

describe('decideExit', () => {
  test('clean run exits 0 regardless of --strict', () => {
    assert.strictEqual(decideExit({ anyCrashed: false, anyDrift: false, strict: false }), 0);
    assert.strictEqual(decideExit({ anyCrashed: false, anyDrift: false, strict: true }), 0);
  });

  test('drift without --strict is non-blocking (exit 0)', () => {
    assert.strictEqual(decideExit({ anyCrashed: false, anyDrift: true, strict: false }), 0);
  });

  test('drift with --strict escalates to exit 2', () => {
    assert.strictEqual(decideExit({ anyCrashed: false, anyDrift: true, strict: true }), 2);
  });

  test('a crashed audit always exits 3, even without --strict or drift', () => {
    assert.strictEqual(decideExit({ anyCrashed: true, anyDrift: false, strict: false }), 3);
  });

  test('crash takes precedence over strict-drift (3, not 2)', () => {
    assert.strictEqual(decideExit({ anyCrashed: true, anyDrift: true, strict: true }), 3);
  });
});
