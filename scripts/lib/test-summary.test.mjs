import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { summarizeNeeds } = createRequire(import.meta.url)('./test-summary.js');

test('all success/skipped passes', () => {
  assert.equal(summarizeNeeds({ a: { result: 'success' }, b: { result: 'skipped' } }).failed, false);
});
test('failure fails', () => {
  assert.equal(summarizeNeeds({ a: { result: 'failure' } }).message, 'Some tests failed');
});
test('cancelled (timeout) job fails the summary', () => {
  const s = summarizeNeeds({ a: { result: 'success' }, b: { result: 'cancelled' } });
  assert.equal(s.failed, true);
  assert.equal(s.message, 'Some tests failed');
});
test('empty needs passes', () => {
  assert.equal(summarizeNeeds({}).failed, false);
});
test('test.yml Check results step really checks failure AND cancelled', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
  const i = y.indexOf('  test-summary:');
  const step = y.slice(i, y.indexOf('Detect consecutive main test failures', i));
  assert.match(step, /contains\(needs\.\*\.result, 'failure'\)/);
  assert.match(step, /contains\(needs\.\*\.result, 'cancelled'\)/);
});
