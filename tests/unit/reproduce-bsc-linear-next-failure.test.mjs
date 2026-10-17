// BRO-2637: scripts/bsc-next.test.mjs and tests/unit/linear-next.test.mjs once
// failed together inside the full-manifest `node --test` batch with a bare
// `not ok` TAP line and no nested output (child died before any test()
// registered). Both pass alone. This runs them together, plus a few
// neighbours that touch the same dispatch fixtures, as one controlled batch
// and asserts the failure signature never recurs: exit 0, zero failures, and
// real subtest output (a child that dies silently reports no nested tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = [
  'scripts/bsc-next.test.mjs',
  'scripts/bsc-next-ci-red-claim.test.mjs',
  'scripts/tests/linear-next-dispatch.test.mjs',
  'scripts/tests/linear-next-overlap-guards.test.mjs',
  'tests/unit/linear-next.test.mjs',
];

test('bsc-next + linear-next batch runs to completion with nested output', () => {
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-timeout', '120000', '--test-reporter=tap', ...FILES],
    { cwd: root, encoding: 'utf8', timeout: 240000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (label) => Number((out.match(new RegExp(`^# ${label} (\\d+)`, 'm')) || [])[1]);
  assert.equal(r.status, 0, `batch exited ${r.status}\n${out.slice(-2000)}`);
  assert.equal(num('fail'), 0, out.slice(-2000));
  // Each file must contribute subtests; 180+ were passing for the two named files alone.
  assert.ok(num('pass') >= 150, `expected >=150 passing tests, got ${num('pass')}`);
  for (const f of FILES) assert.ok(!new RegExp(`^not ok \\d+ - ${f}`, 'm').test(out), `${f} failed bare`);
});
