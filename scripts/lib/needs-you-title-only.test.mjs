// Title-only ❓ tabs (2026-09-16, owner-reported digest/sidebar divergence).
//
// Measured that day on this machine: 4 of 7 live ❓ tabs had NO state file in
// ~/.claude/state/needs-you/, so pendingDecisions()'s old state-driven inner
// join omitted them from the morning digest entirely, while the cmux sidebar
// (which reads titles) showed all 7. The digest was the wrong one.
//
// Per CLAUDE.md rule 15 these require() the real functions — no logic is
// copied here, so a regression in the module fails these tests.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pendingDecisions, formatDetail } = require('./needs-you-snapshot.js');

test('pendingDecisions: surfaces a ❓ tab that has NO state file, flagged questionUnavailable', () => {
  const states = [{ ref: 'workspace:1', question: 'ship v2 or wait?', ts: '2026-09-16T07:00:00Z' }];
  const workspaces = [
    { ref: 'workspace:1', title: '❓ Has state' },
    { ref: 'workspace:2', title: '❓ No state file at all' },
  ];
  const pending = pendingDecisions(states, workspaces);
  assert.equal(pending.length, 2);
  const orphan = pending.find(p => p.ref === 'workspace:2');
  assert.ok(orphan, 'title-only ❓ tab must surface');
  assert.equal(orphan.questionUnavailable, true);
  assert.equal(orphan.question, null);
  assert.equal(orphan.ts, null);
});

test('pendingDecisions: the enriched tab keeps its captured question', () => {
  const states = [{ ref: 'workspace:1', question: 'ship v2 or wait?', ts: '2026-09-16T07:00:00Z' }];
  const workspaces = [{ ref: 'workspace:1', title: '❓ Has state' }];
  const [p] = pendingDecisions(states, workspaces);
  assert.equal(p.question, 'ship v2 or wait?');
  assert.equal(p.questionUnavailable, undefined);
});

test('pendingDecisions: a state file with a "none" stub is STILL excluded (card #940 preserved)', () => {
  const states = [{ ref: 'workspace:2', question: 'none — no pending decision', ts: '2026-09-16T07:00:00Z' }];
  const workspaces = [{ ref: 'workspace:2', title: '❓ Explicitly nothing to ask' }];
  assert.deepEqual(pendingDecisions(states, workspaces), []);
});

test('pendingDecisions: non-❓ tabs without state files are not swept in', () => {
  const workspaces = [
    { ref: 'workspace:5', title: '🧭 Owner thread' },
    { ref: 'workspace:6', title: '✅ Done' },
    { ref: 'workspace:7', title: 'Plain title' },
  ];
  assert.deepEqual(pendingDecisions([], workspaces), []);
});

test('pendingDecisions: a stale state file whose tab is gone does not resurrect it', () => {
  const states = [{ ref: 'workspace:99', question: 'closed tab', ts: '2026-09-01T07:00:00Z' }];
  assert.deepEqual(pendingDecisions(states, []), []);
});

test('pendingDecisions: tolerates null/undefined inputs without throwing', () => {
  assert.deepEqual(pendingDecisions(null, null), []);
  assert.deepEqual(pendingDecisions(undefined, undefined), []);
  assert.deepEqual(pendingDecisions([null, {}, { ref: 'workspace:9' }], []), []);
});

test('formatDetail: title-only tab tells the owner to open the tab, not "(no question captured)"', () => {
  assert.equal(formatDetail({ questionUnavailable: true }), 'decision pending — open the tab to see it');
  assert.equal(formatDetail({ question: 'ship v2 or wait?' }), 'ship v2 or wait?');
});
