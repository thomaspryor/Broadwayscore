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
    tokenizeCheckCommand('gh run list --workflow="Deploy to Vercel" --limit 5 --json status,conclusion'),
    ['gh', 'run', 'list', '--workflow=Deploy to Vercel', '--limit', '5', '--json', 'status,conclusion'],
  );
});

test('tokenizeCheckCommand: single-quoted value with spaces and brackets stays one token', () => {
  assert.deepEqual(
    tokenizeCheckCommand("gh run list --workflow=\"Test Suite\" --branch=main --limit=1 --json conclusion --jq '.[0].conclusion'"),
    ['gh', 'run', 'list', '--workflow=Test Suite', '--branch=main', '--limit=1', '--json', 'conclusion', '--jq', '.[0].conclusion'],
  );
});

test('tokenizeCheckCommand: naive whitespace split would have broken the quoted case (regression guard)', () => {
  const cmd = 'gh run list --workflow="Deploy to Vercel" --limit 5';
  const naive = cmd.split(/\s+/);
  const real = tokenizeCheckCommand(cmd);
  assert.notDeepEqual(naive, real, 'the whole point of this file: naive split and the real tokenizer must diverge on this input');
  assert.equal(naive.length, 8, 'naive split shatters the quoted value into 4 broken tokens');
  assert.equal(real.length, 6, 'the real tokenizer keeps the quoted value as one token');
});

test('tokenizeCheckCommand: empty/whitespace-only input yields no tokens', () => {
  assert.deepEqual(tokenizeCheckCommand(''), []);
  assert.deepEqual(tokenizeCheckCommand('   '), []);
  assert.deepEqual(tokenizeCheckCommand(null), []);
});

// ── isSafeCheckCommand: gh run list form ────────────────────────────────────

test('gh run list: both card-authored example commands from BRO-2208 pass the safe-form gate', () => {
  assert.equal(isSafeCheckCommand('gh run list --workflow="Deploy to Vercel" --limit 5 --json status,conclusion'), true);
  assert.equal(
    isSafeCheckCommand("gh run list --workflow=\"Test Suite\" --branch=main --limit=1 --json conclusion --jq '.[0].conclusion'"),
    true,
  );
});

test('gh run list: bare .yml workflow name and jq filter (common backlog shape) passes', () => {
  assert.equal(
    isSafeCheckCommand("gh run list --workflow=data-health-check.yml --limit 1 --json conclusion --jq '.[0].conclusion'"),
    true,
  );
});

test('gh run list: unknown flag is refused', () => {
  const result = explainUnsafeCheckCommand('gh run list --workflow=test.yml --delete-all');
  assert.equal(result.ok, false);
});

test('gh run list: a different gh subcommand is refused (shape gate is run-list-specific)', () => {
  assert.equal(isSafeCheckCommand('gh run cancel 12345'), false);
  assert.equal(isSafeCheckCommand('gh workflow run deploy.yml'), false);
  assert.equal(isSafeCheckCommand('gh run list --workflow=test.yml && rm -rf /'), false);
});

test('gh run list: cardCheckArgv builds correct, safely-dequoted argv for execFileSync', () => {
  const argv = cardCheckArgv(
    'gh run list --workflow="Deploy to Vercel" --limit 5 --json status,conclusion',
    isSafeCheckCommand,
  );
  assert.deepEqual(argv, ['gh', 'run', 'list', '--workflow=Deploy to Vercel', '--limit', '5', '--json', 'status,conclusion']);
});

// ── isSafeCheckCommand: extract-show-score-reviews.js --check ──────────────

test('extract-show-score-reviews.js: --check form passes, bare (mutating) form still refused', () => {
  assert.equal(isSafeCheckCommand('node scripts/extract-show-score-reviews.js --check'), true);
  assert.equal(isSafeCheckCommand('node scripts/extract-show-score-reviews.js'), false);
  assert.equal(isSafeCheckCommand('node scripts/extract-show-score-reviews.js --check --force'), false);
});
