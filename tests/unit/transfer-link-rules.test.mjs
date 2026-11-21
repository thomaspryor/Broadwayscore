/**
 * Which categories may carry transferOf / transferredTo (BRO-6400).
 * Regional tryout pairs keep working; Broadway <-> West End transfers are now
 * allowed in either direction; same-market and tour links stay refused.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transferLinkCategoryError, isCrossMarketPair } = require('../../scripts/lib/transfer-link-rules.js');

const row = (id, category) => ({ id, category });
const regional = row('the-outsiders-world-premiere-regional-2023', 'regional');
const bway = row('oedipus-2025', 'broadway');
const we = row('oedipus-west-end-2024', 'west-end');
const ob = row('some-off-broadway-2025', 'off-broadway');
const owe = row('some-off-west-end-2025', 'off-west-end');
const tour = row('some-tour-2025', 'tour');

test('regional tryout pair stays valid', () => {
  assert.equal(transferLinkCategoryError(row('the-outsiders-2024', 'broadway'), 'transferOf', regional), null);
  assert.equal(transferLinkCategoryError(regional, 'transferredTo', row('the-outsiders-2024', 'broadway')), null);
  // UK regional -> West End (detect-regional-transfers.js) too.
  assert.equal(transferLinkCategoryError(regional, 'transferredTo', we), null);
  assert.equal(transferLinkCategoryError(we, 'transferOf', regional), null);
});

test('West End -> Broadway and Broadway -> West End pairs are valid', () => {
  assert.equal(transferLinkCategoryError(bway, 'transferOf', we), null);
  assert.equal(transferLinkCategoryError(we, 'transferredTo', bway), null);
  assert.equal(transferLinkCategoryError(we, 'transferOf', bway), null);
  assert.equal(transferLinkCategoryError(bway, 'transferredTo', we), null);
  assert.equal(transferLinkCategoryError(ob, 'transferOf', owe), null);
});

test('same-market and tour links are refused', () => {
  assert.match(transferLinkCategoryError(bway, 'transferOf', ob), /other market/);
  assert.match(transferLinkCategoryError(we, 'transferOf', owe), /other market/);
  assert.match(transferLinkCategoryError(bway, 'transferredTo', ob), /only regional tryouts/);
  assert.match(transferLinkCategoryError(tour, 'transferOf', we), /other market/);
  assert.match(transferLinkCategoryError(tour, 'transferredTo', we), /only regional tryouts/);
});

test('isCrossMarketPair ignores regional and missing rows', () => {
  assert.equal(isCrossMarketPair(regional, bway), false);
  assert.equal(isCrossMarketPair(bway, null), false);
  assert.equal(isCrossMarketPair(owe, bway), true);
});

const { transferLinkProblems } = require('../../scripts/lib/transfer-link-rules.js');
const { applyDataEdit, dataEditAllowProblem } = require('../../scripts/lib/data-edit-action.js');

test('transferLinkProblems: reciprocal cross-market pair passes, one-way and same-market fail', () => {
  const ok = [{ ...we, transferredTo: bway.id }, { ...bway, transferOf: we.id }];
  assert.deepEqual(transferLinkProblems(ok), []);
  const oneWay = [{ ...we, transferredTo: bway.id }, { ...bway }];
  assert.match(transferLinkProblems(oneWay)[0], /not reciprocated/);
  const sameMarket = [{ ...bway, transferOf: ob.id }, { ...ob, transferredTo: bway.id }];
  assert.equal(transferLinkProblems(sameMarket).length, 2);
  assert.match(transferLinkProblems([{ ...bway, transferOf: 'gone' }])[0], /does not reference/);
});

test('approved-fix plans may set transfer links, with the same pair rule', () => {
  assert.equal(dataEditAllowProblem({ file: 'shows.json', field: 'transferOf' }), null);
  assert.equal(dataEditAllowProblem({ file: 'shows.json', field: 'transferredTo' }), null);
  const data = { shows: [{ ...we, title: 'Oedipus', status: 'closed' }, { ...bway, title: 'Oedipus', status: 'closed' }, { ...ob, title: 'X', status: 'closed' }] };
  const set = (showId, field, newValue) => applyDataEdit(data, { file: 'shows.json', showId, field, oldValue: null, newValue });
  assert.equal(set(bway.id, 'transferOf', we.id).ok, true);
  assert.equal(set(we.id, 'transferredTo', bway.id).ok, true);
  assert.deepEqual(transferLinkProblems(data.shows), []);
  assert.match(set(ob.id, 'transferOf', 'nope').reason, /no show/);
  assert.match(set(ob.id, 'transferOf', ob.id).reason, /itself/);
  assert.match(set(ob.id, 'transferOf', bway.id).reason, /other market/);
  assert.match(set(ob.id, 'transferOf', 42).reason, /show id string/);
});
