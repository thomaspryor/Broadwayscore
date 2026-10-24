// BRO-6134 VERIFY: reads the real outside signals and passes only when no Codex lane:class is
// confirmed breached on two consecutive hourly checks. Read-only (no --alert).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('no Codex lane breach is confirmed', () => {
  const r = spawnSync('node', ['scripts/codex-lane-alarm.js', '--strict'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
