import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldAdoptLateStart } = require('../../scripts/opening-night-monitor-launch.js');

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
