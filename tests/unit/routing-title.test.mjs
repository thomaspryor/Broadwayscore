import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeRoutingTitle } = require('../../scripts/lib/routing-title');
const { normalizeTitle, buildSiblingIndex } = require('../../scripts/lib/market-routing');
const { normalizeShowTitle, buildSiblingOpeningsMap } = require('../../scripts/lib/cross-market-contamination');
const { normalizeTitle: normalizeDiscoveryTitle } = require('../../scripts/lib/title-match');

test('runtime and contamination audits use the same normalization function', () => {
  assert.equal(normalizeTitle, normalizeRoutingTitle);
  assert.equal(normalizeShowTitle, normalizeRoutingTitle);
});

test('routing folds case, edge whitespace, and its existing punctuation only', () => {
  assert.equal(normalizeRoutingTitle('  Oh, Mary!  '), 'oh mary');
  assert.equal(normalizeRoutingTitle('"Who\'s Afraid?".'), 'whos afraid');
  for (const missing of [null, undefined, '']) {
    assert.equal(normalizeRoutingTitle(missing), '');
  }
});

for (const [left, right] of [
  ['A Christmas Carol', 'A Christmas Carol the Musical'],
  ['Othello', 'Othello (Bedlam)'],
  ['The Wild Party', 'Wild Party'],
  ['Les Misérables', 'Les Miserables'],
  ['Bonnie & Clyde', 'Bonnie and Clyde'],
  ['Grown-Ups', 'Grownups'],
  ['Show [2024]', 'Show'],
  ['Sunset Blvd.', 'Sunset Boulevard'],
]) {
  test(`discovery variants stay separate routing families: ${left} / ${right}`, () => {
    assert.equal(normalizeDiscoveryTitle(left), normalizeDiscoveryTitle(right));
    assert.notEqual(normalizeRoutingTitle(left), normalizeRoutingTitle(right));

    const shows = [
      { id: 'left-2024', title: left, openingDate: '2024-01-01' },
      { id: 'right-2025', title: right, openingDate: '2025-01-01' },
    ];
    assert.equal(buildSiblingIndex(shows).size, 0);
    const openings = buildSiblingOpeningsMap(shows, s => new Date(s));
    assert.deepEqual(openings.get('left-2024'), []);
    assert.deepEqual(openings.get('right-2025'), []);
  });
}

test('punctuation variants remain siblings in both runtime and contamination audits', () => {
  const shows = [
    { id: 'mary-2024', title: 'Oh, Mary!', openingDate: '2024-01-01' },
    { id: 'mary-2025', title: 'oh mary', openingDate: '2025-01-01' },
  ];
  const index = buildSiblingIndex(shows);
  assert.deepEqual(index.get('mary-2024').siblings.map(s => s.id), ['mary-2025']);
  const openings = buildSiblingOpeningsMap(shows, s => new Date(s));
  assert.deepEqual(openings.get('mary-2024'), [Date.parse('2025-01-01')]);
});

test('routing groups decimal punctuation variants that discovery keeps separate', () => {
  // Real catalog pair: the broad matcher inserts a space for the decimal.
  // Its relation is therefore not a strict superset of routing equivalence.
  const shows = [
    { id: 'psychosis-2025', title: '4.48 Psychosis', openingDate: '2025-06-12' },
    { id: 'psychosis-2026', title: '448 Psychosis', openingDate: '2026-01-01' },
  ];
  assert.notEqual(normalizeDiscoveryTitle(shows[0].title), normalizeDiscoveryTitle(shows[1].title));
  assert.equal(normalizeRoutingTitle(shows[0].title), normalizeRoutingTitle(shows[1].title));
  assert.deepEqual(buildSiblingIndex(shows).get('psychosis-2025').siblings.map(s => s.id), ['psychosis-2026']);
  assert.deepEqual(buildSiblingOpeningsMap(shows, s => new Date(s)).get('psychosis-2025'), [Date.parse('2026-01-01')]);
});
