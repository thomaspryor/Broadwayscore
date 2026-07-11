/**
 * WE gate self-proving auto-enable — decision-logic + safety-wiring tests.
 * Hardened per ship-check 2026-07-11 (P0: proving must measure reference
 * CORRECTNESS via corroboration, not detector uptime).
 * Run: node --test tests/unit/we-gate-proving.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recordGateObservation, evaluateProving, emptyTracker, baseTitleKey } = require('../../scripts/lib/we-gate-proving.js');

const REF_GOOD = { rowCount: 8, currentRunRows: 8, corroborated: 5, allSourcesFailed: false, sources: { westendtheatre: { found: true, rows: 8, emptyParse: false, error: null } } };
const REF_PRIOR_RUN_ONLY = { rowCount: 7, currentRunRows: 0, corroborated: 0, allSourcesFailed: false, sources: { westendtheatre: { found: true, rows: 7, emptyParse: false, error: null } } };
const REF_UNCORROBORATED = { rowCount: 6, currentRunRows: 6, corroborated: 0, allSourcesFailed: false, sources: {} };
const REF_EMPTYPARSE = { rowCount: 0, currentRunRows: 0, corroborated: 0, allSourcesFailed: false, sources: { westendtheatre: { found: true, rows: 0, emptyParse: true, error: null } } };

const newShow = (id, openingDate) => ({ id, openingDate });
const observe = (t, show, ref, n) => { for (let i = 0; i < n; i++) recordGateObservation(t, show, ref, '2026-07-15T00:00:00Z'); return t; };

describe('evaluateProving (correctness-based)', () => {
  test('2 new openings, corroborated references, clean floors → enable', () => {
    const t = emptyTracker();
    observe(t, newShow('alpha-west-end-2026', '2026-07-12'), REF_GOOD, 2);
    observe(t, newShow('beta-west-end-2026', '2026-07-14'), REF_GOOD, 3);
    const v = evaluateProving(t);
    assert.equal(v.enable, true);
    assert.deepEqual(v.qualifying.sort(), ['alpha-west-end-2026', 'beta-west-end-2026']);
  });

  test('P0 GUARD: prior-run-only references NEVER qualify (rows are permanently ingest-blocked)', () => {
    const t = emptyTracker();
    observe(t, newShow('revival-a-west-end-2026', '2026-07-12'), REF_PRIOR_RUN_ONLY, 5);
    observe(t, newShow('revival-b-west-end-2026', '2026-07-14'), REF_PRIOR_RUN_ONLY, 5);
    assert.equal(evaluateProving(t).enable, false);
  });

  test('P0 GUARD: uncorroborated references never qualify — citations must match reviews we independently have', () => {
    const t = emptyTracker();
    observe(t, newShow('a-west-end-2026', '2026-07-12'), REF_UNCORROBORATED, 4);
    observe(t, newShow('b-west-end-2026', '2026-07-14'), REF_UNCORROBORATED, 4);
    assert.equal(evaluateProving(t).enable, false);
  });

  test('P1 GUARD: WE + off-WE sibling entries of one production count ONCE', () => {
    const t = emptyTracker();
    observe(t, newShow('gala-west-end-2026', '2026-07-12'), REF_GOOD, 2);
    observe(t, newShow('gala-off-west-end-2026', '2026-07-12'), REF_GOOD, 2);
    const v = evaluateProving(t);
    assert.equal(v.enable, false, 'one production must not satisfy minShows=2');
    assert.equal(v.qualifying.length, 1);
  });

  test('baseTitleKey collapses market/year suffixes', () => {
    assert.equal(baseTitleKey('gala-west-end-2026'), baseTitleKey('gala-off-west-end-2026'));
    assert.notEqual(baseTitleKey('gala-west-end-2026'), baseTitleKey('fete-west-end-2026'));
  });

  test('pre-gate-live openings do not count; floors permanently disqualify; enabledAt blocks re-fire', () => {
    const t = emptyTracker();
    observe(t, newShow('old-west-end-2026', '2026-06-30'), REF_GOOD, 5);
    const flaky = newShow('flaky-west-end-2026', '2026-07-12');
    observe(t, flaky, REF_GOOD, 2);
    observe(t, flaky, REF_EMPTYPARSE, 1);
    observe(t, flaky, REF_GOOD, 3);
    observe(t, newShow('clean-west-end-2026', '2026-07-13'), REF_GOOD, 2);
    let v = evaluateProving(t);
    assert.equal(v.enable, false);
    assert.deepEqual(v.qualifying, ['clean-west-end-2026']);
    observe(t, newShow('second-west-end-2026', '2026-07-14'), REF_GOOD, 2);
    assert.equal(evaluateProving(t).enable, true);
    t.enabledAt = '2026-07-20T00:00:00Z';
    assert.equal(evaluateProving(t).enable, false);
  });

  test('missing weReference (WE branch threw) counts as a floor', () => {
    const t = emptyTracker();
    const show = newShow('threw-west-end-2026', '2026-07-12');
    recordGateObservation(t, show, null, '2026-07-15T00:00:00Z');
    observe(t, show, REF_GOOD, 3);
    assert.equal(evaluateProving(t).qualifying.length, 0);
  });
});

describe('audit + workflow safety wiring', () => {
  const auditSrc = fs.readFileSync(new URL('../../scripts/audit-show-review-gap.js', import.meta.url), 'utf8');

  test('flip is CI-only (a local --checkpoint run must never set a prod variable)', () => {
    assert.ok(auditSrc.includes("process.env.GITHUB_ACTIONS === 'true'"), 'GITHUB_ACTIONS guard present');
  });

  test('create-never-overwrite: existing variable = operator state, respected', () => {
    assert.ok(auditSrc.includes("['variable', 'get', 'WE_GAP_INGEST']"), 'existence check before set');
    assert.ok(auditSrc.includes('respecting your state'), 'operator-state email path');
  });

  test('crash-safe ordering + notification retry', () => {
    assert.ok(auditSrc.includes('persist proof BEFORE side effects'), 'provenAt saved before flip');
    assert.ok(auditSrc.includes('notifyPending'), 'undelivered enable-notice retried on later runs');
    assert.ok(auditSrc.includes('delayed notice'), 'retry email path exists');
  });

  test('actionable-only policy: enable/failure notices are severity error (emailable), not suppressed FYI', () => {
    // The auto-enable + one-command + delayed-notice emails announce an autonomous
    // production state change — they MUST reach the owner under the 2026-07-11
    // actionable-only email policy (only critical/error email). A silent downgrade
    // to info/warning would suppress the one notice that matters.
    const enableBlock = auditSrc.slice(auditSrc.indexOf('Self-proving auto-enable'));
    assert.ok(!/one command to enable auto-ingest[\s\S]{0,200}?severity: 'info'/.test(enableBlock),
      'enable notice must not be info-severity (would be email-suppressed)');
    assert.ok((enableBlock.match(/severity: 'error'/g) || []).length >= 3,
      'the three enable/failure notices are error-severity so the policy delivers them');
  });

  test('corroboration stats are computed by the audit (currentRunRows + corroborated)', () => {
    assert.ok(auditSrc.includes('result.weReference.currentRunRows'), 'current-run row count recorded');
    assert.ok(auditSrc.includes('result.weReference.corroborated'), 'corroboration count recorded');
  });

  test('workflow commits the proving tracker', () => {
    const wf = fs.readFileSync(new URL('../../.github/workflows/audit-aggregator-gap.yml', import.meta.url), 'utf8');
    assert.ok(wf.includes('data/audit/we-gate-proving.json'), 'tracker persisted across runs');
  });
});
