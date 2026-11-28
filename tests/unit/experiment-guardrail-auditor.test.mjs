import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { EXPECTED_RATIO, auditGateColdStart, auditRegisteredGuardrails, formatGuardrailAudit } = require('../../scripts/lib/experiment-guardrail-auditor.js');

const nowMs = Date.parse('2026-09-14T18:27:45.455Z');
const weekMs = 7 * 24 * 60 * 60 * 1000;
const liveRegistry = [{ key: 'gate-cold-start', expected: {
  exists: true, active: true, variants: [{ key: 'control', pct: 50 }, { key: 'cold-start', pct: 50 }],
} }];
function snapshot(control = 233, treatment = 95, weeksAgo = 0) {
  return { lastRunAt: new Date(nowMs - weeksAgo * weekMs).toISOString(), lastSummary: { recent: {
    days: 7, effectiveDays: 7, flagHealthy: true,
    arms: { control: { shown: control }, 'cold-start': { shown: treatment } },
  } } };
}

test('healthy post-recalibration readout reports measured ratio without warning', () => {
  const result = auditGateColdStart([snapshot()], { nowMs });
  assert.equal(EXPECTED_RATIO, 2.5);
  assert.equal(result.status, 'healthy');
  assert.equal(result.measuredRatio, 233 / 95);
  assert.equal(result.sampleWeeks, 1);
  assert.match(formatGuardrailAudit(result), /INFO/);
  assert.doesNotMatch(formatGuardrailAudit(result), /WARNING/);
});

test('untested 10:1 projection warns against the same realized readout', () => {
  const result = auditGateColdStart([snapshot()], { nowMs, expectedRatio: 10 });
  assert.equal(result.status, 'warning');
  assert.match(formatGuardrailAudit(result), /WARNING.*experiment-guardrail-drift/);
  assert.ok(result.driftFactor > 4);
});

test('drift in either direction and inverted arms warn', () => {
  for (const [control, treatment] of [[100, 100], [1000, 100], [95, 233]]) {
    assert.equal(auditGateColdStart([snapshot(control, treatment)], { nowMs }).status, 'warning');
  }
});

test('zero in either arm warns with JSON-safe measurements', () => {
  for (const counts of [[100, 0], [0, 100]]) {
    const result = auditGateColdStart([snapshot(...counts)], { nowMs });
    assert.equal(result.status, 'warning');
    assert.equal(result.driftFactor, null);
    assert.doesNotThrow(() => JSON.parse(formatGuardrailAudit(result).split(': ').slice(1).join(': ')));
  }
});

test('exact factor boundary is healthy; exceeding it warns', () => {
  assert.equal(auditGateColdStart([snapshot(500, 100)], { nowMs }).status, 'healthy');
  assert.equal(auditGateColdStart([snapshot(501, 100)], { nowMs }).status, 'warning');
});

test('trailing four weeks pool counts and discard older, future and overlapping reruns', () => {
  const input = [snapshot(233, 95), snapshot(200, 100, 1), snapshot(300, 100, 2),
    snapshot(250, 100, 3), snapshot(9999, 100, 4), snapshot(9999, 100, -1),
    snapshot(9999, 100, 0.5), snapshot()];
  const result = auditGateColdStart(input, { nowMs });
  assert.equal(result.sampleWeeks, 4);
  assert.equal(result.measuredRatio, (233 + 200 + 300 + 250) / (95 + 100 + 100 + 100));
  assert.equal(result.snapshots.length, 4);
  assert.equal(result.status, 'healthy');
});

test('pooled ratio weights a small week by its shown counts', () => {
  const result = auditGateColdStart([snapshot(10000, 4000), snapshot(100, 0, 1)], { nowMs });
  assert.equal(result.measuredRatio, 10100 / 4000);
  assert.equal(result.status, 'healthy');
});

test('missing, sparse, partial, unhealthy and malformed readouts are insufficient data', () => {
  const variants = [null, {}, snapshot(1, 1), snapshot(-1, 200), snapshot('233', 95), snapshot(NaN, 200)];
  for (const patch of [{ days: 180 }, { effectiveDays: 6.9 }, { flagHealthy: false }, { flagHealthy: undefined }]) {
    const input = snapshot();
    Object.assign(input.lastSummary.recent, patch);
    variants.push(input);
  }
  for (const input of variants) {
    assert.equal(auditGateColdStart([input], { nowMs }).status, 'insufficient-data');
  }
  assert.equal(auditGateColdStart([], { nowMs }).status, 'insufficient-data');
});

test('stale and future data are not reported healthy', () => {
  for (const weeksAgo of [-1, 4, 20]) {
    assert.equal(auditGateColdStart([snapshot(233, 95, weeksAgo)], { nowMs }).status, 'insufficient-data');
  }
});

test('retired, absent, inactive and pinned experiments are skipped without reading state', () => {
  for (const registry of [[], [{ key: 'gate-cold-start', expected: { exists: false } }],
    [{ key: 'gate-cold-start', expected: { ...liveRegistry[0].expected, active: false } }],
    [{ key: 'gate-cold-start', expected: { ...liveRegistry[0].expected, variants: [{ pct: 100 }, { pct: 0 }] } }]]) {
    const result = auditRegisteredGuardrails({ registry, readState() { assert.fail('must skip before I/O'); } });
    assert.equal(result.status, 'skipped');
  }
});

test('registered adapter combines persisted history with latest analyzer readout', () => {
  const result = auditRegisteredGuardrails({ registry: liveRegistry, nowMs,
    history: [snapshot(250, 100, 1)], readState: () => snapshot() });
  assert.equal(result.status, 'healthy');
  assert.equal(result.sampleWeeks, 2);
  assert.equal(result.measuredRatio, 483 / 195);
  assert.doesNotMatch(formatGuardrailAudit(result), /snapshots/);
});

test('missing or corrupt analyzer state is visible and non-blocking', () => {
  for (const error of [Object.assign(new Error('missing'), { code: 'ENOENT' }), new SyntaxError('bad JSON')]) {
    const result = auditRegisteredGuardrails({ registry: liveRegistry, readState() { throw error; } });
    assert.equal(result.status, 'unavailable');
    assert.match(formatGuardrailAudit(result), /WARNING/);
  }
});

test('invalid audit options fail clearly', () => {
  for (const options of [{ weeks: 0 }, { expectedRatio: 0 }, { maxDriftFactor: 1 }, { nowMs: NaN }]) {
    assert.throws(() => auditGateColdStart([], options), /Invalid guardrail audit options/);
  }
});

test('existing weekly monitor runs the advisory auditor in dry-run mode', () => {
  const { REGISTERED_FLAGS } = require('../../scripts/lib/flag-registry.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2970-monitor-'));
  try {
    const fixturePath = path.join(dir, 'flags.json');
    fs.writeFileSync(fixturePath, JSON.stringify(Object.fromEntries(REGISTERED_FLAGS.map(({ key, expected }) =>
      [key, expected.exists ? expected : null]))));
    const result = spawnSync(process.execPath, ['scripts/monitor-flag-parity.js', '--dry-run'], {
      cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, FLAG_PARITY_FIXTURE: fixturePath, FLAG_PARITY_STATE_FILE: path.join(dir, 'state.json') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[log-only\] INFO experiment-guardrail-drift: .*"status":"skipped"/);
    assert.match(result.stdout, /Decisions: weekly-summary/);
    assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
    // Valid JSON null was tolerated by the original monitor's state spread.
    // Loading the new history must preserve that recovery behavior.
    fs.writeFileSync(path.join(dir, 'state.json'), 'null');
    const nullState = spawnSync(process.execPath, ['scripts/monitor-flag-parity.js', '--dry-run'], {
      cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, FLAG_PARITY_FIXTURE: fixturePath, FLAG_PARITY_STATE_FILE: path.join(dir, 'state.json') },
    });
    assert.equal(nullState.status, 0, nullState.stderr);
    assert.match(nullState.stdout, /experiment-guardrail-drift: .*"status":"skipped"/);
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), 'null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
