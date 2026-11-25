// Tests for joint-split-resweep.js (BRO-8292). Invented prose; shapes only.
// Run: node --test scripts/lib/joint-split-resweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickWholeText, replanJointParent, replanReconstructed, isJointParent } = require('./joint-split-resweep.js');

const SHOWS = [
  { id: 'wanderers-off-broadway-2023', title: 'Wanderers', category: 'off-broadway', openingDate: '2023-02-14' },
  { id: 'leopoldstadt-2022', title: 'Leopoldstadt', category: 'broadway', openingDate: '2022-10-02' },
];
const filler = (topic, n) => Array.from({ length: n }, (_, i) =>
  `The ${topic} passage number ${i + 1} moves along at a patient, deliberate pace that the cast keeps up with real care.`).join(' ');

// BRO-8272 shape (Wanderers/Leopoldstadt): a lede comparing to the cousin, a closing listing naming both.
const WHOLE = [
  `Wanderers , a new family drama downtown, shares much with its cousin Leopoldstadt : one act. ${filler('setting', 14)}`,
  `Why is this called Wanderers ? ${filler('verdict', 8)} Wanderers has some sharp observations, but I might have enjoyed it more with fewer questions.`,
  'Wanderers Through April 2, 2023 Roundabout Theatre Company Laura Pels Theatre, 111 West 46th Street, New York NY Tickets online: example.org Leopoldstadt . Wanderers Through April 2, 2023 Roundabout Theatre Company.',
].join(' ');
const parent = (over = {}) => ({
  showId: 'wanderers-off-broadway-2023', url: 'https://example.com/w', outletId: 'tb', criticName: 'C',
  contentTier: 'complete', publishDate: '2023-02-16',
  fullText: WHOLE.slice(0, 900), multiShowSplitParent: true, multiShowSplitAnchorKind: 'joint',
  multiShowSplitProcessed: '2023-03-01T00:00:00Z', multiShowSplitChildShowIds: ['leopoldstadt-2022'],
  multiShowSplitOriginalLength: WHOLE.length, multiShowSplitTextLength: 900, ...over,
});

test('isJointParent only matches joint-anchored parents', () => {
  assert.equal(isJointParent(parent()), true);
  assert.equal(isJointParent(parent({ multiShowSplitAnchorKind: 'header' })), false);
  assert.equal(isJointParent({ multiShowSplitChild: true }), false);
});

test('pickWholeText prefers current fullText at original length, else history match', () => {
  assert.equal(pickWholeText(parent({ fullText: WHOLE })).source, 'current');
  const h = [{ fullText: WHOLE.slice(0, 900) }, { fullText: WHOLE }];
  assert.equal(pickWholeText(parent(), h).source, 'history:1:fullText');
  assert.equal(pickWholeText(parent(), [{ fullText: WHOLE.slice(0, 900) }]), null);
});

test('a lede-comparison mis-split re-plans as lede-cousin from git history', () => {
  const r = replanJointParent(parent(), [{ fullText: WHOLE }], SHOWS);
  assert.equal(r.verdict, 'lede-cousin');
  assert.equal(r.holdsWhole, false);
});

test('a planner null for another reason is no-split (keep), not a repair', () => {
  const other = `Go for the acting this week. ${filler('falstaff', 14)} Leopoldstadt is long. ${filler('pitch', 12)} Wanderers is short.`;
  const r = replanJointParent(parent({ multiShowSplitOriginalLength: other.length }), [{ fullText: other }], SHOWS);
  assert.equal(r.verdict, 'no-split');
});

test('reconstructed sections: refetch when an order is a lede cousin', () => {
  const cut = WHOLE.indexOf('Why is this');
  const child = { multiShowSplitChild: true, fullText: WHOLE.slice(0, cut).trim() };
  const r = replanReconstructed(parent({ fullText: WHOLE.slice(cut) }), [child], SHOWS);
  assert.equal(r.orders, 2);
  assert.equal(r.verdict, 'refetch');
});

test('no whole text anywhere is reported, not guessed', () => {
  assert.equal(replanJointParent(parent(), [], SHOWS).verdict, 'no-whole-text');
});
