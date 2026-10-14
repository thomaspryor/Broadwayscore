/**
 * health-check-sweep-staleness.test.mjs — BRO-4382.
 *
 * health-check.js must flag a stale data/audit/open-backlog-acceptance-sweep.json
 * (generatedAt written by writeReport in scripts/sweep-open-backlog-acceptance.js).
 * require()s the REAL sweepReportStalenessResult (CLAUDE.md §15) and the real
 * health-check.js playbook lookup, no copied logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  sweepReportStalenessResult,
  SWEEP_REPORT_ROW_NAME,
  SWEEP_REPORT_WARN_H,
  SWEEP_REPORT_ERROR_H,
} = require('../lib/sweep-report-staleness.js');

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const hoursBefore = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

test('thresholds are 48h warn / 96h error', () => {
  assert.equal(SWEEP_REPORT_WARN_H, 48);
  assert.equal(SWEEP_REPORT_ERROR_H, 96);
});

test('fresh report (<48h) passes', () => {
  const r = sweepReportStalenessResult({ report: { generatedAt: hoursBefore(5) } }, NOW);
  assert.equal(r.status, 'pass');
  assert.equal(r.name, SWEEP_REPORT_ROW_NAME);
  assert.equal(r.message, '5h old');
});

test('exactly 48h is still pass (strict >)', () => {
  assert.equal(sweepReportStalenessResult({ report: { generatedAt: hoursBefore(48) } }, NOW).status, 'pass');
});

test('48-96h old warns', () => {
  const r = sweepReportStalenessResult({ report: { generatedAt: hoursBefore(60) } }, NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /warn threshold: 2d/);
  assert.ok(r.hint);
});

test('>96h old errors', () => {
  const r = sweepReportStalenessResult({ report: { generatedAt: hoursBefore(120) } }, NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /error threshold: 4d/);
});

test('missing file (null report) warns, does not crash', () => {
  const r = sweepReportStalenessResult({ report: null }, NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /not yet run/);
  assert.equal(sweepReportStalenessResult(undefined, NOW).status, 'warn');
});

test('unparseable JSON errors', () => {
  const r = sweepReportStalenessResult({ parseError: 'Unexpected token } in JSON at position 3' }, NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /^Unparseable JSON/);
});

test('missing or unparseable generatedAt errors', () => {
  assert.equal(sweepReportStalenessResult({ report: {} }, NOW).status, 'error');
  const bad = sweepReportStalenessResult({ report: { generatedAt: 'not a date' } }, NOW);
  assert.equal(bad.status, 'error');
  assert.match(bad.message, /Unparseable date/);
});

test('health-check.js checkSweepReportStaleness reads the file: absent, bad JSON, stale, fresh', () => {
  const { checkSweepReportStaleness } = require('../health-check.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-staleness-'));
  try {
    const file = path.join(dir, 'open-backlog-acceptance-sweep.json');
    assert.equal(checkSweepReportStaleness({ auditDir: dir, now: NOW }).status, 'warn');

    fs.writeFileSync(file, '{"generatedAt": ');
    const bad = checkSweepReportStaleness({ auditDir: dir, now: NOW });
    assert.equal(bad.status, 'error');
    assert.match(bad.message, /^Unparseable JSON/);

    fs.writeFileSync(file, JSON.stringify({ generatedAt: hoursBefore(100) }));
    assert.equal(checkSweepReportStaleness({ auditDir: dir, now: NOW }).status, 'error');

    fs.writeFileSync(file, JSON.stringify({ generatedAt: hoursBefore(2) }));
    const fresh = checkSweepReportStaleness({ auditDir: dir, now: NOW });
    assert.equal(fresh.status, 'pass');
    assert.equal(fresh.name, SWEEP_REPORT_ROW_NAME);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('row is registered in health-check.js AUTO_FIX_PLAYBOOK (not anonymous low)', () => {
  const { getPlaybookEntry } = require('../health-check.js');
  const entry = getPlaybookEntry(SWEEP_REPORT_ROW_NAME);
  assert.ok(entry, 'playbook entry exists');
  assert.equal(entry.urgency, 'this-week');
});

test('a fresh report carrying fetchError warns (watchdog reads an empty set)', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const r = sweepReportStalenessResult({ report: { generatedAt: '2026-10-14T11:00:00Z', fetchError: 'bad key' } }, now);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /fetchError/);
});

test('row sits inside computeCoreHealthResults so the health-row probe sees it', () => {
  const src = fs.readFileSync(new URL('../health-check.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function computeCoreHealthResults');
  const end = src.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  assert.match(src.slice(start, end), /checkSweepReportStaleness\(\)/);
});

test('a stale report that also carries fetchError still escalates to error at >96h', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const r = sweepReportStalenessResult({ report: { generatedAt: '2026-10-08T12:00:00Z', fetchError: 'bad key' } }, now);
  assert.equal(r.status, 'error');
});
