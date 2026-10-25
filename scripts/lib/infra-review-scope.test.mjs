// scripts/lib/infra-review-scope.test.mjs — BRO-2310.
//
// The full classifyPath/evaluateInfraReviewGate acceptance suite lives in
// scripts/tests/infra-review-gate.test.mjs (manifest-registered, not
// auto-globbed) — this file does not restate that coverage. It exists
// specifically for BRO-2310's own acceptance criterion (`node --test
// scripts/lib/infra-review-scope.test.mjs`) and covers the two properties
// that card changed in findFreshPlanVerdict:
//   1. A fail is now the freshest verdict the moment it's recorded, so it
//      RE-BLOCKS a session that had an earlier pass on file — closing the
//      bug an adversarial /ship-check review caught in the first version of
//      this fix (the original code only ever compared PASS timestamps, so an
//      old pass outlived a later fail for the rest of the TTL window).
//   2. A fail-then-pass sequence still unlocks the gate at THIS layer — that
//      was true before BRO-2310 and stays true after it; hard-blocking here
//      was considered and rejected (see the comment above findFreshPlanVerdict).
// The accountability half of the fix (a pass overturning a fail needs --note
// or --reviewer=owner-override) lives in recordPlanVerdict(), tested in
// tests/unit/review-gate.test.mjs, because that is where the ledger is
// actually written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateInfraReviewGate, findFreshPlanVerdict } = require('./infra-review-scope.js');

const NOW = Date.parse('2026-09-16T12:00:00Z');
const SESSION = 'sess-2310';
const CRITICAL_PATH = 'scripts/lib/backlog-drain.js';

const planVerdict = (over = {}) => ({
  ts: new Date(NOW - 60_000).toISOString(),
  phase: 'plan',
  reviewer: 'plan-review',
  result: 'pass',
  sessionId: SESSION,
  ...over,
});

test('BRO-2310: a fail followed by an ordinary (non-owner-override) pass still unlocks the gate', () => {
  // This is the sequence the card's title describes. It is deliberately
  // still ALLOWED here — the fix moved accountability to write time
  // (recordPlanVerdict requiring --note/--reviewer=owner-override), not to a
  // hard block in findFreshPlanVerdict, because the gate has no way to tell
  // a genuinely revised plan from a repeated second opinion (open question 3,
  // still unresolved). A pass recordPlanVerdict actually accepted after a
  // fail carries overturnsFail:true, which this test includes to mirror a
  // real ledger entry.
  const verdicts = [
    planVerdict({ ts: new Date(NOW - 120_000).toISOString(), result: 'fail' }),
    planVerdict({ ts: new Date(NOW - 60_000).toISOString(), reviewer: 'second-opinion', overturnsFail: true }),
  ];
  const d = evaluateInfraReviewGate({ paths: [CRITICAL_PATH], verdicts, sessionId: SESSION, now: NOW });
  assert.equal(d.action, 'allow');
  const fresh = findFreshPlanVerdict({ verdicts, sessionId: SESSION, now: NOW });
  assert.equal(fresh.overturnsFail, true, 'the freshest verdict returned must still carry the accountability tag');
});

test('BRO-2310: a lone fail (no subsequent pass at all) still blocks — unchanged by the fix', () => {
  const d = evaluateInfraReviewGate({
    paths: [CRITICAL_PATH], verdicts: [planVerdict({ result: 'fail' })], sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'block');
});

test('BRO-2310: an owner-override pass after a fail unlocks and is indistinguishable in shape from any other pass here', () => {
  // findFreshPlanVerdict has no special-cased reviewer check — 'owner-override'
  // is just a string. The write-time gate is what actually requires it.
  const verdicts = [
    planVerdict({ ts: new Date(NOW - 120_000).toISOString(), result: 'fail' }),
    planVerdict({ ts: new Date(NOW - 60_000).toISOString(), reviewer: 'owner-override', overturnsFail: true }),
  ];
  const d = evaluateInfraReviewGate({ paths: [CRITICAL_PATH], verdicts, sessionId: SESSION, now: NOW });
  assert.equal(d.action, 'allow');
  assert.match(d.reason, /owner-override/);
});

test('BRO-2310: a PASS followed by a LATER fail re-blocks — an earlier pass must not outlive a later fail', () => {
  // The bug an adversarial review caught in v1 of this fix: the original
  // findFreshPlanVerdict only ever compared PASS timestamps against each
  // other, so it never even looked at whether a later verdict existed that
  // was a fail. A session that passed once and then failed a later review
  // (scope grew, plan changed) stayed "covered" until the original pass aged
  // out of the TTL window — nothing about a fresh fail ever mattered.
  const verdicts = [
    planVerdict({ ts: new Date(NOW - 120_000).toISOString(), result: 'pass' }),
    planVerdict({ ts: new Date(NOW - 60_000).toISOString(), reviewer: 'second-opinion', result: 'fail' }),
  ];
  const d = evaluateInfraReviewGate({ paths: [CRITICAL_PATH], verdicts, sessionId: SESSION, now: NOW });
  assert.equal(d.action, 'block', 'the later fail must be the verdict that governs, not the earlier pass');
  assert.equal(findFreshPlanVerdict({ verdicts, sessionId: SESSION, now: NOW }), null);
});

test('BRO-2310: on a millisecond timestamp tie, the ledger\'s append order (later array position) wins', () => {
  const tiedTs = new Date(NOW - 60_000).toISOString();
  const verdicts = [
    planVerdict({ ts: tiedTs, result: 'fail' }),
    planVerdict({ ts: tiedTs, reviewer: 'owner-override', result: 'pass' }),
  ];
  const fresh = findFreshPlanVerdict({ verdicts, sessionId: SESSION, now: NOW });
  assert.ok(fresh, 'the later-appended pass must win the tie, not lose to the earlier fail');
  assert.equal(fresh.reviewer, 'owner-override');
});
