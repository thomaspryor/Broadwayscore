// scripts/lib/infra-review-scope.test.mjs — BRO-2310.
//
// The full classifyPath/evaluateInfraReviewGate acceptance suite lives in
// scripts/tests/infra-review-gate.test.mjs (manifest-registered, not
// auto-globbed) — this file does not restate that coverage. It exists
// specifically for BRO-2310's own acceptance criterion (`node --test
// scripts/lib/infra-review-scope.test.mjs`) and covers only the property that
// card changed: findFreshPlanVerdict/evaluateInfraReviewGate do NOT block a
// fail-then-pass sequence at the gate-evaluation layer — that was true before
// BRO-2310 and stays true after it. The accountability half of the fix
// (a pass overturning a fail needs --note or --reviewer=owner-override) lives
// in recordPlanVerdict(), tested in tests/unit/review-gate.test.mjs, because
// that is where the ledger is actually written.

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
