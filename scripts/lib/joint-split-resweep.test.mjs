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
  const U = 'https://example.com/w';
  const h = [{ url: U, fullText: WHOLE.slice(0, 900) }, { url: U, fullText: WHOLE }];
  assert.equal(pickWholeText(parent(), h).source, 'history:1:fullText');
  assert.equal(pickWholeText(parent(), [{ url: U, fullText: WHOLE.slice(0, 900) }]), null);
});

test('pickWholeText ignores a revision that held another article in the same slot', () => {
  assert.equal(pickWholeText(parent(), [{ url: 'https://example.com/other', fullText: WHOLE }]), null);
  assert.equal(pickWholeText(parent(), [{ fullText: WHOLE }]), null, 'no url = unknown provenance');
});

test('pickWholeText reads a trimmed sibling\'s multiShowWholeArticleText for the same URL', () => {
  const sib = { showId: 'leopoldstadt-2022', url: 'https://example.com/w', multiShowWholeArticleText: WHOLE };
  assert.match(pickWholeText(parent(), [], [sib]).source, /^child:leopoldstadt-2022/);
  assert.equal(pickWholeText(parent(), [], [{ ...sib, url: 'https://example.com/x' }]), null);
});

test('a partial content tier on the trimmed section does not hide the recovered article', () => {
  const r = replanJointParent(parent({ contentTier: 'truncated' }), [{ url: 'https://example.com/w', fullText: WHOLE }], SHOWS);
  assert.equal(r.verdict, 'lede-cousin');
});

test('a lede-comparison mis-split re-plans as lede-cousin from git history', () => {
  const r = replanJointParent(parent(), [{ url: 'https://example.com/w', fullText: WHOLE }], SHOWS);
  assert.equal(r.verdict, 'lede-cousin');
  assert.equal(r.holdsWhole, false);
});

test('a planner null for another reason is no-split (keep), not a repair', () => {
  const other = `Go for the acting this week. ${filler('falstaff', 14)} Leopoldstadt is long. ${filler('pitch', 12)} Wanderers is short.`;
  const r = replanJointParent(parent({ multiShowSplitOriginalLength: other.length }), [{ url: 'https://example.com/w', fullText: other }], SHOWS);
  assert.equal(r.verdict, 'no-split');
});

test('reconstructed sections: refetch when an order is a lede cousin', () => {
  const cut = WHOLE.indexOf('Why is this');
  const child = { multiShowSplitChild: true, multiShowSplitParentShowId: 'wanderers-off-broadway-2023', url: 'https://example.com/w', fullText: WHOLE.slice(0, cut).trim() };
  const r = replanReconstructed(parent({ fullText: WHOLE.slice(cut) }), [child], SHOWS);
  assert.equal(r.orders, 2);
  assert.equal(r.verdict, 'refetch');
  assert.equal(replanReconstructed(parent({ fullText: WHOLE.slice(cut) }), [{ ...child, multiShowSplitParentShowId: 'someone-else' }], SHOWS).verdict, 'no-whole-text');
});

test('no whole text anywhere is reported, not guessed', () => {
  assert.equal(replanJointParent(parent(), [], SHOWS).verdict, 'no-whole-text');
});
