import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { promotionDecision, planPromotion, unparkDescription, buildPromoteComment, PROMOTE_COMMENT_MARKER } = require('./linear-promote-parked.js');
const { skipReason } = require('./cloud-worker-pick.js');

const NOW = Date.parse('2026-10-18T12:00:00Z');
const VERIFY = 'VERIFY: node --test scripts/lib/cloud-worker-pick.test.mjs';
const card = (park, o = {}) => ({
  identifier: 'BRO-9001', title: 'Fix the thing', priority: 3, updatedAt: new Date(NOW - 3600e3).toISOString(),
  state: { name: 'Backlog', type: 'backlog' },
  description: `${park === null ? '' : `PARKED: ${park}\n\n`}Problem: x\n${VERIFY}`, ...o,
});

test('technical park with a safe VERIFY is promotable', () => {
  assert.deepEqual(promotionDecision(card('needs its own session, several files')), { promote: true, reason: 'ok' });
});

test('owner-only, date-wait, owner-text, machine-filed and unverifiable parks stay parked', () => {
  assert.equal(promotionDecision(card('needs the owner Mac')).reason, 'owner-only-park');
  assert.equal(promotionDecision(card('spends money on credits')).reason, 'owner-only-park');
  assert.equal(promotionDecision(card('wait until 2026-11-01 for the window')).reason, 'wait-park');
  assert.equal(promotionDecision(card('waiting on the owner')).reason, 'owner-hold-park');
  assert.equal(promotionDecision(card('Auto-filed by owner-alert-router: x')).reason, 'machine-filed');
  assert.equal(promotionDecision(card('own session', { description: 'PARKED: own session\n\nno verify here' })).reason, 'no-safe-verify');
  assert.equal(promotionDecision(card('own session', { description: `PARKED: own session\n\nVERIFY: owner-judgment` })).reason, 'owner-judgment');
});

test('non-backlog, unprioritised and park-line-less cards are not touched', () => {
  assert.equal(promotionDecision(card('x', { state: { name: 'Todo', type: 'unstarted' } })).reason, 'not-backlog');
  assert.equal(promotionDecision(card('x', { priority: 0 })).reason, 'no-priority');
  assert.equal(promotionDecision(card(null)).reason, 'no-park-line');
});

test('awaiting-owner label keeps a card parked', () => {
  assert.equal(promotionDecision(card('own session', { labels: { nodes: [{ name: 'awaiting-owner' }] } })).reason, 'awaiting-owner');
});

test('planPromotion orders by priority then age, applies limit, tallies reasons', () => {
  const p = planPromotion([card('own session', { identifier: 'BRO-30', priority: 3 }), card('own session', { identifier: 'BRO-20', priority: 3 }),
    card('own session', { identifier: 'BRO-40', priority: 2 }), card('needs the owner Mac', { identifier: 'BRO-50' })], { limit: 2 });
  assert.deepEqual(p.promote.map((i) => i.identifier), ['BRO-40', 'BRO-20']);
  assert.equal(p.eligible, 3);
  assert.equal(p.tally['owner-only-park'], 1);
});

test('the picker skips the parked card and takes it after unpark (the bug this fixes)', () => {
  const parked = card('needs its own session, several files', { updatedAt: new Date(NOW - 48 * 3600e3).toISOString() });
  assert.equal(skipReason(parked, NOW, { tier: 'p2' }), 'parked-or-backlog');
  const moved = { ...parked, state: { name: 'Todo', type: 'unstarted' }, description: unparkDescription(parked.description) };
  assert.equal(skipReason(moved, NOW, { tier: 'p2' }), null);
});

test('unparkDescription drops every PARKED sentinel and keeps the reason', () => {
  const out = unparkDescription('PARKED: a\n\nbody\nPARKED: b');
  assert.doesNotMatch(out, /^\s*PARKED\s*:/im);
  assert.match(out, /a/);
  assert.match(out, /b/);
  assert.ok(buildPromoteComment(card('a b c')).startsWith(PROMOTE_COMMENT_MARKER));
});

test('review BRO-5626: owner/blocked/ordering/later park reasons stay parked, picker or not', () => {
  for (const r of ['superseded by BRO-5000', 'do not dispatch, deliberately held', 'blocked by BRO-4100', 'needs human judgment on wording',
    'needs the owner to pick between two designs', 'depends on BRO-12 landing first', 'Thomas must approve', 'held for owner']) {
    assert.equal(promotionDecision(card(r)).promote, false, r);
  }
  assert.equal(promotionDecision(card('low impact follow-up', { priority: 4 })).reason, 'later-park');
});

test('review BRO-5626: awaiting-owner label and reclaim history keep a card parked', () => {
  assert.equal(promotionDecision(card('own session', { comments: { nodes: [{ body: 'RECLAIMED-ABANDONED: x', createdAt: '2026-10-01T00:00:00Z' }] } })).reason, 'reclaimed');
  assert.match(promotionDecision(card('own session', { description: 'PARKED: own session\n\nDECISION NEEDED: x\n' + VERIFY })).reason, /owner-text/);
});

test('review BRO-5626: the open-issues query fetches labels so awaiting-owner is visible', () => {
  assert.match(require('./linear-dispatch.js').buildOpenIssuesWithDescriptionsQuery(), /labels \{ nodes \{ name \} \}/);
});

test('promoteOne writes to the id of the fresh read (the listing has none) and skips an edited card', async () => {
  const { promoteOne } = require('./linear-promote-parked.js');
  const listed = card('needs its own session, several files'); // no id, like the open-issues listing
  const calls = [];
  const linear = (fresh) => ({
    getIssue: async () => fresh,
    updateIssue: async (id, input) => { calls.push(['update', id, input]); },
    createComment: async (id, body) => { calls.push(['comment', id, body]); },
  });
  assert.equal(await promoteOne({ linear: linear({ ...listed, id: 'uuid-1' }), issue: listed, todoStateId: 'todo-1' }), 'moved');
  assert.equal(calls[0][1], 'uuid-1');
  assert.equal(calls[0][2].stateId, 'todo-1');
  assert.doesNotMatch(calls[0][2].description, /^\s*PARKED\s*:/im);
  assert.equal(calls[1][1], 'uuid-1');
  calls.length = 0;
  assert.equal(await promoteOne({ linear: linear({ ...listed, id: 'uuid-1', description: listed.description + '\nedited' }), issue: listed, todoStateId: 'todo-1' }), 'changed');
  assert.equal(calls.length, 0);
});
