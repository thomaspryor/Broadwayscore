/**
 * verify-landed-proof-saferun.test.mjs: RECHECK-AFTER acceptance command for BRO-7796.
 * Asserts against LIVE repo data (data/audit/landed-change-proof.jsonl), not a fixture: once the nightly audit has run on
 * an audit day after the fix landed (2026-11-18), at least one ledger row must carry a passing safeRun on a not_run file.
 * Before that date it skips. A red run later is the claim being disproven, not a code regression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, '..', 'data', 'audit', 'landed-change-proof.jsonl');
const CHECKABLE_FROM = Date.parse('2026-11-19T06:00:00Z'); // after the 04:10 UTC nightly run, which GitHub may fire late

test('the nightly audit now self-runs not_run files: a ledger row carries a passing safeRun', {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-19',
}, () => {
  const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const proven = rows.filter((r) => r.auditDay >= '2026-11-19' && (r.files || []).some((f) => f.safeRun && f.safeRun.ok));
  assert.ok(proven.length > 0, 'no ledger row since 2026-11-19 carries a passing safeRun; the audit self-run path is not producing rows');
});
