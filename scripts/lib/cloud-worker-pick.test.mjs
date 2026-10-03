import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickCloudCard, skipReason, IDLE_MS } = require('./cloud-worker-pick.js');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const OLD = new Date(NOW - IDLE_MS - 60_000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();
const SAFE_CMD = '`node --test scripts/lib/example.test.mjs`';
const BODY = `## Problem\nX broke.\n\n## Acceptance criteria\n${SAFE_CMD} passes.`;

function issue(over = {}) {
  return {
    identifier: 'BRO-100',
    title: 'Fix the thing',
    description: BODY,
    priority: 2,
    state: { name: 'Todo', type: 'unstarted' },
    updatedAt: OLD,
    ...over,
  };
}

test('picks highest priority first, then oldest issue number', () => {
  const { pick, eligible } = pickCloudCard([
    issue({ identifier: 'BRO-50', priority: 2 }),
    issue({ identifier: 'BRO-900', priority: 1 }),
    issue({ identifier: 'BRO-800', priority: 1 }),
  ], { nowMs: NOW });
  assert.equal(pick.identifier, 'BRO-800');
  assert.equal(eligible, 3);
});

test('skips P2+, started cards, recent activity, and cards without a safe VERIFY', () => {
  assert.equal(skipReason(issue({ priority: 3 }), NOW), 'not-p0-p1');
  assert.equal(skipReason(issue({ state: { name: 'In Progress', type: 'started' } }), NOW), 'state-started');
  assert.equal(skipReason(issue({ updatedAt: FRESH }), NOW), 'recent-activity');
  assert.equal(skipReason(issue({ description: '## Acceptance criteria\nLooks right.' }), NOW), 'no-safe-verify');
  assert.equal(skipReason(issue({ updatedAt: undefined }), NOW), 'no-updatedAt');
});

test('skips headless blockers: visual QA, owner decision, async wait', () => {
  assert.match(skipReason(issue({ description: `${BODY}\nTouches src/components/Foo.tsx` }), NOW), /^blocker-VISUAL_QA_GATE/);
  assert.equal(skipReason(issue({ description: `${BODY}\n\nDECISION NEEDED: owner picks the copy.` }), NOW), 'blocker-OWNER_DECISION_GATE');
  assert.equal(skipReason(issue({ description: `${BODY}\n\nRECHECK-AFTER: 2026-12-01` }), NOW), 'blocker-ASYNC_WAIT_GATE');
});

test('takes a technically parked P0/P1 session card, refuses an owner hold', () => {
  const tech = issue({ state: { name: 'Backlog', type: 'backlog' }, description: `PARKED: needs a rule-18 second-opinion before the edit\n\n${BODY}` });
  assert.equal(skipReason(tech, NOW), null);
  const hold = issue({ state: { name: 'Backlog', type: 'backlog' }, description: `PARKED: waiting on owner go-ahead\n\n${BODY}` });
  assert.equal(skipReason(hold, NOW), 'parked-or-backlog');
});

test('empty board returns no pick', () => {
  const { pick, eligible, skipped } = pickCloudCard([], { nowMs: NOW });
  assert.equal(pick, null);
  assert.equal(eligible, 0);
  assert.deepEqual(skipped, {});
});
