// scripts/tests/infra-review-digest.test.mjs
//
// Acceptance test for task #1095: the infra-review gate (#1079) writes every
// warn/block to a gitignored, per-machine ledger that nothing reads. This
// tests the pure function (scripts/lib/infra-review-digest.js) that turns
// that ledger — plus the plan-phase verdicts review-gate.mjs already records
// — into the one digest row scripts/health-check.js emits.
//
// Per CLAUDE.md rule 15 this require()s the real function; it does not
// restate the counting logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeInfraReviewDigest, WINDOW_MS } = require('../lib/infra-review-digest.js');

const NOW = Date.parse('2026-08-06T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const gateEvent = (over = {}) => ({
  ts: daysAgo(1),
  action: 'warn',
  gated: true,
  tier: 'shared',
  reason: 'shared-infra edit with no recorded review (observed, not blocked)',
  matched: [],
  ...over,
});

const planVerdict = (over = {}) => ({
  ts: daysAgo(1),
  phase: 'plan',
  reviewer: 'plan-review',
  result: 'pass',
  sessionId: 'sess-1',
  ...over,
});

test('fixture ledger with known counts computes matching totals', () => {
  const gateEvents = [
    gateEvent({ tier: 'critical', action: 'block', reason: 'critical shared infrastructure with no pre-implementation review on record' }),
    gateEvent({ tier: 'critical', action: 'warn', reason: 'NO-PLAN-REVIEW bypass claimed — recorded for the digest' }),
    gateEvent({ tier: 'critical', action: 'warn', reason: 'blocked 2x already on this file — failing open so a headless session cannot spin' }),
    gateEvent({ tier: 'shared', action: 'warn' }),
    gateEvent({ tier: 'shared', action: 'warn' }),
  ];
  const planVerdicts = [
    planVerdict({ reviewer: 'plan-review' }),
    planVerdict({ reviewer: 'second-opinion' }),
    planVerdict({ reviewer: 'plan-review' }),
  ];

  const row = computeInfraReviewDigest({ gateEvents, planVerdicts, now: NOW });

  assert.equal(row.gatedEdits, 5);
  assert.equal(row.critical, 3);
  assert.equal(row.shared, 2);
  assert.equal(row.blocked, 1);
  assert.equal(row.bypassed, 1);
  assert.equal(row.failOpened, 1);
  assert.equal(row.coveredByVerdict, 3);
  assert.deepEqual(row.byReviewer, { 'plan-review': 2, 'second-opinion': 1 });
  assert.equal(row.status, 'pass');
  assert.equal(row.restructureEscalations, 0);
});

test('restructure-flag notes are counted, plain notes are not (task #1218)', () => {
  const planVerdicts = [
    planVerdict({ note: 'restructure-flag: adopted — shrank ramp from 5 shows to 2 by hand' }),
    planVerdict({ note: 'restructure-flag: dismissed — owner confirmed 5-show gate is fine here' }),
    planVerdict({ note: 'unrelated note about test.yml path additions' }),
    planVerdict({}),
  ];

  const row = computeInfraReviewDigest({ gateEvents: [], planVerdicts, now: NOW });

  assert.equal(row.coveredByVerdict, 4);
  assert.equal(row.restructureEscalations, 2);
});

test('bypasses exceeding real reviews flips severity to warn', () => {
  const gateEvents = [
    gateEvent({ tier: 'critical', action: 'warn', reason: 'NO-PLAN-REVIEW bypass claimed — recorded for the digest' }),
    gateEvent({ tier: 'critical', action: 'warn', reason: 'NO-PLAN-REVIEW bypass claimed — recorded for the digest' }),
  ];
  const planVerdicts = [planVerdict({ reviewer: 'plan-review' })];

  const row = computeInfraReviewDigest({ gateEvents, planVerdicts, now: NOW });

  assert.equal(row.bypassed, 2);
  assert.equal(row.coveredByVerdict, 1);
  assert.equal(row.status, 'warn');
  assert.match(row.message, /BYPASSES EXCEED REAL REVIEWS/);
  assert.ok(row.hint, 'a warn row should carry an actionable hint');
});

test('bypasses equal to real reviews does NOT flip severity (tie goes to pass)', () => {
  const gateEvents = [
    gateEvent({ action: 'warn', reason: 'NO-PLAN-REVIEW bypass claimed — recorded for the digest' }),
  ];
  const planVerdicts = [planVerdict()];

  const row = computeInfraReviewDigest({ gateEvents, planVerdicts, now: NOW });

  assert.equal(row.bypassed, 1);
  assert.equal(row.coveredByVerdict, 1);
  assert.equal(row.status, 'pass');
});

test('empty ledgers produce a pass row with no noise', () => {
  const row = computeInfraReviewDigest({ gateEvents: [], planVerdicts: [], now: NOW });
  assert.equal(row.status, 'pass');
  assert.equal(row.gatedEdits, 0);
  assert.equal(row.coveredByVerdict, 0);
  assert.match(row.message, /No shared-infra edits/);
});

test('entries outside the trailing window are excluded', () => {
  const gateEvents = [
    gateEvent({ ts: daysAgo(8), action: 'block', tier: 'critical' }),
    gateEvent({ ts: daysAgo(6.9), action: 'block', tier: 'critical' }),
  ];
  const planVerdicts = [
    planVerdict({ ts: daysAgo(30) }),
  ];

  const row = computeInfraReviewDigest({ gateEvents, planVerdicts, now: NOW, windowMs: WINDOW_MS });

  assert.equal(row.gatedEdits, 1);
  assert.equal(row.blocked, 1);
  assert.equal(row.coveredByVerdict, 0);
});

test('diff-phase verdicts (no phase field) are not counted as plan coverage', () => {
  const planVerdicts = [
    { ts: daysAgo(1), reviewer: 'ship-check', result: 'pass', branch: 'main', head: 'abc', diffHash: 'x' },
  ];
  const row = computeInfraReviewDigest({ gateEvents: [], planVerdicts, now: NOW });
  assert.equal(row.coveredByVerdict, 0);
});

test('a fail-result plan verdict does not count as coverage', () => {
  const planVerdicts = [planVerdict({ result: 'fail' })];
  const row = computeInfraReviewDigest({ gateEvents: [], planVerdicts, now: NOW });
  assert.equal(row.coveredByVerdict, 0);
});

// Coupling check: the bypassed/failOpened regexes in infra-review-digest.js
// hardcode prefixes of infra-review-scope.js's `reason` strings rather than
// importing them. This test generates REAL verdicts via the actual
// evaluateInfraReviewGate() so a future wording change there breaks this
// test loudly instead of leaving the digest's counts silently wrong
// (ship-check finding, task #1095).
test('bypassed/failOpened regexes match the real evaluateInfraReviewGate() reason strings', () => {
  const scope = require('../lib/infra-review-scope.js');
  const CRITICAL_PATH = 'scripts/lib/backlog-drain.js';

  const bypassVerdict = scope.evaluateInfraReviewGate({
    paths: [CRITICAL_PATH], verdicts: [], sessionId: 's1', now: NOW, priorBlocks: 0, bypass: true,
  });
  assert.equal(bypassVerdict.action, 'warn');
  const bypassRow = computeInfraReviewDigest({
    gateEvents: [gateEvent({ tier: bypassVerdict.tier, action: bypassVerdict.action, reason: bypassVerdict.reason })],
    planVerdicts: [], now: NOW,
  });
  assert.equal(bypassRow.bypassed, 1, `regex did not match real bypass reason: "${bypassVerdict.reason}"`);

  const failOpenVerdict = scope.evaluateInfraReviewGate({
    paths: [CRITICAL_PATH], verdicts: [], sessionId: 's1', now: NOW, priorBlocks: scope.MAX_BLOCKS_PER_FILE, bypass: false,
  });
  assert.equal(failOpenVerdict.action, 'warn');
  const failOpenRow = computeInfraReviewDigest({
    gateEvents: [gateEvent({ tier: failOpenVerdict.tier, action: failOpenVerdict.action, reason: failOpenVerdict.reason })],
    planVerdicts: [], now: NOW,
  });
  assert.equal(failOpenRow.failOpened, 1, `regex did not match real fail-open reason: "${failOpenVerdict.reason}"`);
});
