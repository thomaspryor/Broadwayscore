import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { checkBacklog } = createRequire(import.meta.url)('./check-never-audited-backlog.js');

test('BRO-6794: backlog at or under the limit passes, over fails', () => {
  const gap = { staleness: { neverAuditedDueAtStart: 652, at: 'x' } };
  assert.equal(checkBacklog(gap, 100).ok, false);
  assert.equal(checkBacklog(gap, 652).ok, true);
});
test('BRO-6794: missing metric throws instead of passing', () => {
  assert.throws(() => checkBacklog({}, 100), /missing/);
});
