import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_TIERS,
  detectTierTransitions,
  buildTierChangeEntry,
} from '../lib/tier-transition-notifier.js';

test('fires on first-ever observation of a notify tier (no prior state)', () => {
  const { transitions, nextState } = detectTierTransitions(
    [{ showId: 'show-a', tier: 'Buzzing' }],
    {},
  );
  assert.equal(transitions.length, 1);
  assert.deepEqual(transitions[0], { showId: 'show-a', tier: 'Buzzing', previousTier: null });
  assert.deepEqual(nextState, { 'show-a': { lastTier: 'Buzzing' } });
});

test('does not re-fire while a show stays in the same notify tier (debounce)', () => {
  const { transitions } = detectTierTransitions(
    [{ showId: 'show-a', tier: 'Buzzing' }],
    { 'show-a': { lastTier: 'Buzzing' } },
  );
  assert.equal(transitions.length, 0);
});

test('re-fires after a show leaves and later re-enters the same tier', () => {
  const afterLeaving = detectTierTransitions(
    [{ showId: 'show-a', tier: 'Steady' }],
    { 'show-a': { lastTier: 'Buzzing' } },
  );
  assert.equal(afterLeaving.transitions.length, 0);
  assert.deepEqual(afterLeaving.nextState['show-a'], { lastTier: 'Steady' });

  const onReturn = detectTierTransitions(
    [{ showId: 'show-a', tier: 'Buzzing' }],
    afterLeaving.nextState,
  );
  assert.equal(onReturn.transitions.length, 1);
  assert.equal(onReturn.transitions[0].previousTier, 'Steady');
});

test('fires on a direct jump between the two notify tiers', () => {
  const { transitions } = detectTierTransitions(
    [{ showId: 'show-a', tier: 'Troubled' }],
    { 'show-a': { lastTier: 'Buzzing' } },
  );
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].tier, 'Troubled');
  assert.equal(transitions[0].previousTier, 'Buzzing');
});

test('never fires for non-notify tiers, but still tracks state', () => {
  for (const tier of ['Rising', 'Steady', 'BuildingBaseline', 'Hidden']) {
    const { transitions, nextState } = detectTierTransitions(
      [{ showId: 'show-a', tier }],
      {},
    );
    assert.equal(transitions.length, 0, `tier ${tier} should not notify`);
    assert.deepEqual(nextState['show-a'], { lastTier: tier });
  }
});

test('skips entries with no showId or no tier without throwing', () => {
  const { transitions, nextState } = detectTierTransitions(
    [
      { showId: null, tier: 'Buzzing' },
      { showId: 'show-b', tier: null },
      { showId: 'show-c', tier: 'Buzzing' },
    ],
    {},
  );
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].showId, 'show-c');
  assert.deepEqual(Object.keys(nextState), ['show-c']);
});

test('handles an empty pulse list', () => {
  const { transitions, nextState } = detectTierTransitions([], { 'show-a': { lastTier: 'Buzzing' } });
  assert.equal(transitions.length, 0);
  assert.deepEqual(nextState, {});
});

test('multiple shows are evaluated independently in one pass', () => {
  const { transitions, nextState } = detectTierTransitions(
    [
      { showId: 'buzzing-new', tier: 'Buzzing' },
      { showId: 'buzzing-already', tier: 'Buzzing' },
      { showId: 'troubled-new', tier: 'Troubled' },
      { showId: 'steady-show', tier: 'Steady' },
    ],
    { 'buzzing-already': { lastTier: 'Buzzing' } },
  );
  const firedIds = transitions.map(t => t.showId).sort();
  assert.deepEqual(firedIds, ['buzzing-new', 'troubled-new']);
  assert.equal(Object.keys(nextState).length, 4);
});

test('NOTIFICATION_TIERS is exactly Buzzing + Troubled', () => {
  assert.deepEqual([...NOTIFICATION_TIERS].sort(), ['Buzzing', 'Troubled']);
});

test('buildTierChangeEntry returns a {type, message} shape for Buzzing', () => {
  const entry = buildTierChangeEntry({ showId: 'show-a', tier: 'Buzzing', previousTier: null });
  assert.equal(entry.type, 'social-tier-buzzing');
  assert.match(entry.message, /Buzzing/);
});

test('buildTierChangeEntry returns a {type, message} shape for Troubled', () => {
  const entry = buildTierChangeEntry({ showId: 'show-a', tier: 'Troubled', previousTier: 'Buzzing' });
  assert.equal(entry.type, 'social-tier-troubled');
  assert.match(entry.message, /Troubled/);
});

test('buildTierChangeEntry throws on an unrecognized tier', () => {
  assert.throws(() => buildTierChangeEntry({ showId: 'show-a', tier: 'Steady' }));
});
