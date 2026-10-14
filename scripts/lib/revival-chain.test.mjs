import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignRevivalChain } from './revival-chain.js';

test('assigns the chronologically earliest production as the original', () => {
  const result = assignRevivalChain([
    { id: 'peter-pan-1979', openingDate: '1979-09-06' },
    { id: 'peter-pan-1991', openingDate: '1991-12-03' },
  ]);
  const byId = Object.fromEntries(result.map(r => [r.id, r]));
  assert.equal(byId['peter-pan-1979'].originalProductionId, null);
  assert.equal(byId['peter-pan-1979'].productionNumber, 1);
  assert.equal(byId['peter-pan-1991'].originalProductionId, 'peter-pan-1979');
  assert.equal(byId['peter-pan-1991'].productionNumber, 2);
});

test('input order does not matter — always sorts by openingDate', () => {
  const forward = assignRevivalChain([
    { id: 'a-2000', openingDate: '2000-01-01' },
    { id: 'a-2010', openingDate: '2010-01-01' },
    { id: 'a-2020', openingDate: '2020-01-01' },
  ]);
  const shuffled = assignRevivalChain([
    { id: 'a-2020', openingDate: '2020-01-01' },
    { id: 'a-2000', openingDate: '2000-01-01' },
    { id: 'a-2010', openingDate: '2010-01-01' },
  ]);
  const norm = (arr) => Object.fromEntries(arr.map(r => [r.id, r]));
  assert.deepEqual(norm(forward), norm(shuffled));
});

test('a later-discovered but earlier-dated production becomes the new original and renumbers the rest', () => {
  // Simulates the exact bug: 2013 and 2019 already existed, then 2013 gets
  // "rediscovered" alongside a genuinely earlier 2005 production.
  const result = assignRevivalChain([
    { id: 'betrayal-2013', openingDate: '2013-01-27' },
    { id: 'betrayal-2019', openingDate: '2019-09-05' },
    { id: 'betrayal-2005', openingDate: '2005-01-01' },
  ]);
  const byId = Object.fromEntries(result.map(r => [r.id, r]));
  assert.equal(byId['betrayal-2005'].originalProductionId, null);
  assert.equal(byId['betrayal-2005'].productionNumber, 1);
  assert.equal(byId['betrayal-2013'].originalProductionId, 'betrayal-2005');
  assert.equal(byId['betrayal-2013'].productionNumber, 2);
  assert.equal(byId['betrayal-2019'].originalProductionId, 'betrayal-2005');
  assert.equal(byId['betrayal-2019'].productionNumber, 3);
});

test('missing openingDate sorts last and never becomes "the original"', () => {
  const result = assignRevivalChain([
    { id: 'x-dateless', openingDate: null },
    { id: 'x-1990', openingDate: '1990-06-01' },
  ]);
  const byId = Object.fromEntries(result.map(r => [r.id, r]));
  assert.equal(byId['x-1990'].originalProductionId, null);
  assert.equal(byId['x-dateless'].originalProductionId, 'x-1990');
});

test('single-production group: itself is the original, no self-reference', () => {
  const result = assignRevivalChain([{ id: 'solo-2024', openingDate: '2024-01-01' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].originalProductionId, null);
  assert.equal(result[0].productionNumber, 1);
});
