/**
 * BRO-2746: a combined-review file holding a co-member show's review (url names
 * only the other member, text never names this show) is excluded from scoring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guards = require('../../scripts/lib/review-guards.js');
const { isCombinedReviewOfOtherMemberOnly, explainExclusion } = guards;

const MONTH = { id: 'a-month-in-the-country-west-end-2026', title: 'A Month in the Country', venue: 'Donmar Warehouse', category: 'west-end', openingDate: '2026-08-28' };
// The 2026-09-02 incident record (text abbreviated, shape as on disk).
const incident = () => ({
  showId: MONTH.id, outletId: 'thestage', outlet: 'The Stage', criticName: 'Sam Marlowe',
  url: 'https://www.thestage.co.uk/reviews/care-review-young-vic-london-alexander-zeldin',
  fullText: '', contentTier: 'excerpt', originalScore: '4/5',
  dtliExcerpt: 'Meticulously, unflashily acted by a faultless ensemble, the minor tragedies of a care home pile up.',
  showScoreExcerpt: 'Meticulously, unflashily acted by a faultless ensemble.',
  isCombinedReview: true, combinedWith: ['care-west-end-2026'],
});

test('the incident fixture is caught and excluded', () => {
  assert.equal(isCombinedReviewOfOtherMemberOnly(incident(), MONTH), true);
  assert.equal(explainExclusion(incident(), MONTH), 'combinedReviewOfOtherMemberOnly');
});

test('a joint article whose url names both shows is kept', () => {
  const d = { ...incident(), url: 'https://www.thestage.co.uk/reviews/care-and-a-month-in-the-country-review' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), false);
});

test('text naming this show keeps it (genuine joint review)', () => {
  const d = { ...incident(), fullText: 'At the Donmar, A Month in the Country finds Turgenev fresh; meanwhile Care at the Young Vic...' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), false);
});

test('not a combined review, or url naming no member: not this predicate', () => {
  assert.equal(isCombinedReviewOfOtherMemberOnly({ ...incident(), isCombinedReview: false }, MONTH), false);
  assert.equal(isCombinedReviewOfOtherMemberOnly({ ...incident(), url: 'https://www.thestage.co.uk/reviews/roundup-2026-09' }, MONTH), false);
});

test('a human score or wrongShow clear wins', () => {
  assert.equal(isCombinedReviewOfOtherMemberOnly({ ...incident(), humanReviewScore: 70 }, MONTH), false);
  assert.equal(isCombinedReviewOfOtherMemberOnly({ ...incident(), wrongShowManualClear: true }, MONTH), false);
});

test('revival variants of the same title are not "another member"', () => {
  const d = { ...incident(), url: 'https://x.com/reviews/a-month-in-the-country-2015-review', combinedWith: ['a-month-in-the-country-2015'] };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), false);
});

test('a wrongShowOverride stamped by flag-combined-reviews itself is not a human clear', () => {
  const d = { ...incident(), wrongShowOverride: true, wrongShowOverrideReason: 'flag-combined-reviews.js: URL co-occurs across 2 show dirs — joint review' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), true);
  const human = { ...incident(), wrongShowOverride: true, wrongShowOverrideReason: 'owner: verified joint review' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(human, MONTH), false);
});

test('url naming this show without its leading article is kept', () => {
  const d = { ...incident(), url: 'https://www.thestage.co.uk/reviews/month-in-the-country-and-care-review' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MONTH), false);
});

test('a double bill reviewed with its halves in the other order is kept (2026-10-14 scoring-delta)', () => {
  const show = { id: 'the-human-voice-the-seven-deadly-sins-west-end-2026', title: 'The Human Voice / The Seven Deadly Sins', venue: 'Charing Cross Theatre' };
  const d = {
    url: 'https://www.londontheatre1.com/reviews/the-seven-deadly-sins-the-human-voice/',
    fullText: '', dtliExcerpt: 'A bold pairing of Weill and Poulenc.',
    isCombinedReview: true, combinedWith: ['the-seven-deadly-sins-west-end-2026'],
  };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, show), false);
});

test('a joint review whose url names a distinctive word of this title is kept (Bloomberg Orphans + Jekyll & Hyde)', () => {
  const show = { id: 'jekyll-and-hyde-2013', title: 'Jekyll & Hyde', venue: 'Marquis Theatre' };
  const d = {
    url: 'https://www.bloomberg.com/news/2013-04-19/skinny-baldwin-pales-in-orphans-booming-hyde-stage.html',
    fullText: '', isCombinedReview: true, combinedWith: ['orphans-2013'],
  };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, show), false);
});

// BRO-6569: an opaque url (FT /content/<uuid>) names no show, so the text decides.
const MIKE = { id: 'magic-mike-live-west-end-2021', title: 'Magic Mike Live', category: 'west-end' };
const titleOf = new Map([['the-tempest-west-end-2024', 'The Tempest'], ['lend-me-a-tenor-2010', 'Lend Me a Tenor']]);
const ftTempest = () => ({
  showId: MIKE.id, outletId: 'financialtimes', criticName: 'Sarah Hemming',
  url: 'https://www.ft.com/content/00e3e54e-ba2f-4413-9c52-fbe1da1c81d4', fullText: '',
  dtliExcerpt: 'Sigourney Weaver stars in a bleakly spectacular The Tempest. Production at the Theatre Royal, Drury Lane is visually striking but lacks emotional depth, and the staging of the storm is a dazzling opening.',
  isCombinedReview: true, combinedWith: ['the-tempest-west-end-2024'],
});

test('opaque url: text naming only the co-member is excluded (FT Tempest on Magic Mike Live)', () => {
  assert.equal(isCombinedReviewOfOtherMemberOnly(ftTempest(), MIKE, { titleOf }), true);
});

test('opaque url: text naming this show too is kept', () => {
  const d = { ...ftTempest(), dtliExcerpt: ftTempest().dtliExcerpt + ' Next door, Magic Mike Live keeps the hen parties happy all night long.' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MIKE, { titleOf }), false);
});

test('opaque url: a title below the variant minimum ("Red") cannot be read as unnamed', () => {
  const RED = { id: 'red-2010', title: 'Red' };
  const d = { ...ftTempest(), showId: 'red-2010', combinedWith: ['lend-me-a-tenor-2010'],
    dtliExcerpt: 'Lend Me a Tenor is a farce of slamming doors; the Rothko play next door is a study of a painter at war with his own success, and both are worth seeing this season.' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, RED, { titleOf }), false);
});

test('opaque url: a shared index url (more than 3 co-members) is not judged by text', () => {
  const d = { ...ftTempest(), combinedWith: ['the-tempest-west-end-2024', 'a', 'b', 'c'] };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MIKE, { titleOf }), false);
});

test('opaque url: a one-word co-member title used as an ordinary word does not exclude (review finding)', () => {
  const d = { ...ftTempest(), combinedWith: ['company-west-end-2018'],
    dtliExcerpt: 'The show brings Magic Mike to the Hippodrome. The company of dancers is drilled and tireless, the company never flags, and the hen parties scream at every routine.' };
  const tm = new Map([['company-west-end-2018', 'Company']]);
  // Text names the show only as "Magic Mike" (not its full title), so namesOwn is false and only the member rule decides.
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MIKE, { titleOf: tm }), false);
});

test('opaque url: a uuid whose groups are letters-only hex still counts as opaque', () => {
  const d = { ...ftTempest(), url: 'https://www.ft.com/content/deadbeef-cafe-4bff-a896-6a9c4d1bf3d3' };
  assert.equal(isCombinedReviewOfOtherMemberOnly(d, MIKE, { titleOf }), true);
});
