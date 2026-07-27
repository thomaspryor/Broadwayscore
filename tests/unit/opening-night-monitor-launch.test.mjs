import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldAdoptLateStart } = require('../../scripts/opening-night-monitor-launch.js');

// Card #567: the fix replaced a bare claudeAliveIn(ref) call (single-signal,
// same registry-desync false-negative as #559/#564) with
// cmuxws.computeClaudeAlive(meta), which requires the independent
// terminal-surface signal to ALSO agree "dead" (checkLiveness, card
// #559/#564) before reporting the locked session not-alive. The lib-level
// tests in scripts/lib/cmux-workspaces.test.mjs and
// scripts/lib/opening-night-windows.test.mjs prove computeClaudeAlive's
// logic is correct in isolation, but main()'s call to cmuxws.computeClaudeAlive
// isn't independently exercised elsewhere — main() reads MON_DIR/monitor.lock
// from the real repo path, so a full in-process integration test would have
// to mutate real on-disk state to drive it. This source-level guard is the
// cheap alternative: it fails if the call site ever regresses back to a bare
// claudeAliveIn(...) — the exact silent-revert this class of bug keeps
// recurring as (a different call site each time: #559 pruneDone, #564
// checkDeadDispatch, #567 here).
test('claudeAlive computation calls computeClaudeAlive, not a bare claudeAliveIn', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const claudeAliveLine = src.split('\n').find(l => l.includes('claudeAlive:'));
  assert.ok(claudeAliveLine, 'expected a `claudeAlive:` field in the state object literal');
  assert.match(claudeAliveLine, /cmuxws\.computeClaudeAlive\(/, 'claudeAlive must go through computeClaudeAlive (both liveness signals), not claudeAliveIn alone');
  assert.doesNotMatch(claudeAliveLine, /\bclaudeAliveIn\(/, 'claudeAlive must not call claudeAliveIn directly — that is the single-signal false-negative this card fixed');
});

// Regression for the 2026-07-24 false CRITICAL: a Fable session that comes
// alive AFTER launchCmuxSession's verify window is healthy, not failed — the
// launcher must adopt it (and NOT page + relaunch a duplicate).
test('adopts a failed launch whose workspace is actually alive', () => {
  const result = { ok: false, workspaceRef: 'workspace:272', reason: 'no running claude ... after 2 attempts' };
  assert.equal(shouldAdoptLateStart(result, true), true);
});

test('does NOT adopt when the workspace never comes alive', () => {
  const result = { ok: false, workspaceRef: 'workspace:272', reason: 'no running claude ... after 2 attempts' };
  assert.equal(shouldAdoptLateStart(result, false), false);
});

test('does NOT adopt when there is no workspace to adopt', () => {
  const result = { ok: false, reason: 'cmux CLI not found' };
  assert.equal(shouldAdoptLateStart(result, true), false);
});

test('a genuine success is not an adoption case', () => {
  const result = { ok: true, ref: 'workspace:272' };
  assert.equal(shouldAdoptLateStart(result, true), false);
});
