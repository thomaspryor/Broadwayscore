import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateInfraReviewGate, classifyChange } = require('../../scripts/lib/infra-review-scope.js');

// BRO-126 (owner mandate, formerly task #672): "no review gate fires BEFORE
// implementation — every hook catches sessions at Stop/push, after the code
// exists." A first attempt (2026-07-30) put a prose instruction in
// scripts/bsc-next.js's buildSeed() telling a DISPATCHED session to review
// itself before implementing. It was reverted the same day for 4 defects: no
// verifiable evidence a review happened, a proposed fallback metric that was
// verified broken, an unreviewed blanket permission clause, and — most
// relevant to what this file checks — a coverage hole: it only reached
// sessions dispatched via bsc-next.js, missing interactively-watched ones.
//
// Task #1079 (2026-08-05) independently shipped the real fix and cites this
// same mandate in its own header (~/.claude/hooks/infra-plan-review-gate.sh):
// a PreToolUse hook, registered in the user's GLOBAL settings.json for
// Edit|Write|MultiEdit|NotebookEdit|Bash, so it fires for every session on the
// machine — not something bsc-next.js's seed text has to inject. This file
// proves that mechanism actually satisfies the mandate's two load-bearing
// claims, using the real decision function (CLAUDE.md rule 15 — require(),
// never reimplement). It is deliberately narrower than
// scripts/tests/infra-review-gate.test.mjs (which already exhaustively covers
// block/unblock/TTL/warn-tier/bypass at the unit level) — these tests check
// the CARD-LEVEL claims only.

test('a critical-infra edit is blocked with nothing but an intended path — no diff, no commit, no repo I/O', () => {
  // No mkdtempSync, no git init, no filesystem write anywhere in this test.
  // The push-time gate (queryPushAllowed in review-gate.mjs) fundamentally
  // needs a real diff to hash — it cannot answer before code exists. This
  // gate answers from the intended path alone, which is what "fires BEFORE
  // implementation" has to mean structurally, not just rhetorically.
  const result = evaluateInfraReviewGate({
    paths: ['scripts/bsc-next.js'],
    verdicts: [],
    sessionId: 'session-a',
    now: 1_000_000,
  });
  assert.equal(result.action, 'block');
  assert.equal(result.tier, 'critical');
});

test('coverage does not distinguish how the session was started — two unrelated sessionIds get identical treatment', () => {
  // The reverted design's coverage hole was literally "only fires for
  // sessions dispatched via bsc-next.js". evaluateInfraReviewGate's inputs
  // (paths/verdicts/sessionId/now/priorBlocks/bypass/repoRoot) carry no
  // concept of dispatch origin at all — there is no field to special-case a
  // dispatched session out of the block. Proven behaviourally: two sessions
  // with nothing in common but their id get the same block, and the same
  // unblock once each records its own verdict.
  const paths = ['scripts/lib/backlog-drain.js'];
  const dispatched = evaluateInfraReviewGate({ paths, verdicts: [], sessionId: 'dispatched-session', now: 1_000_000 });
  const interactive = evaluateInfraReviewGate({ paths, verdicts: [], sessionId: 'interactive-session', now: 1_000_000 });
  assert.equal(dispatched.action, 'block');
  assert.equal(interactive.action, 'block');

  const verdictFor = (sessionId) => ([{
    phase: 'plan', reviewer: 'plan-review', result: 'pass', sessionId, ts: new Date(1_000_000).toISOString(),
  }]);
  const dispatchedCovered = evaluateInfraReviewGate({ paths, verdicts: verdictFor('dispatched-session'), sessionId: 'dispatched-session', now: 1_000_000 });
  const interactiveCovered = evaluateInfraReviewGate({ paths, verdicts: verdictFor('interactive-session'), sessionId: 'interactive-session', now: 1_000_000 });
  assert.equal(dispatchedCovered.action, 'allow');
  assert.equal(interactiveCovered.action, 'allow');

  // Cross-check: dispatched's verdict must not leak into interactive's
  // session, or "coverage" would be an illusion of per-session isolation.
  const crossCheck = evaluateInfraReviewGate({ paths, verdicts: verdictFor('dispatched-session'), sessionId: 'interactive-session', now: 1_000_000 });
  assert.equal(crossCheck.action, 'block');
});

test('the gate is satisfiable, not a permanent wedge — a recorded pass verdict unblocks the identical edit', () => {
  const paths = ['scripts/bsc-conductor.js'];
  const before = evaluateInfraReviewGate({ paths, verdicts: [], sessionId: 'session-b', now: 2_000_000 });
  assert.equal(before.action, 'block');

  const verdicts = [{
    phase: 'plan', reviewer: 'second-opinion', result: 'pass', sessionId: 'session-b',
    ts: new Date(2_000_000).toISOString(),
  }];
  const after = evaluateInfraReviewGate({ paths, verdicts, sessionId: 'session-b', now: 2_000_000 });
  assert.equal(after.action, 'allow');
});

test('classifyChange agrees the dispatch layer is in the critical tier this gate blocks on', () => {
  const { inScope, tier } = classifyChange(['scripts/bsc-next.js'], {});
  assert.equal(inScope, true);
  assert.equal(tier, 'critical');
});
