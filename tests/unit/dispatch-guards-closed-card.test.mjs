/**
 * Task #1790 (stall-sweep half of the mirror problem): the local task mirror
 * is not authoritative about whether a card is still open. A card closed in
 * Notion keeps reading `in_progress` locally until reconcileStaleMirrors
 * rotates to it, and bsc-reconcile.js's stall sweep fires faster than that
 * rotation — measured live 2026-08-18, a card closed at 20:08 was relaunched
 * at 20:43 and pruned again at 20:45.
 *
 * closedCardGuard refuses that dispatch using the card bsc-next.js already
 * fetches. Requires the real guard from scripts/lib/dispatch-guards.js
 * (CLAUDE.md rule 15) rather than restating the decision here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { closedCardGuard, CLOSED_CARD_STATUSES } = require('../../scripts/lib/dispatch-guards.js');

// The shape the bug actually produced: Notion says Done, the mirror still says in_progress.
const STALE_TASK = {
  id: '1789',
  subject: 'future-dated test-fixture rows in the production dispatch ledger',
  status: 'in_progress',
  description: '[notion:3c0637c5416f817bb04ded7de1362b07] P1 Next · Done · Infrastructure',
};

test('a Done card is refused, and the message names the mirror lag and the override', () => {
  const err = closedCardGuard(STALE_TASK, { status: 'Done' }, {});
  assert.ok(err, 'a Done card must not dispatch');
  assert.match(err, /REFUSING to dispatch #1789/);
  assert.match(err, /already Done/);
  assert.match(err, /in_progress/, 'names what the stale mirror still claims');
  assert.match(err, /--allow-closed-card/, 'points at the real escape hatch');
});

test('Cancelled and Canceled are closed too, case-insensitively', () => {
  for (const status of ['Cancelled', 'canceled', 'DONE', 'done']) {
    assert.ok(closedCardGuard(STALE_TASK, { status }, {}), `${status} must be treated as closed`);
  }
  assert.deepEqual([...CLOSED_CARD_STATUSES].sort(), ['canceled', 'cancelled', 'done']);
});

test('an open card dispatches exactly as before', () => {
  assert.equal(closedCardGuard(STALE_TASK, { status: 'In progress' }, {}), null);
  assert.equal(closedCardGuard(STALE_TASK, { status: 'Not started' }, {}), null);
  assert.equal(closedCardGuard(STALE_TASK, { status: '' }, {}), null, 'a card with no status is not a positive closed reading');
});

test('Paused is deliberately NOT closed — it maps into the dispatchable pending lane', () => {
  // notion-tasks-sync.js mapStatus() folds Paused into 'pending'. Treating it
  // as closed here would silently change which cards are workable, which is a
  // policy change, not a stale-mirror fix. Pinned so a later edit must argue
  // with this test rather than quietly widen the set.
  assert.equal(closedCardGuard(STALE_TASK, { status: 'Paused' }, {}), null);
});

test('a degraded Notion fetch (card === null) allows — the guard only fires on a POSITIVE closed reading', () => {
  // Refusing on unknown would let a Notion outage starve bsc-reconcile.js's
  // 2-per-tick stall budget and block genuinely stalled tasks from healing.
  assert.equal(closedCardGuard(STALE_TASK, null, {}), null);
  assert.equal(closedCardGuard(STALE_TASK, undefined, {}), null);
});

test('--force does NOT bypass it — the #853 dead-tab redispatch path stays guarded', () => {
  // bsc-reconcile.js redispatchArgv() carries --force, and that path is
  // exactly where the stale mirror also bites. --force is for the
  // duplicate-workspace guard, never for relaunching closed work.
  assert.ok(closedCardGuard(STALE_TASK, { status: 'Done' }, { force: true }));
  assert.ok(closedCardGuard(STALE_TASK, { status: 'Done' }, { force: true, 'allow-unverifiable': true }));
});

test('--allow-closed-card is a real escape hatch, and dry-run/print-prompt still preview', () => {
  assert.equal(closedCardGuard(STALE_TASK, { status: 'Done' }, { 'allow-closed-card': true }), null);
  assert.equal(closedCardGuard(STALE_TASK, { status: 'Done' }, { 'dry-run': true }), null);
  assert.equal(closedCardGuard(STALE_TASK, { status: 'Done' }, { 'print-prompt': true }), null);
});

test('missing opts does not throw (callers that pass nothing still get a decision)', () => {
  assert.ok(closedCardGuard(STALE_TASK, { status: 'Done' }, undefined));
  assert.equal(closedCardGuard(STALE_TASK, { status: 'In progress' }, undefined), null);
});
