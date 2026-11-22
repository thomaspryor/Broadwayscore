// BRO-8028: the deploy-frequency step in check-cron-health.yml must stay advisory and time-boxed
// so it can never skip or starve the critical-cron checks that follow it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const target = process.argv[2] || new URL('../.github/workflows/check-cron-health.yml', import.meta.url);
const y = fs.readFileSync(target, 'utf8');
test('deploy frequency step in check-cron-health.yml is advisory and time-boxed, before the cron checks', () => {
  const i = y.indexOf('- name: Production deploy frequency');
  const j = y.indexOf('- name: Check critical crons ran recently');
  assert.ok(i > 0 && j > i);
  const block = y.slice(i, j);
  assert.match(block, /timeout-minutes: 2/);
  assert.match(block, /continue-on-error: true/);
});
