import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import cp from 'node:child_process';
const { evaluate } = createRequire(import.meta.url)('./check-deploy-frequency.js');
const now = Date.now();
const mk = (n, ageMs = 1000) => Array.from({ length: n }, (_, i) => now - ageMs - i);
test('under/at the limit passes, over fails, old deploys are ignored', () => {
  assert.equal(evaluate(mk(48), { nowMs: now, hours: 24, max: 60 }).ok, true);
  assert.equal(evaluate(mk(60), { nowMs: now, hours: 24, max: 60 }).ok, true);
  assert.equal(evaluate(mk(61), { nowMs: now, hours: 24, max: 60 }).ok, false);
  assert.equal(evaluate(mk(400, 25 * 3600 * 1000), { nowMs: now, hours: 24, max: 60 }).count, 0);
});
test('CLI exits 1 on 300 deploys/day (last-cycle volume), 0 on 40', () => {
  const run = (n) => cp.spawnSync('node', [new URL('./check-deploy-frequency.js', import.meta.url).pathname], { env: { ...process.env, DEPLOY_FREQ_CREATED_JSON: JSON.stringify(mk(n)) }, encoding: 'utf8' });
  assert.equal(run(300).status, 1);
  assert.equal(run(40).status, 0);
});
