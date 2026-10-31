// BRO-5306: classifyPushStderr's permission-denied class. A 403 because the
// token lacks contents: write is deterministic, so push-with-retry.sh must
// stop at once instead of burning every retry plus the Git Data API fallback.
// Uses the real function (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyPushStderr } = require('../../scripts/lib/push-diagnostics.js');

// Verbatim shape of runs 38438033645 / 38438037005 (step "Commit alert state").
const REAL_2026_10_13 = [
  'remote: Permission to thomaspryor/Broadwayscore.git denied to github-actions[bot].',
  "fatal: unable to access 'https://github.com/thomaspryor/Broadwayscore/': The requested URL returned error: 403",
  '',
].join('\n');

test('real 2026-10-13 stderr is permission-denied', () => {
  assert.equal(classifyPushStderr(REAL_2026_10_13), 'permission-denied');
});

test('permission-denied wins even with progress lines or a trailing failed-to-push', () => {
  const err = `Enumerating objects: 5, done.\n${REAL_2026_10_13}error: failed to push some refs to x\n`;
  assert.equal(classifyPushStderr(err), 'permission-denied');
});

test('fine-grained token wording is permission-denied too', () => {
  const err = "remote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403\n";
  assert.equal(classifyPushStderr(err), 'permission-denied');
});

test('a plain rate-limit 403 stays race-or-other', () => {
  for (const err of [
    "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403",
    "remote: API rate limit exceeded for installation.\nfatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403",
    // Belt and braces: rate-limit wording keeps it retryable even alongside a refusal line.
    `remote: You have exceeded a secondary rate limit.\n${REAL_2026_10_13}`,
  ]) {
    assert.equal(classifyPushStderr(err), 'race-or-other', err);
  }
});

test('refusal line without the 403 (or vice versa) is not permission-denied', () => {
  assert.equal(classifyPushStderr('remote: Permission to o/r.git denied to someone.\nfatal: x'), 'race-or-other');
  assert.equal(classifyPushStderr('error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403'), 'race-or-other');
});

test('genuine race scenarios are unchanged (race-or-other)', () => {
  for (const marker of [
    ' ! [rejected]        main -> main (fetch first)',
    ' ! [rejected]        main -> main (non-fast-forward)',
    ' ! [remote rejected] main -> main (cannot lock ref)',
    'hint: Updates were rejected because the remote contains work',
    'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500\nfatal: the remote end hung up unexpectedly',
  ]) {
    assert.equal(classifyPushStderr(`${marker}\nerror: failed to push some refs to x`), 'race-or-other', marker);
  }
  assert.equal(classifyPushStderr(''), 'race-or-other');
});

test('local hook rejection is unchanged (hook-rejected)', () => {
  const err = '=== PRE-PUSH BLOCKED: help-flag guard ===\nerror: failed to push some refs to x\n';
  assert.equal(classifyPushStderr(err), 'hook-rejected');
});
