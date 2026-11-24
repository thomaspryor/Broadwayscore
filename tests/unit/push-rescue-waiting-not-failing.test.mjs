// BRO-8244 class guard: a rescue branch waiting for a person must NOT fail the hourly replay run.
// Failing it made check-cron-health read "no success in 13h" => "Cron stale: Replay Push Rescue" card
// (BRO-6859, BRO-7493, BRO-8063). Waiting is reported through the notify step instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { waitingForPerson } = createRequire(import.meta.url)('../../scripts/lib/push-rescue.js');
const src = fs.readFileSync(new URL('../../scripts/lib/push-rescue.js', import.meta.url), 'utf8');
const wf = fs.readFileSync(new URL('../../.github/workflows/replay-push-rescue.yml', import.meta.url), 'utf8');

test('waitingForPerson picks only keepForHuman branches', () => {
  const m = { refs: [{ ref: 'a', keepForHuman: true }, { ref: 'b', keepForHuman: false }, { ref: 'c' }] };
  assert.deepEqual(waitingForPerson(m).map((r) => r.ref), ['a']);
  assert.deepEqual(waitingForPerson({}), []);
});

test('cliPrune never sets a failing exit code for waiting branches', () => {
  const prune = src.slice(src.indexOf('function cliPrune'), src.indexOf('function waitingForPerson'));
  assert.ok(prune.includes('waitingForPerson(manifest)'));
  assert.ok(!/process\.exitCode\s*=\s*1/.test(prune), 'cliPrune must not fail the run for a branch waiting on a person');
});

test('workflow reports waiting branches through a non-failing notify step', () => {
  assert.match(wf, /id: prune/);
  assert.match(wf, /steps\.prune\.outputs\.waiting/);
  const step = wf.slice(wf.indexOf('Report branches waiting for a person'));
  assert.match(step.slice(0, 700), /notify-failure/);
});
