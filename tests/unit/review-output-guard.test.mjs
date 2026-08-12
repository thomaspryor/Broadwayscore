// Task #1081 (Notion 3b4637c5): codex exec exited 0 with ZERO bytes of output
// twice on 2026-08-05, and /ship-check's awk marker filter turned that into a
// silent empty string indistinguishable from "reviewer ran, found nothing."
// isUsableReviewOutput() is the gate that must catch that — asserts the exact
// 0-byte case plus the near-miss shapes (whitespace-only, marker-chrome-only)
// that would otherwise slip through a naive `text.length > 0` check.
//
// TESTS-VS-DERIVED-DATA-EXEMPT: filenames like shows.json/reviews.json below
// are string fixtures reproducing real Codex CLI transcripts (task #1320),
// not reads of derived data — this is a pure regex/string classifier test.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isUsableReviewOutput, checkReviewOutput } = require('../../scripts/lib/review-output-guard.js');

describe('isUsableReviewOutput', () => {
  test('rejects the empty string (the observed 0-byte codex exec case)', () => {
    assert.equal(isUsableReviewOutput(''), false);
  });

  test('rejects whitespace-only output', () => {
    assert.equal(isUsableReviewOutput('   \n\t\n  '), false);
  });

  test('rejects marker-only output (awk chrome with no assistant reply)', () => {
    // Reproduces the raw codex exec transcript shape: the awk filter's flag
    // window opened on "codex" and closed on "tokens used" with nothing of
    // substance emitted between them.
    assert.equal(isUsableReviewOutput('codex\ntokens used'), false);
  });

  test('rejects marker-only output mixed with hook log lines', () => {
    assert.equal(
      isUsableReviewOutput('codex\nhook: Stop\nhook: Stop Completed\ntokens used'),
      false,
    );
  });

  test('rejects non-string input (null/undefined)', () => {
    assert.equal(isUsableReviewOutput(null), false);
    assert.equal(isUsableReviewOutput(undefined), false);
  });

  test('accepts genuine review text', () => {
    const real = [
      '**CHALLENGE THE DESIGN:**',
      '1. src/lib/scoring.ts:42 — this assumes reviews are pre-sorted; they are not.',
      '2. No rollback path if the migration half-completes.',
    ].join('\n');
    assert.equal(isUsableReviewOutput(real), true);
  });

  test('accepts genuine review text even alongside hook log lines', () => {
    const real = 'hook: Stop\nFound a real P0 at scripts/foo.js:12.\ntokens used';
    assert.equal(isUsableReviewOutput(real), true);
  });

  test('accepts short but substantive single-line output', () => {
    assert.equal(isUsableReviewOutput('No issues found.'), true);
  });

  test('rejects the exact refusal observed live 2026-08-12 (task #1320)', () => {
    const refusal = [
      'Blocked by required data preflight: `npm run data:check` reports missing',
      'core data files and its auto-fix failed. Per repo instructions, I must',
      'stop rather than review without data.',
    ].join('\n');
    assert.equal(isUsableReviewOutput(refusal), false);
    const result = checkReviewOutput(refusal);
    assert.equal(result.usable, false);
    assert.equal(result.kind, 'refused');
    assert.match(result.reason, /^refused:/);
  });

  test('accepts genuine review text with path:line citations even when it uses refusal-adjacent wording', () => {
    const real = [
      '1. src/lib/scoring.ts:42 — this assumes reviews are pre-sorted; they are not.',
      '2. This change should be blocked by CI until the migration test passes.',
    ].join('\n');
    assert.equal(isUsableReviewOutput(real), true);
    assert.equal(checkReviewOutput(real).kind, 'ok');
  });

  test('known tradeoff: a refusal that happens to cite a path:line is still treated as usable (positive signal wins)', () => {
    const refusalWithCitation = 'Blocked by required data preflight: data/shows.json:1 is missing. Per repo instructions, I must stop rather than review without data.';
    assert.equal(isUsableReviewOutput(refusalWithCitation), true);
  });

  test('checkReviewOutput reports a distinct kind per rejection reason', () => {
    assert.equal(checkReviewOutput('').kind, 'empty');
    assert.equal(checkReviewOutput(null).kind, 'non-string');
    assert.equal(checkReviewOutput('codex\ntokens used').kind, 'marker');
    assert.equal(checkReviewOutput('No issues found.').kind, 'ok');
  });

  test('rejects a SECOND live refusal (reproduced while testing this fix, 2026-08-12) with different wording, preceded by long tool-output noise', () => {
    const refusal = [
      "I'll inspect the real guard, its callers, and existing tests before producing an adversarial findings-only review.",
      'exec',
      "/bin/zsh -lc 'npm run data:check' in /Users/tompryor/Broadwayscore/.claude/worktrees/1320-review-refusal-guard",
      ' exited 1 in 6009ms:',
      '',
      '> broadway-scorecard@0.1.0 data:check',
      '> node scripts/check-data-health.js --fix',
      '',
      'Attempting to pull core data from private repo...',
      '=== Broadway Scorecard Local Data Setup ===',
      '',
      'Using token (REVIEW_TEXTS_TOKEN/GH_TOKEN) for authentication...',
      '',
      '--- Core Data (from broadway-scorecard-data) ---',
      'Updating existing core-data clone at /Users/tompryor/broadway-scorecard-data...',
      'ERROR: Failed to update existing /Users/tompryor/broadway-scorecard-data — delete it and re-run.',
      'Auto-fix failed: Command failed: bash "/Users/tompryor/Broadwayscore/.claude/worktrees/1320-review-refusal-guard/scripts/setup-local-data.sh"',
      '❌ MISSING: shows.json, reviews.json, grosses.json, grosses-history.json, commercial.json, audience-buzz.json, critic-consensus.json, critic-registry.json',
      '  Fix: ./scripts/setup-local-data.sh  (or: node scripts/check-data-health.js --fix)',
      '',
      '- Blocked: `npm run data:check` failed because core data files are missing (`shows.json`, `reviews.json`, and others). Repository instructions require stopping rather than reviewing without data. I can\'t provide the requested actual-file, path:line-backed pre-ship findings until the data preflight succeeds.',
    ].join('\n');
    const result = checkReviewOutput(refusal);
    assert.equal(result.usable, false);
    assert.equal(result.kind, 'refused');
  });

  test('an IP:port mention does not count as a path:line citation (gpt-5.4-mini ship-check catch)', () => {
    const refusal = [
      'Blocked: `npm run data:check` failed because core data files are missing.',
      'The dev server that would have been used for context was at 127.0.0.1:3456.',
      'Repository instructions require stopping rather than reviewing without data.',
    ].join('\n');
    const result = checkReviewOutput(refusal);
    assert.equal(result.usable, false);
    assert.equal(result.kind, 'refused');
  });
});
