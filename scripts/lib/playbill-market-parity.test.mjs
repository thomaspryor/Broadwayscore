import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const matcher = require('./playbill-title-match.js');
const original = matcher.isLondonPlaybillMarket;
let forced;
let calls = 0;
// Capture both consumers' use of the exported function, including its result.
matcher.isLondonPlaybillMarket = (tail) => {
  calls++;
  return forced ?? original(tail);
};
const { scorePlaybillUrl } = require('../validate-show-venue.js');
const { isCrossMarketPlaybillUrl } = require('./playbill-url-market.js');
matcher.isLondonPlaybillMarket = original;

const P = 'https://playbill.com/production/';
const cases = [
  ['A London Story', 'a-london-story-broadway-lyceum-theatre-2024', false],
  ['Cabaret', 'cabaret-london-playhouse-theatre-2021', true],
  ['Cabaret', 'cabaret-west-end-playhouse-theatre-2021', true],
  ['Cabaret', 'cabaret-off-london-playhouse-theatre-2021', true],
  ['Othello', 'othello-off-broadway-west-end-theatre-2026', false],
];

test('title and venue words do not decide the London market', () => {
  for (const [title, path, london] of cases) {
    const show = { title, category: 'broadway' };
    const match = matcher.playbillUrlTitleMatch(P + path, show);
    assert.equal(match.match, true, path);
    assert.equal(original(match.marketTail), london, path);
    assert.equal(isCrossMarketPlaybillUrl(P + path, show), london, path);
    assert.equal(scorePlaybillUrl(P + path, show) === null, london, path);
  }
});

test('scorer and cache check both consume the shared London decision', () => {
  const url = P + 'cabaret-london-playhouse-theatre-2021';
  const show = { title: 'Cabaret', category: 'broadway' };
  try {
    for (const decision of [true, false]) {
      forced = decision;
      calls = 0;
      assert.equal(scorePlaybillUrl(url, show) === null, decision);
      assert.ok(calls > 0, 'scorer must call the shared predicate');
      calls = 0;
      assert.equal(isCrossMarketPlaybillUrl(url, show), decision);
      assert.ok(calls > 0, 'cache check must call the shared predicate');
    }
  } finally {
    forced = undefined;
  }
});
