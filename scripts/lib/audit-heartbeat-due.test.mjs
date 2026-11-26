import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { heartbeatDue } = createRequire(import.meta.url)('./audit-heartbeat-due.js');
const now = new Date('2026-11-26T12:00:00Z');
const rep = (at, extra = {}) => JSON.stringify({ generatedAt: at, moved: 0, held: [], ...extra });

test('fresh timestamp-only change is not due', () => {
  assert.equal(heartbeatDue(rep('2026-11-26T05:00:00Z'), rep('2026-11-26T12:00:00Z'), now), false);
});
test('committed copy older than 12h is due', () => {
  assert.equal(heartbeatDue(rep('2026-11-25T20:00:00Z'), rep('2026-11-26T12:00:00Z'), now), true);
});
test('a real change is due at once', () => {
  assert.equal(heartbeatDue(rep('2026-11-26T11:00:00Z'), rep('2026-11-26T12:00:00Z', { moved: 2 }), now), true);
});
test('missing or broken committed copy is due; broken current is not', () => {
  assert.equal(heartbeatDue('', rep('2026-11-26T12:00:00Z'), now), true);
  assert.equal(heartbeatDue(rep('2026-11-26T05:00:00Z'), 'oops', now), false);
});
