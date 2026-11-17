import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { checkBacklog } = createRequire(import.meta.url)('./check-never-audited-backlog.js');

test('BRO-6794: backlog at or under the limit passes, over fails', () => {
  const gap = { staleness: { neverAuditedDueAtStart: 652, at: new Date().toISOString() } };
  assert.equal(checkBacklog(gap, 100).ok, false);
  assert.equal(checkBacklog(gap, 652).ok, true);
});
test('BRO-6794: missing metric throws instead of passing', () => {
  assert.throws(() => checkBacklog({}, 100), /missing/);
});
test('BRO-7622: an audit older than 48h, or with no run time, is stale (never a pass)', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  assert.equal(checkBacklog({ staleness: { neverAuditedDueAtStart: 0, at: '2026-11-15T11:00:00Z' } }, 100, now).stale, true);
  assert.equal(checkBacklog({ staleness: { neverAuditedDueAtStart: 0 } }, 100, now).stale, true);
  assert.equal(checkBacklog({ staleness: { neverAuditedDueAtStart: 0, at: '2026-11-17T10:00:00Z' } }, 100, now).stale, false);
});
