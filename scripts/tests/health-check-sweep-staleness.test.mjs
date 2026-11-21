/**
 * health-check-sweep-staleness.test.mjs — BRO-4382, folded into the shared
 * audit freshness table (BRO-5352).
 *
 * health-check.js must flag a stale data/audit/open-backlog-acceptance-sweep.json
 * (generatedAt written by writeReport in scripts/sweep-open-backlog-acceptance.js).
 * The row lives in AUDIT_FRESHNESS_CHECKS (scripts/lib/audit-freshness-checks.js);
 * this test require()s the real evaluator and health-check.js (CLAUDE.md §15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AUDIT_FRESHNESS_CHECKS, evaluateAuditFreshness, auditFreshnessRowName } = require('../lib/audit-freshness-checks.js');

const row = AUDIT_FRESHNESS_CHECKS.find((r) => r.file === 'open-backlog-acceptance-sweep.json');
const ROW_NAME = 'Freshness: audit/open-backlog-acceptance-sweep.json';
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const hoursBefore = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

test('row exists, is named as before, and thresholds are 48h warn / 96h error', () => {
  assert.ok(row, 'sweep row missing from AUDIT_FRESHNESS_CHECKS');
  assert.equal(auditFreshnessRowName(row), ROW_NAME);
  assert.equal(row.warnH, 48);
  assert.equal(row.errorH, 96);
});

test('fresh report (<48h) is ok; exactly 48h is still ok (strict >)', () => {
  const r = evaluateAuditFreshness(row, { generatedAt: hoursBefore(5) }, NOW);
  assert.equal(r.status, 'ok');
  assert.equal(r.message, '5h old');
  assert.equal(evaluateAuditFreshness(row, { generatedAt: hoursBefore(48) }, NOW).status, 'ok');
});

test('48-96h old warns, >96h errors', () => {
  const w = evaluateAuditFreshness(row, { generatedAt: hoursBefore(60) }, NOW);
  assert.equal(w.status, 'warn');
  assert.match(w.message, /warn threshold: 2d/);
  const e = evaluateAuditFreshness(row, { generatedAt: hoursBefore(120) }, NOW);
  assert.equal(e.status, 'error');
  assert.match(e.message, /error threshold: 4d/);
});

test('missing file warns (not yet run), does not error', () => {
  const r = evaluateAuditFreshness(row, null, NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /not yet run/);
});

test('missing or unparseable generatedAt errors', () => {
  assert.equal(evaluateAuditFreshness(row, {}, NOW).status, 'error');
  const bad = evaluateAuditFreshness(row, { generatedAt: 'not a date' }, NOW);
  assert.equal(bad.status, 'error');
  assert.match(bad.message, /Unparseable date/);
});

test('a fresh report carrying fetchError warns (watchdog reads an empty set)', () => {
  const r = evaluateAuditFreshness(row, { generatedAt: hoursBefore(1), fetchError: 'bad key' }, NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /fetchError/);
});

test('a stale report that also carries fetchError still escalates to error at >96h', () => {
  assert.equal(evaluateAuditFreshness(row, { generatedAt: hoursBefore(144), fetchError: 'bad key' }, NOW).status, 'error');
});

test('fetchError on other table rows is not a warning (opt-in only)', () => {
  const other = AUDIT_FRESHNESS_CHECKS.find((r) => !r.fetchErrorWarn);
  assert.equal(evaluateAuditFreshness(other, { [other.field]: hoursBefore(0.1), fetchError: 'x' }, NOW).status, 'ok');
});

test('health-check.js checkAuditFreshness reads the file: absent, bad JSON, stale, fresh', () => {
  const { checkAuditFreshness } = require('../health-check.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-staleness-'));
  const get = () => checkAuditFreshness({ auditDir: dir, now: NOW }).find((r) => r.name === ROW_NAME);
  try {
    const file = path.join(dir, 'open-backlog-acceptance-sweep.json');
    assert.equal(get().status, 'warn');

    fs.writeFileSync(file, '{"generatedAt": ');
    assert.equal(get().status, 'error');
    assert.match(get().message, /^Unparseable JSON/);

    fs.writeFileSync(file, JSON.stringify({ generatedAt: hoursBefore(100) }));
    assert.equal(get().status, 'error');

    fs.writeFileSync(file, JSON.stringify({ generatedAt: hoursBefore(2) }));
    assert.equal(get().status, 'pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('row is registered in health-check.js AUTO_FIX_PLAYBOOK (not anonymous low) with a human action', () => {
  const { getPlaybookEntry } = require('../health-check.js');
  const entry = getPlaybookEntry(ROW_NAME);
  assert.ok(entry, 'playbook entry exists');
  assert.equal(entry.urgency, 'this-week');
  assert.ok(entry.humanAction);
});

test('the parallel sweep-staleness module and its health-check row are gone', () => {
  assert.equal(fs.existsSync(new URL('../lib/sweep-report-staleness.js', import.meta.url)), false);
  const src = fs.readFileSync(new URL('../health-check.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /checkSweepReportStaleness|sweep-report-staleness/);
});
