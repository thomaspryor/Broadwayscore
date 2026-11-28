import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseParkedDate, parseParkedTaskId, formatParkOutcome } = require('./park-marker.js');

test('round-trip: parseParkedDate/parseParkedTaskId read back what formatParkOutcome writes', () => {
  const outcome = formatParkOutcome({ dateStr: '2026-08-02', workspaceRef: 'workspace:246', taskId: 872 });
  assert.equal(parseParkedDate(outcome), Date.parse('2026-08-02T00:00:00Z'));
  assert.equal(parseParkedTaskId(outcome), 872);
  // The resume command must survive verbatim — it's what the digest/status
  // readers surface to the owner.
  assert.match(outcome, /node scripts\/bsc-next\.js --id 872 --force/);
});

test('parseParkedTaskId honors the same head-anchoring contract', () => {
  const parked = formatParkOutcome({ dateStr: '2026-07-01', workspaceRef: 'workspace:9', taskId: 42 });
  assert.equal(parseParkedTaskId(`## Shipped\n\n---\n\n${parked}`), null);
  assert.equal(parseParkedTaskId(parked), 42);
});

test('marker is only honored at the HEAD of the outcome (prepend recency contract)', () => {
  const parked = formatParkOutcome({ dateStr: '2026-07-01', workspaceRef: 'workspace:9', taskId: 1 });
  // A later outcome write prepends above the marker → no longer freshest state.
  const buried = `## Shipped the fix\n\n---\n\n${parked}`;
  assert.equal(parseParkedDate(buried), null);
  assert.equal(parseParkedDate(parked), Date.parse('2026-07-01T00:00:00Z'));
});

test('tolerates empty/undefined/garbage input', () => {
  assert.equal(parseParkedDate(''), null);
  assert.equal(parseParkedDate(undefined), null);
  assert.equal(parseParkedDate('## Parked not-a-date\nstuff'), null);
  assert.equal(parseParkedDate('## Parked 2026-99-99\nstuff'), null);
});
