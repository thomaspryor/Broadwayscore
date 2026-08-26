// Repo-side coverage for the board commit gate's fail-open classifier (S4-T3b).
//
// The behaviour itself is asserted by ~/.claude/hooks/tests/board-gate-failopen/run.sh
// (28 assertions). That suite only ever runs from claude-sync, when a staged
// change touches hooks/ — so nothing in THIS repo notices when the gate that
// governs its own commits regresses. This wrapper closes that gap and gives the
// card a safe-form acceptance command (`node --test` is the only shape the
// done-gate's allowlist accepts; a bash suite cannot qualify).
//
// The hooks live in ~/.claude, a separate repo that is not checked out on CI
// runners. When it is absent this reports SKIPPED LOUDLY rather than passing
// green — a permanently-silent skip is what put 4 of pre-push-visual-gate's 8
// tests to sleep on a deleted fixture (BRO-2312), and this file should not
// repeat it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SUITE = path.join(homedir(), '.claude/hooks/tests/board-gate-failopen/run.sh');
const HOOK = path.join(homedir(), '.claude/hooks/notion-card-required-commit.sh');

test('board gate fail-open suite passes', (t) => {
  if (!existsSync(SUITE)) {
    // Not silent: the reason is printed, so an unexpected skip is visible.
    console.warn(`SKIP: ${SUITE} not present (expected on CI — ~/.claude is a separate repo)`);
    t.skip('hook suite not present on this machine');
    return;
  }

  let out;
  try {
    out = execFileSync('bash', [SUITE], { encoding: 'utf8', timeout: 120_000 });
  } catch (err) {
    // Surface the suite's own output — a bare "exit 1" is not actionable.
    assert.fail(`board-gate-failopen suite failed:\n${err.stdout || ''}${err.stderr || ''}`);
  }

  assert.match(out, /\d+ passed, 0 failed/, `suite did not report a clean run:\n${out}`);
});

test('the gate hook classifies rather than collapsing every failure', (t) => {
  if (!existsSync(HOOK)) {
    console.warn(`SKIP: ${HOOK} not present (expected on CI)`);
    t.skip('hook not present on this machine');
    return;
  }

  const src = execFileSync('cat', [HOOK], { encoding: 'utf8' });

  // The three branches are the whole point of the task: before it, every
  // non-zero exit failed open wearing the same "unreachable" text, so a
  // permanently broken probe was indistinguishable from a passing blip.
  assert.match(src, /4\|124\|142\)\s*verdict=unreachable/, 'timeout/unreachable branch missing');
  assert.match(src, /1\|2\|3\)\s*verdict=erroring/, 'erroring branch missing');
  assert.match(src, /verdict=broken/, 'broken branch missing');
  assert.match(src, /board-gate-failopen\.log/, 'fail-open logging missing');

  // rc must be captured on its own line. `if ! cmd` loses the distinction
  // between exit codes entirely, which is what made the old gate unable to say
  // which failure it had hit.
  assert.match(src, /\nrc=\$\?/, 'rc is not captured immediately after the probe');
});
