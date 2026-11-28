// BRO-2221 regression guard: the test files that were armed time bombs under the
// +45d clock shift (scripts/audit-time-bomb-tests.js) must keep passing under it.
// The full audit runs weekly in CI; this pins the specific files fixed here so a
// reintroduced `new Date()`/`Date.now()` compared against a child process or
// real clock fails in the normal suite instead of on a calendar date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realNowMs } from '../tests/helpers/clock-shift.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFT_DAYS = 45;

const FIXED = [
  'scripts/clear-stale-roundup-flags.test.mjs',
  'scripts/lib/sync-audit-checkout.test.mjs',
  'scripts/trace-connect-phase.test.mjs',
  'tests/unit/broadway-source-coverage-rotted.test.mjs',
  'scripts/tests/dispatch-watchdog-staleness.test.mjs',
  'tests/unit/promote-regional-auto.test.mjs',
];
// fs-mtime coupled, exempt in-file; assert the marker survives instead of running shifted.
const EXEMPT = ['tests/unit/cookie-renewal.test.mjs'];

for (const rel of FIXED) {
  test(`${rel} passes under +${SHIFT_DAYS}d clock shift`, () => {
    const r = spawnSync(process.execPath,
      ['--import', path.join(ROOT, 'tests/helpers/clock-shift.mjs'), '--test', path.join(ROOT, rel)],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BSC_CLOCK_SHIFT_DAYS: String(SHIFT_DAYS) }, timeout: 240000 });
    assert.equal(r.status, 0, `${rel} fails under the shifted clock:\n${(r.stdout || '').slice(-1500)}${r.stderr || ''}`);
  });
}

for (const rel of EXEMPT) {
  test(`${rel} keeps its timebomb-audit-exempt reason`, () => {
    assert.match(fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n')[0], /^\/\/ timebomb-audit-exempt: \S.{20,}/);
  });
}

test('realNowMs equals Date.now() when unshifted', () => {
  if (Number(process.env.BSC_CLOCK_SHIFT_DAYS || 0) === 0) assert.ok(Math.abs(realNowMs() - Date.now()) < 1000);
});
