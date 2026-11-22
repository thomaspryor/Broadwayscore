// red-escalation-runner.test.mjs: the real escalateLongRedConditions loop with
// Linear and the alert ledger stubbed at their module exports (no network, no
// ledger write). BRO-7102 recheck: the loop's cheap pre-check used to stand in
// an UNSTARTED card, so any incident under 6h was skipped before the real
// card's state was read, and a parked (In Review) card waited the full 6h.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const router = require('./owner-alert-router.js');
const linear = require('./linear-client.js');

const H = 3600_000;
const calls = [];
let ledger = { conditions: {} };
let issue = null;
router.loadLedger = () => ledger;
router.patchCondition = (key, patch) => calls.push(['patch', key, patch]);
linear.graphql = async () => { calls.push(['read']); return { issue }; };
linear.getTeam = async () => ({ states: { nodes: [{ id: 's-todo', name: 'Todo', type: 'unstarted' }] } });
linear.updateIssue = async (id, input) => calls.push(['update', id, input]);
linear.createComment = async (id, body) => calls.push(['comment', id, body]);
// Required AFTER the stubs: the runner destructures loadLedger/patchCondition at load.
const { escalateLongRedConditions } = require('./red-escalation-runner.js');

const KEY = 'test-yml:red:E2E Tests:9baa74b4';
function setup({ ageH, state }) {
  calls.length = 0;
  ledger = { conditions: { [KEY]: { status: 'open', incidentOpenedAt: new Date(Date.now() - ageH * H).toISOString(), linearIdentifier: 'BRO-7268' } } };
  issue = {
    id: 'uuid-7268', identifier: 'BRO-7268', title: 'main test.yml red: E2E Tests / Run E2E tests', priority: 2,
    description: '## Problem\nE2E red.\n\n## Acceptance criteria\nVERIFY: node --test tests/unit/x.test.mjs',
    updatedAt: new Date(Date.now() - 7 * 24 * H).toISOString(), state: state, comments: { nodes: [] },
  };
}

test('an In Review card red 1.5h is read and put back in Todo with START-NOW (was skipped until 6h)', async () => {
  process.env.LINEAR_API_KEY = process.env.LINEAR_API_KEY || 'test-key';
  setup({ ageH: 1.5, state: { id: 's-rev', name: 'In Review', type: 'started' } });
  await escalateLongRedConditions([KEY]);
  const update = calls.find((c) => c[0] === 'update');
  assert.ok(update, `no update: ${JSON.stringify(calls)}`);
  assert.equal(update[2].stateId, 's-todo');
  assert.match(update[2].description, /^START-NOW: /);
  assert.ok(calls.some((c) => c[0] === 'patch' && c[2].escalatedAt));
});

test('an unstarted card red 1.5h is read but left for the red-first pass (6h window)', async () => {
  setup({ ageH: 1.5, state: { id: 's-todo', name: 'Todo', type: 'unstarted' } });
  await escalateLongRedConditions([KEY]);
  assert.deepEqual(calls.map((c) => c[0]), ['read']);
});

test('a 20-minute incident costs no Linear read', async () => {
  setup({ ageH: 0.3, state: { id: 's-rev', name: 'In Review', type: 'started' } });
  await escalateLongRedConditions([KEY]);
  assert.deepEqual(calls, []);
});
