import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// require() the REAL functions — no reimplementation (CLAUDE.md §15).
const { tokenizeCheckCommand, cardCheckArgv } = require('../../scripts/lib/autonomous-checks.js');
const { isSafeCheckCommand, explainUnsafeCheckCommand } = require('../../scripts/lib/autonomous-triage-core.js');

// ── tokenizeCheckCommand ─────────────────────────────────────────────────

test('tokenizeCheckCommand: plain whitespace-separated command (unchanged from naive split)', () => {
  assert.deepEqual(tokenizeCheckCommand('npx tsc --noEmit'), ['npx', 'tsc', '--noEmit']);
  assert.deepEqual(
    tokenizeCheckCommand('node --test scripts/bsc-next.test.mjs'),
    ['node', '--test', 'scripts/bsc-next.test.mjs'],
  );
});

test('tokenizeCheckCommand: double-quoted value with spaces stays one token, quotes stripped', () => {
  assert.deepEqual(
    tokenizeCheckCommand('node scripts/check-workflow-run-status.js --workflow="Deploy to Vercel" --expect=success'),
    ['node', 'scripts/check-workflow-run-status.js', '--workflow=Deploy to Vercel', '--expect=success'],
  );
});

test('tokenizeCheckCommand: single-quoted value with spaces stays one token', () => {
  assert.deepEqual(
    tokenizeCheckCommand("node scripts/check-workflow-run-status.js --workflow='Test Suite' --branch=main --expect=success"),
    ['node', 'scripts/check-workflow-run-status.js', '--workflow=Test Suite', '--branch=main', '--expect=success'],
  );
});

test('tokenizeCheckCommand: naive whitespace split would have broken the quoted case (regression guard)', () => {
  const cmd = 'node scripts/check-workflow-run-status.js --workflow="Deploy to Vercel" --expect=success';
  const naive = cmd.split(/\s+/);
  const real = tokenizeCheckCommand(cmd);
  assert.notDeepEqual(naive, real, 'the whole point of this file: naive split and the real tokenizer must diverge on this input');
  assert.equal(naive.length, 6, 'naive split shatters the quoted value into 3 broken tokens');
  assert.equal(real.length, 4, 'the real tokenizer keeps the quoted value as one token');
});

test('tokenizeCheckCommand: empty/whitespace-only input yields no tokens', () => {
  assert.deepEqual(tokenizeCheckCommand(''), []);
  assert.deepEqual(tokenizeCheckCommand('   '), []);
  assert.deepEqual(tokenizeCheckCommand(null), []);
});

// ── isSafeCheckCommand: check-workflow-run-status.js form ───────────────────
// (ship-check/Codex finding: a bare `gh run list [flags]` form was tried
// first and reverted — gh run list exits 0 regardless of what it lists, so
// that shape could never be a real pass/fail check. check-workflow-run-
// status.js wraps it and asserts the conclusion itself.)

test('check-workflow-run-status.js: the two BRO-2208 card-authored intents, rephrased through the wrapper, pass the safe-form gate', () => {
  assert.equal(isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow="Deploy to Vercel" --expect=success'), true);
  assert.equal(
    isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow="Test Suite" --branch=main --expect=success'),
    true,
  );
});

test('check-workflow-run-status.js: bare .yml workflow name passes, --branch is optional', () => {
  assert.equal(isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow=data-health-check.yml --expect=success'), true);
});

test('check-workflow-run-status.js: --workflow and --expect are both required', () => {
  assert.equal(isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow=test.yml'), false);
  assert.equal(isSafeCheckCommand('node scripts/check-workflow-run-status.js --expect=success'), false);
});

test('check-workflow-run-status.js: unknown flag or shell metacharacters are refused', () => {
  assert.equal(isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow=test.yml --expect=success --delete-all'), false);
  assert.equal(isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow=test.yml --expect=success && rm -rf /'), false);
});

test('check-workflow-run-status.js: a bare gh run list is refused — not a real pass/fail check (Codex finding)', () => {
  assert.equal(isSafeCheckCommand('gh run list --workflow=test.yml --json conclusion'), false);
  assert.equal(isSafeCheckCommand('gh run cancel 12345'), false);
});

test('check-workflow-run-status.js: cardCheckArgv builds correct, safely-dequoted argv for execFileSync', () => {
  const argv = cardCheckArgv(
    'node scripts/check-workflow-run-status.js --workflow="Deploy to Vercel" --expect=success',
    isSafeCheckCommand,
  );
  assert.deepEqual(argv, ['node', 'scripts/check-workflow-run-status.js', '--workflow=Deploy to Vercel', '--expect=success']);
});

// ── Quote-hardening (ship-check/Codex findings) ─────────────────────────────

test('an unterminated quote is refused, not silently accepted as a bare token', () => {
  // Naively, `[^\s]+` would match `"Deploy` (no internal whitespace) once the
  // quoted alternative fails to find a closing quote — accepting a malformed
  // command AND tokenizing it differently than the matched shape implies.
  assert.equal(
    isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow="Deploy --expect=success'),
    false,
  );
});

test('a value containing a backslash is refused — the tokenizer has no escape semantics', () => {
  assert.equal(
    isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow=test.yml --expect="a\\"b"'),
    false,
  );
});

// ── isSafeCheckCommand: extract-show-score-reviews.js --check ──────────────

test('extract-show-score-reviews.js: --check form passes, bare (mutating) form still refused', () => {
  assert.equal(isSafeCheckCommand('node scripts/extract-show-score-reviews.js --check'), true);
  assert.equal(isSafeCheckCommand('node scripts/extract-show-score-reviews.js'), false);
  assert.equal(isSafeCheckCommand('node scripts/extract-show-score-reviews.js --check --force'), false);
});
