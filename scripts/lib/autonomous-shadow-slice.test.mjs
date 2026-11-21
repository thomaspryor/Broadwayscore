import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectShadowSlice } from './autonomous-shadow-slice.js';
import { isHumanTerritory } from '../autonomous-shadow-run.js';

function card(id, category) {
  return { id, name: `card ${id}`, category };
}

function humanTerritoryByCategory(card) {
  if (card.category === 'marketing' || card.category === 'partnerships') {
    return `category "${card.category}" is human territory`;
  }
  return null;
}

test('a pool whose top-N are all human-territory still yields a full non-human slice', () => {
  const cards = [
    card('m1', 'marketing'),
    card('p1', 'partnerships'),
    card('m2', 'marketing'),
    card('real1', 'data'),
    card('real2', 'data'),
    card('real3', 'data'),
  ];
  const { selected, skipped } = selectShadowSlice({
    cards,
    limit: 3,
    isHumanTerritory: humanTerritoryByCategory,
  });
  assert.deepEqual(selected.map(c => c.id), ['real1', 'real2', 'real3']);
  assert.deepEqual(skipped.map(s => s.card.id), ['m1', 'p1', 'm2']);
});

test('skipped cards are returned and counted, not silently dropped', () => {
  const cards = [card('m1', 'marketing'), card('real1', 'data'), card('p1', 'partnerships')];
  const { selected, skipped } = selectShadowSlice({
    cards,
    limit: 5,
    isHumanTerritory: humanTerritoryByCategory,
  });
  assert.deepEqual(selected.map(c => c.id), ['real1']);
  assert.equal(skipped.length, 2);
  assert.deepEqual(skipped.map(s => s.card.id).sort(), ['m1', 'p1']);
  assert.equal(skipped.find(s => s.card.id === 'm1').reason, 'category "marketing" is human territory');
});

test('the slice is capped at limit even when more eligible cards exist', () => {
  const cards = [card('r1', 'data'), card('r2', 'data'), card('r3', 'data'), card('r4', 'data')];
  const { selected, skipped } = selectShadowSlice({
    cards,
    limit: 2,
    isHumanTerritory: humanTerritoryByCategory,
  });
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map(c => c.id), ['r1', 'r2']);
  // r3/r4 were never walked past the cap — not "skipped", just not needed.
  assert.equal(skipped.length, 0);
});

test('alreadySeenIds are skipped with an explicit reason', () => {
  const cards = [card('a', 'data'), card('b', 'data')];
  const { selected, skipped } = selectShadowSlice({
    cards,
    limit: 5,
    isHumanTerritory: humanTerritoryByCategory,
    alreadySeenIds: new Set(['a']),
  });
  assert.deepEqual(selected.map(c => c.id), ['b']);
  assert.deepEqual(skipped, [{ card: cards[0], reason: 'already-seen' }]);
});

test('omitting isHumanTerritory treats every card as a candidate', () => {
  const cards = [card('a'), card('b')];
  const { selected, skipped } = selectShadowSlice({ cards, limit: 1 });
  assert.deepEqual(selected.map(c => c.id), ['a']);
  assert.equal(skipped.length, 0);
});

test('limit must be a positive integer', () => {
  assert.throws(() => selectShadowSlice({ cards: [], limit: 0 }), /positive integer/);
  assert.throws(() => selectShadowSlice({ cards: [], limit: -1 }), /positive integer/);
  assert.throws(() => selectShadowSlice({ cards: [], limit: 1.5 }), /positive integer/);
});

test('empty pool yields an empty slice, not a throw', () => {
  const { selected, skipped } = selectShadowSlice({ cards: [], limit: 5, isHumanTerritory: humanTerritoryByCategory });
  assert.deepEqual(selected, []);
  assert.deepEqual(skipped, []);
});

test('wired against the real production predicate (isHumanTerritory from autonomous-shadow-run.js)', () => {
  const cards = [
    { id: 'm1', name: 'r/offbroadway: launch post', category: 'Marketing', tags: [] },
    { id: 'p1', name: 'Follow up with TodayTix', category: 'Partnerships', tags: [] },
    { id: 'claimed', name: 'Some data card', category: 'Data', tags: [], auto: 'attempted' },
    { id: 'real1', name: 'Fix a null-check bug in the parser', category: 'Data', tags: [] },
  ];
  const { selected, skipped } = selectShadowSlice({ cards, limit: 5, isHumanTerritory });
  assert.deepEqual(selected.map(c => c.id), ['real1']);
  assert.deepEqual(skipped.map(s => s.card.id).sort(), ['claimed', 'm1', 'p1']);
  assert.match(skipped.find(s => s.card.id === 'm1').reason, /human territory/);
  assert.match(skipped.find(s => s.card.id === 'claimed').reason, /Auto state "attempted"/);
});
