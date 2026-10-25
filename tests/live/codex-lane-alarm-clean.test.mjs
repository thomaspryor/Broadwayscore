// BRO-6134 VERIFY: reads the real outside signals and passes only when no Codex lane:class is
// confirmed breached on two consecutive hourly checks. Read-only (no --alert).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const CHECKABLE_FROM = Date.parse('2026-10-26T00:00:00Z');

test('no Codex lane breach is confirmed', { skip: Date.now() < CHECKABLE_FROM && 'not checkable before the RECHECK-AFTER date' }, () => {
  const r = spawnSync('node', ['scripts/codex-lane-alarm.js', '--strict', '--unknown-ok'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
