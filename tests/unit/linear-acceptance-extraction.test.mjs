// BRO-3155 — the dispatch gate (scripts/linear-next.js, via
// verify-gate.js's evaluateVerifiability) only ever reads a Linear issue's
// DESCRIPTION for an "## Acceptance criteria" section / "VERIFY: <cmd>"
// line. linear-brain.js's `update` command has no description-edit path
// (--state/--comment only), so the only way to correct a broken/malformed
// acceptance command after filing is a comment — and before this fix, a
// comment fixup silently did nothing at either gate: linear-next.js's
// dispatch gate refused with the same error, quoting the original
// description's candidate verbatim, and linear-brain.js's Done gate
// (done-semantics-gate.js) pooled description+comment candidates into one
// string and re-ranked them by specificity rather than recency, so a
// comment-fixed card could dispatch but could never close.
//
// Per CLAUDE.md rule 15, these are NOT copies of the decision logic: both
// evaluateVerifiability (the dispatch gate's own predicate) and
// checkLinearDoneTransition (the Done gate's entry point, wired into
// scripts/linear-brain.js and scripts/linear-session.js) are require()'d
// from their real production modules.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateVerifiability } = require('../../scripts/lib/verify-gate.js');
const { checkLinearDoneTransition } = require('../../scripts/lib/linear-done-gate.js');

// Mirrors the real incident (BRO-3153, opening-night monitor 2026-09-09):
// an "## Acceptance criteria" section whose command is prose-wrapped script
// invocation that never matches any SAFE_CHECK_FORMS shape — not a form
// this module accepts, but also not "no command at all" (extractVerifyCmd
// finds a candidate and rejects it on safe-form grounds), same failure
// shape as the original card.
const MALFORMED_DESCRIPTION =
  '## Problem\nGap triage prints in-pipeline output with no persisted artifact.\n\n' +
  '## Acceptance criteria\nRun the triage script: `node scripts/triage-review-gap.js --show=X` and confirm it prints.';

const VALID_DESCRIPTION =
  '## Acceptance criteria\n- `node --test tests/unit/some-fixture.test.mjs` passes';

describe('evaluateVerifiability (verify-gate.js) — comment precedence, BRO-3155', () => {
  test('(1) description-only valid command -> used', () => {
    const r = evaluateVerifiability(VALID_DESCRIPTION);
    assert.equal(r.armed, true);
    assert.equal(r.cmd, 'node --test tests/unit/some-fixture.test.mjs');
  });

  test('(2) description malformed + newest comment carries a valid bare command -> comment wins', () => {
    // "bare" per BRO-2585: no backticks, just the VERIFY: line's own
    // remainder — a form this repo's cards are routinely written in and
    // that extractVerifyCmd accepts without requiring a backticked span.
    const comments = ['VERIFY: node --test tests/unit/some-fixture.test.mjs'];
    const r = evaluateVerifiability(MALFORMED_DESCRIPTION, comments);
    assert.equal(r.armed, true);
    assert.equal(r.cmd, 'node --test tests/unit/some-fixture.test.mjs');

    // Sanity check: the description ALONE (no comment) still refuses —
    // proves the comment is what armed it, not some latent leniency in the
    // malformed fixture itself.
    const withoutComment = evaluateVerifiability(MALFORMED_DESCRIPTION);
    assert.equal(withoutComment.armed, false);
  });

  test('(3) two comments, newest valid -> newest wins', () => {
    // Both comments are individually valid but name DIFFERENT commands —
    // proves the winner is genuinely the newest one, not just "the first
    // comment that happens to arm" (which the first-comment-broken case
    // above cannot distinguish from true recency preference).
    const comments = [
      'VERIFY: node --test tests/unit/some-fixture.test.mjs',
      'VERIFY: node --test tests/unit/another-fixture.test.mjs',
    ];
    const r = evaluateVerifiability(MALFORMED_DESCRIPTION, comments);
    assert.equal(r.armed, true);
    assert.equal(r.cmd, 'node --test tests/unit/another-fixture.test.mjs');
  });

  test('(4) nothing valid anywhere -> still refuses', () => {
    const comments = ['Started work.', 'VERIFY: node scripts/triage-review-gap.js --show=X --still-broken'];
    const r = evaluateVerifiability(MALFORMED_DESCRIPTION, comments);
    assert.equal(r.armed, false);
    assert.equal(r.cmd, null);
  });
});

// ── The Done gate must apply the SAME precedence (ticket's explicit ask) ──

function makeIssue(description, commentBodies) {
  return {
    description,
    comments: { nodes: commentBodies.map((body, i) => ({ id: `c${i}`, body, createdAt: `2026-09-0${i + 1}T00:00:00.000Z` })) },
  };
}

describe('checkLinearDoneTransition (linear-done-gate.js) — same precedence as dispatch, BRO-3155', () => {
  test('a comment-corrected acceptance command that would dispatch now also closes', () => {
    const issue = makeIssue(MALFORMED_DESCRIPTION, ['VERIFY: node --test tests/unit/some-fixture.test.mjs']);
    const existingComments = issue.comments.nodes.map((c) => c.body); // already oldest-first here
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed',
      description: issue.description,
      existingComments,
    });
    assert.equal(gate.gated, true);
    assert.equal(gate.allowed, true, gate.reason);
    assert.equal(gate.verdict, 'verify-cmd-recorded');
    assert.equal(gate.cmd, 'node --test tests/unit/some-fixture.test.mjs');
  });

  test('without the comment, the same malformed description still refuses', () => {
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed',
      description: MALFORMED_DESCRIPTION,
      existingComments: [],
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.verdict, 'no-done-evidence');
  });

  test('two valid comments -> the newest command is the one recorded as evidence, not the oldest', () => {
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed',
      description: MALFORMED_DESCRIPTION,
      existingComments: [
        'VERIFY: node --test tests/unit/some-fixture.test.mjs',
        'VERIFY: node --test tests/unit/another-fixture.test.mjs',
      ],
    });
    assert.equal(gate.allowed, true, gate.reason);
    assert.equal(gate.cmd, 'node --test tests/unit/another-fixture.test.mjs');
  });
});
