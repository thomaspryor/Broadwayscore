import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { auditExitDecision } = require('../../scripts/lib/aggregator-gap-audit-exit.js');
const { riskStateMap, isRiskyGapChange, confirmQuarantinedStates } = require('../../scripts/lib/gap-audit-merge.js');

const ok = { ok: true };
const base = { dryRun: false, blast: ok, failOnGap: false, runWithGap: 5 };

test('gaps found, guard ok: exit 0 (gaps alone never redden the cron)', () => {
  assert.deepEqual(auditExitDecision(base), { exitCode: 0, reason: 'ok' });
});

test('blast-radius refusal (full or partial write) exits 1; per-source fetch errors are not an exit input', () => {
  assert.deepEqual(auditExitDecision({ ...base, blast: { ok: false } }),
    { exitCode: 1, reason: 'blast-radius-refused' });
});

test('dry-run never fails on refusal ', () => {
  assert.equal(auditExitDecision({ ...base, dryRun: true, blast: { ok: false } }).exitCode, 0);
});

test('--fail-on-gap only fails when a gap exists', () => {
  assert.equal(auditExitDecision({ ...base, failOnGap: true, runWithGap: 0 }).exitCode, 0);
  assert.equal(auditExitDecision({ ...base, failOnGap: true, runWithGap: 1 }).reason, 'fail-on-gap');
});

// Regression for the actual 2026-09 red streak: a deterministic candidate-rule
// drop that reproduces its quarantined state must be accepted as baseline, so the
// same shows do not refuse the write on every run.
test('reproduced quarantined state is confirmed, so the guard stops refusing', () => {
  const prev = { a: 'incomplete:3:10' };
  const next = { a: 'incomplete:3:7' };
  assert.equal(isRiskyGapChange(prev.a, next.a), true);
  const prevResults = [{ showId: 'a', quarantine: { nextState: next.a } }];
  const { prevStates, confirmed } = confirmQuarantinedStates(prev, next, prevResults);
  assert.deepEqual(confirmed, ['a']);
  assert.equal(isRiskyGapChange(prevStates.a, next.a), false);
});

test('a liveCount drop (partial-checkout signature) is never confirmed', () => {
  const prev = { a: 'complete:5:5' };
  const next = { a: 'incomplete:0:5' };
  const { confirmed } = confirmQuarantinedStates(prev, next, [{ showId: 'a', quarantine: { nextState: next.a } }]);
  assert.deepEqual(confirmed, []);
});
