import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { evaluateOutletHeartbeat } = require('./outlet-heartbeat-monitor-core.js');

function makeAuditDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outlet-heartbeat-'));
}

function writeJSON(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

describe('evaluateOutletHeartbeat', () => {
  test('missing outlet-heartbeat.json warns that the cron may not have run', () => {
    const dir = makeAuditDir();
    const result = evaluateOutletHeartbeat({ auditDir: dir });
    assert.equal(result.status, 'warn');
    assert.match(result.message, /No outlet-heartbeat\.json/);
  });

  test('generatedAt older than 8 days warns stale, regardless of row content', () => {
    const dir = makeAuditDir();
    const nowMs = Date.parse('2026-09-14T12:00:00Z');
    writeJSON(dir, 'outlet-heartbeat.json', {
      generatedAt: '2026-08-27T12:00:00Z', // 18 days before nowMs
      rows: [],
    });
    const result = evaluateOutletHeartbeat({ auditDir: dir, nowMs });
    assert.equal(result.status, 'warn');
    assert.match(result.message, /last ran 18d ago/);
    assert.match(result.hint, /stale\/disabled/);
  });

  test('fresh snapshot with no rows crossing the redStreak>=2 threshold passes', () => {
    const dir = makeAuditDir();
    const nowMs = Date.parse('2026-09-14T12:00:00Z');
    writeJSON(dir, 'outlet-heartbeat.json', {
      generatedAt: '2026-09-14T09:00:00Z',
      rows: [{ outletId: 'nytimes', market: 'broadway', status: 'red', silentDays: 50, thresholdDays: 45 }],
    });
    writeJSON(dir, 'outlet-heartbeat-state.json', {
      'nytimes::broadway': { redStreak: 1 },
    });
    const result = evaluateOutletHeartbeat({ auditDir: dir, nowMs });
    assert.equal(result.status, 'pass');
    assert.match(result.message, /none NEW silent/);
  });

  test('a row crossing threshold and not in the baseline is actionable (warn)', () => {
    const dir = makeAuditDir();
    const nowMs = Date.parse('2026-09-14T12:00:00Z');
    writeJSON(dir, 'outlet-heartbeat.json', {
      generatedAt: '2026-09-14T09:00:00Z',
      rows: [{ outletId: 'guardian', market: 'broadway', status: 'red', silentDays: 130, thresholdDays: 45 }],
    });
    writeJSON(dir, 'outlet-heartbeat-state.json', {
      'guardian::broadway': { redStreak: 2 },
    });
    const result = evaluateOutletHeartbeat({ auditDir: dir, nowMs });
    assert.equal(result.status, 'warn');
    assert.match(result.message, /1 NEW T1\/T2 outlet×market row/);
    assert.equal(result.actionable[0].outletId, 'guardian');
  });

  test('a row crossing threshold but already in the baseline is quietly known, not actionable', () => {
    const dir = makeAuditDir();
    const nowMs = Date.parse('2026-09-14T12:00:00Z');
    writeJSON(dir, 'outlet-heartbeat.json', {
      generatedAt: '2026-09-14T09:00:00Z',
      rows: [{ outletId: 'playbill', market: 'broadway', status: 'red', silentDays: 5250, thresholdDays: 5008 }],
    });
    writeJSON(dir, 'outlet-heartbeat-state.json', {
      'playbill::broadway': { redStreak: 5 },
    });
    writeJSON(dir, 'outlet-heartbeat-baseline.json', { keys: ['playbill::broadway'] });
    const result = evaluateOutletHeartbeat({ auditDir: dir, nowMs });
    assert.equal(result.status, 'pass');
    assert.match(result.message, /1 known\/baselined/);
  });
});
