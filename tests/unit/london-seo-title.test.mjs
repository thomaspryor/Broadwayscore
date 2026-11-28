// BRO-8085: West End / Off-West End show titles carry "London" so a West End
// production with a Broadway twin does not share its Broadway page's <title>.
// Pure helper checks only (blocking lane). Real data and the final page titles:
// london-seo-title-live-data.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { londonTitleNeedsSuffix } from '../../src/lib/market-utils';

test('London markets need the suffix', () => {
  assert.equal(londonTitleNeedsSuffix('Hamilton', 'west-end'), true);
  assert.equal(londonTitleNeedsSuffix('ABBA Voyage', 'off-west-end'), true);
  assert.equal(londonTitleNeedsSuffix('Oliver!', 'west-end'), true);
});

test('titles already naming London or the West End do not', () => {
  for (const t of ['London Road', 'Strictly Come Dancing - London', 'West End Girls', 'West-End Girls', 'Westend Story']) {
    assert.equal(londonTitleNeedsSuffix(t, 'west-end'), false, t);
  }
});

test('words that only contain the letters are not a match', () => {
  assert.equal(londonTitleNeedsSuffix('West Endeavour', 'west-end'), true);
  assert.equal(londonTitleNeedsSuffix('Londonderry Air', 'off-west-end'), true);
});

test('non-London markets never need it', () => {
  for (const c of ['broadway', 'off-broadway', 'regional', 'tour', undefined]) {
    assert.equal(londonTitleNeedsSuffix('Hamilton', c), false, String(c));
  }
});
