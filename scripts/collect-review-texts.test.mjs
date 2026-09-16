// BRO-2381: scripts/audit-workflow-secret-gaps.js (task #1855) found that
// several workflows invoke collect-review-texts.js in a step whose env never
// provides REVIEW_TEXTS_TOKEN. pushReviewTextsCheckpoint() gated on that
// token (and GITHUB_ACTIONS) with a bare `return` and no logging, so the
// mid-run private-repo checkpoint silently no-op'd for the whole run with
// nothing in the job log to show it — see scripts/lib/review-texts-
// checkpoint-gate.js for the extracted decision function this requires
// (CLAUDE.md rule 15: require() the real function, don't reimplement it
// here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldPushReviewTextsCheckpoint } = require('./lib/review-texts-checkpoint-gate.js');
const { pushReviewTextsCheckpoint } = require('./collect-review-texts.js');

test('shouldPushReviewTextsCheckpoint: ok only when both REVIEW_TEXTS_TOKEN and GITHUB_ACTIONS are set', () => {
  assert.deepEqual(
    shouldPushReviewTextsCheckpoint({ REVIEW_TEXTS_TOKEN: 'ghs_abc', GITHUB_ACTIONS: 'true' }),
    { ok: true, reason: null }
  );
});

test('shouldPushReviewTextsCheckpoint: no-ops with a reason when REVIEW_TEXTS_TOKEN is missing', () => {
  const result = shouldPushReviewTextsCheckpoint({ GITHUB_ACTIONS: 'true' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /REVIEW_TEXTS_TOKEN/);
});

test('shouldPushReviewTextsCheckpoint: no-ops with a reason when GITHUB_ACTIONS is missing (local dev)', () => {
  const result = shouldPushReviewTextsCheckpoint({ REVIEW_TEXTS_TOKEN: 'ghs_abc' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /GitHub Actions/);
});

test('shouldPushReviewTextsCheckpoint: no-ops with a reason when both are missing', () => {
  const result = shouldPushReviewTextsCheckpoint({});
  assert.equal(result.ok, false);
  assert.match(result.reason, /REVIEW_TEXTS_TOKEN/);
  assert.match(result.reason, /GitHub Actions/);
});

// Integration-level: pushReviewTextsCheckpoint() itself must consult the
// same gate rather than re-deriving the condition inline (the original bug
// was exactly this kind of drift becoming silent). Exercised against
// process.env directly since that's the real call site's contract; every
// case restores the original env afterward.
function withEnv(overrides, fn) {
  const original = { REVIEW_TEXTS_TOKEN: process.env.REVIEW_TEXTS_TOKEN, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('pushReviewTextsCheckpoint: no-ops and logs why when REVIEW_TEXTS_TOKEN is missing', () => {
  const lines = withEnv({ REVIEW_TEXTS_TOKEN: undefined, GITHUB_ACTIONS: 'true' }, () =>
    captureLogs(() => pushReviewTextsCheckpoint(42))
  );
  assert.ok(
    lines.some((l) => l.includes('Skipping review-texts checkpoint push') && l.includes('REVIEW_TEXTS_TOKEN')),
    `expected a visible skip reason, got: ${JSON.stringify(lines)}`
  );
});

test('pushReviewTextsCheckpoint: no-ops silently-safe (does not throw) when not in CI', () => {
  withEnv({ REVIEW_TEXTS_TOKEN: undefined, GITHUB_ACTIONS: undefined }, () => {
    assert.doesNotThrow(() => pushReviewTextsCheckpoint(0));
  });
});

test('pushReviewTextsCheckpoint: passes the gate (does not early-return on the token check) when both env vars are set', () => {
  // With both set, the function proceeds past the gate to the private-repo
  // checkout check — which fails safe with its own distinct log line when
  // data/review-texts/.git isn't present (true both in local dev and in this
  // test's environment). The point under test is that it does NOT emit the
  // "Skipping review-texts checkpoint push" gate message in this case — that
  // would mean the gate is still blocking a run that should be allowed through.
  const lines = withEnv({ REVIEW_TEXTS_TOKEN: 'ghs_abc', GITHUB_ACTIONS: 'true' }, () =>
    captureLogs(() => pushReviewTextsCheckpoint(1))
  );
  assert.ok(
    !lines.some((l) => l.includes('Skipping review-texts checkpoint push')),
    `gate should not have blocked this call, got: ${JSON.stringify(lines)}`
  );
});
