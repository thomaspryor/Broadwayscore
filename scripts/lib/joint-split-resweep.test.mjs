// Tests for joint-split-resweep.js (BRO-8292). Invented prose; shapes only.
// Run: node --test scripts/lib/joint-split-resweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickWholeText, replanJointParent, isJointParent } = require('./joint-split-resweep.js');

const SHOWS = [
  { id: 'wanderers-off-broadway-2023', title: 'Wanderers', category: 'off-broadway', openingDate: '2023-02-14' },
  { id: 'leopoldstadt-2022', title: 'Leopoldstadt', category: 'broadway', openingDate: '2022-10-02' },
];
const filler = (topic, n) => Array.from({ length: n }, (_, i) =>
  `The ${topic} passage number ${i + 1} moves along at a patient, deliberate pace that the cast keeps up with real care.`).join(' ');

// BRO-8272 shape: one Wanderers review whose lede only compares to Leopoldstadt.
const WHOLE = `Wanderers is a cousin of Leopoldstadt, another family saga spanning generations, but it tells a smaller story. ${filler('Wanderers', 24)} Wanderers runs through March at the Laura Pels.`;
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

test('a lede-comparison mis-split re-plans as no-split from git history', () => {
  const r = replanJointParent(parent(), [{ fullText: WHOLE }], SHOWS);
  assert.equal(r.verdict, 'no-split');
  assert.equal(r.holdsWhole, false);
});

test('no whole text anywhere is reported, not guessed', () => {
  assert.equal(replanJointParent(parent(), [], SHOWS).verdict, 'no-whole-text');
});
