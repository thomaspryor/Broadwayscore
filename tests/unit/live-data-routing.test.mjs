import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planLiveDataRouting, KEY_PREFIX, conditionKeyFor } = require('../../scripts/lib/live-data-routing.js');
const { parseTapOutput } = require('../../scripts/lib/tap-failure-parser.js');

const TAP = `TAP version 13
not ok 1 - ceiling holds
  ---
  duration_ms: 1
  location: '/r/tests/unit/a.test.mjs:5:1'
  failureType: 'testCodeFailure'
  error: 'too many'
  ...
not ok 2 - tests/unit/b.test.mjs
  ---
  location: '/r/tests/unit/b.test.mjs:1:1'
  failureType: 'subtestsFailed'
  ...
ok 3 - fine
# tests 3
# fail 2
`;

test('each failing leaf test is its own routed condition; containers skipped', () => {
  const p = parseTapOutput(TAP, '/r');
  const plan = planLiveDataRouting(p.failures, [], p, 1);
  assert.deepEqual(plan.route.map((r) => r.conditionKey), [conditionKeyFor('tests/unit/a.test.mjs::ceiling holds')]);
  assert.equal(plan.route[0].disposition, 'digest');
});
test('green tests resolve open keys; foreign keys untouched', () => {
  const p = parseTapOutput(TAP, '/r');
  const plan = planLiveDataRouting(p.failures, [`${KEY_PREFIX}gone`, 'corpus-drift:x'], p, 1);
  assert.deepEqual(plan.resolve, [`${KEY_PREFIX}gone`]);
});
test('a run with no verdict resolves nothing and a silent non-zero exit routes run-crashed', () => {
  const p = parseTapOutput('', '/r');
  const plan = planLiveDataRouting(p.failures, [`${KEY_PREFIX}old`], p, 1);
  assert.deepEqual(plan.resolve, []);
  assert.equal(plan.route[0].conditionKey, `${KEY_PREFIX}run-crashed`);
});
test('clean run resolves every open live-data key', () => {
  const p = parseTapOutput('ok 1 - a\n# tests 1\n# fail 0\n', '/r');
  const plan = planLiveDataRouting(p.failures, [`${KEY_PREFIX}old`], p, 0);
  assert.deepEqual(plan.resolve, [`${KEY_PREFIX}old`]);
  assert.equal(plan.route.length, 0);
});
test('truncated TAP (no summary) resolves nothing; long keys stay distinct', () => {
  const p = parseTapOutput('ok 1 - a\n', '/r');
  assert.deepEqual(planLiveDataRouting(p.failures, [`${KEY_PREFIX}old`], p, 0).resolve, []);
  const a = conditionKeyFor('f::' + 'x'.repeat(300) + 'A');
  const b = conditionKeyFor('f::' + 'x'.repeat(300) + 'B');
  assert.notEqual(a, b);
  assert.ok(a.length <= 200);
});
test('open keys of a file that failed this run are not resolved', () => {
  const p = parseTapOutput(TAP, '/r');
  const plan = planLiveDataRouting(p.failures, [conditionKeyFor('tests/unit/a.test.mjs::renamed test')], p, 1);
  assert.deepEqual(plan.resolve, []);
});
