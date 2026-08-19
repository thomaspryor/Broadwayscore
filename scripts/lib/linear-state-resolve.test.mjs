// scripts/lib/linear-state-resolve.test.mjs — S4-T1's state resolution.
//
// The acceptance criterion is that an unknown state name "exits non-zero with
// the valid states listed". The listing half is what matters: an operator who
// typed the wrong name needs to see the real vocabulary, not just a rejection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveState, formatStateError } = require('./linear-state-resolve.js');

// Shaped like a real team's states (getTeam().states.nodes).
const STATES = [
  { id: 's1', name: 'Backlog', type: 'backlog' },
  { id: 's2', name: 'Todo', type: 'unstarted' },
  { id: 's3', name: 'In Progress', type: 'started' },
  { id: 's4', name: 'Done', type: 'completed' },
  { id: 's5', name: 'Canceled', type: 'canceled' },
];

test('resolves an exact state name', () => {
  const r = resolveState('In Progress', STATES);
  assert.equal(r.ok, true);
  assert.equal(r.state.id, 's3');
});

test('case and surrounding whitespace are typos, not different intent', () => {
  for (const spelling of ['done', 'DONE', '  Done  ', 'dOnE']) {
    const r = resolveState(spelling, STATES);
    assert.equal(r.ok, true, `${JSON.stringify(spelling)} should resolve`);
    assert.equal(r.state.name, 'Done');
  }
});

test('an unknown state fails AND names the valid set', () => {
  const r = resolveState('Shipped', STATES);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown state "Shipped"/);
  assert.deepEqual(r.valid, ['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled']);

  const msg = formatStateError(r);
  // Every real state must appear in what the operator sees.
  for (const s of STATES) assert.ok(msg.includes(s.name), `error message must list ${s.name}`);
});

test('notion-brain vocabulary is NOT silently translated', () => {
  // 'Paused' is a Notion status. Linear has no such state here, and guessing a
  // nearest match ("Canceled"? "Backlog"?) would file work into the wrong
  // column silently. It must fail loudly instead.
  const r = resolveState('Paused', STATES);
  assert.equal(r.ok, false);
  assert.match(formatStateError(r), /Valid states: .*Canceled/);
});

test('no fuzzy matching — a prefix must not resolve', () => {
  // A team with both "Doing" and "Done" makes prefix matching actively wrong.
  const ambiguous = [...STATES, { id: 's6', name: 'Doing', type: 'started' }];
  assert.equal(resolveState('Do', ambiguous).ok, false);
  assert.equal(resolveState('Don', ambiguous).ok, false);
  assert.equal(resolveState('Doing', ambiguous).ok, true);
});

test('an empty or missing name is rejected, not treated as a match', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const r = resolveState(empty, STATES);
    assert.equal(r.ok, false, `${JSON.stringify(empty)} must not resolve`);
    assert.match(r.error, /no state name given/);
  }
});

test('a team with no states still produces a usable message, not a crash', () => {
  for (const empty of [[], null, undefined]) {
    const r = resolveState('Done', empty);
    assert.equal(r.ok, false);
    assert.match(formatStateError(r), /\(none found on this team\)/);
  }
});
