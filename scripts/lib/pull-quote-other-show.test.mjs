// BRO-8326: a pull quote must come from the part of the article about THIS show.
// Synthetic text shaped like the two Come From Away reviews Dan reported on 2026-11-25
// (real review text is private): a Village Voice column covering two shows, and an Out
// Magazine news column whose Come From Away blurb comes 3,900 characters after its lede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { quoteInOtherShowPassage, buildEvidenceIndex } = require('./pull-quote-other-show.js');
const guards = require('./pull-quote-guards.js');
const { useShowsFixture } = require('./shows-json-fixture.js');

const cfa = {
  id: 'come-from-away-2017', title: 'Come From Away', openingDate: '2017-03-12',
  cast: [{ name: 'Jenn Colella' }, { name: 'Chad Kimball' }],
  creativeTeam: [{ name: 'Irene Sankoff' }, { name: 'David Hein' }, { name: 'Christopher Ashley' }],
};
const price = {
  id: 'the-price-2017', title: 'The Price', openingDate: '2017-03-16',
  cast: [{ name: 'Mark Ruffalo' }, { name: 'Danny DeVito' }, { name: 'Tony Shalhoub' }],
  creativeTeam: [{ name: 'Terry Kinney' }],
};
// BRO-8107: lookups by id read this fixture, never the live data/shows.json.
process.on('exit', useShowsFixture([cfa, price]));
const index = buildEvidenceIndex([cfa, price, { id: 'sweat-2017', title: 'Sweat', openingDate: '2017-03-26', cast: [] }]);

const filler = (n) => ' The evening moves briskly and the staging keeps every scene in motion.'.repeat(n);
const QUOTE_PRICE = "Buloff's comedy was gigantic; DeVito's feisty, energetic extravagance makes him loom nearly as large.";
const vv = {
  showId: cfa.id, showTitle: cfa.title, publishDate: '2017-03-17',
  fullText: `'Come From Away' and 'The Price' Weigh the Pros and Cons.${filler(6)} Come From Away tells the story of Gander. `
    + `Ashley's cast moves like a single organism, and Jenn Colella is superb.${filler(6)}\n\n`
    + `The Price (American Airlines Theatre) is Arthur Miller's argument about family. The cop calls in a furniture dealer (Danny DeVito) whose bargaining soothes tensions. `
    + `The play has a long history, since John Stix's 1979 version, with Joseph Buloff as the furniture dealer. ${QUOTE_PRICE} As the play's old arguments mount, it grows dense.`,
};

test('Village Voice: the paragraph on The Price is rejected on Come From Away', () => {
  const r = quoteInOtherShowPassage(QUOTE_PRICE, vv, cfa, index);
  assert.equal(r && r.rule, 'other-show');
});

test('Village Voice: a Come From Away sentence from the same column is kept', () => {
  assert.equal(quoteInOtherShowPassage("Ashley's cast moves like a single organism, and Jenn Colella is superb.", vv, cfa, index), null);
});

test('the same paragraph is fine on the show it is about', () => {
  const asPrice = { ...vv, showId: price.id, showTitle: price.title };
  assert.equal(quoteInOtherShowPassage(QUOTE_PRICE, asPrice, price, index), null);
});

test('a performer from a show that opened months away is not an other-show signal', () => {
  const old = { ...vv, publishDate: '2016-01-05' }; // The Price opened 14 months later
  assert.equal(quoteInOtherShowPassage(QUOTE_PRICE, old, cfa, index), null);
});

test('naming another performer in a comparison is fine when this show is named in between', () => {
  const text = `${vv.fullText.slice(0, 40)}${filler(4)} The Price opened this week. Come From Away is warmer than anything Danny DeVito has done.${filler(2)}`;
  const d = { ...vv, fullText: text };
  assert.equal(quoteInOtherShowPassage('Come From Away is warmer than anything Danny DeVito has done.', d, cfa, index), null);
});

const musto = {
  showId: cfa.id, showTitle: cfa.title, publishDate: '2017-03-13', isNonReview: true, nonReviewType: 'news',
  fullText: `Charlie Hides is the oldest Drag Race contestant ever. Friday night at the Triad, his TransAtlantic Dame show confirmed that he’s gifted and riotously funny.${filler(30)}`
    + ` Not only is Come From Away a timely show about kind people welcoming foreigners, it’s also a feel good musical about 9/11. `
    + `The musical manages to tell this story without mawkish sentimentality or manipulation, keeping things moving with a fluid staging.`,
};

test('Out Magazine: the lede of a news column is rejected when the show comes up 3,900 characters later', () => {
  const r = quoteInOtherShowPassage('Friday night at the Triad, his TransAtlantic Dame show confirmed that he’s gifted and riotously funny.', musto, cfa, index);
  assert.equal(r && r.rule, 'before-show');
});

test('Out Magazine: the blurb about the show is kept', () => {
  assert.equal(quoteInOtherShowPassage('The musical manages to tell this story without mawkish sentimentality or manipulation, keeping things moving with a fluid staging.', musto, cfa, index), null);
});

test('an ordinary review that opens before it names the show is untouched', () => {
  const review = { ...musto, isNonReview: false };
  assert.equal(quoteInOtherShowPassage('Friday night at the Triad, his TransAtlantic Dame show confirmed that he’s gifted and riotously funny.', review, cfa, index), null);
});

test('hasUsableLlmQuote (shows fixture index) drops a stored other-show quote so the extractor re-extracts it', () => {
  assert.equal(guards.hasUsableLlmQuote({ ...vv, llmPullQuote: QUOTE_PRICE }), false);
  assert.equal(guards.hasUsableLlmQuote({ ...vv, llmPullQuote: "Ashley's cast moves like a single organism, and Jenn Colella is superb." }), true);
});

test('short or missing input never throws and never flags', () => {
  assert.equal(quoteInOtherShowPassage('', vv, cfa, index), null);
  assert.equal(quoteInOtherShowPassage('x', { fullText: 'short' }, cfa, index), null);
  assert.equal(quoteInOtherShowPassage('a quote long enough to matter here', { fullText: vv.fullText }, { title: '' }, index), null);
});

// Review findings (ship-check, BRO-8326)
test('a quote that cannot be placed in the article is kept even when it names another show\'s performer', () => {
  const unplaced = 'Danny DeVito is nothing like the stagey furniture dealer anyone remembers.'; // not in vv.fullText
  assert.equal(quoteInOtherShowPassage(unplaced, vv, cfa, index), null);
});

test('hasUsableLlmQuote and the rebuild path agree: the show is looked up by id when not passed', () => {
  const rec = { ...vv, showId: 'come-from-away-2017', llmPullQuote: "Ashley's cast moves like a single organism, and Jenn Colella is superb." };
  assert.equal(guards.quoteFromOtherShowPassage(rec.llmPullQuote, rec), guards.quoteFromOtherShowPassage(rec.llmPullQuote, rec, cfa));
  assert.equal(guards.quoteFromOtherShowPassage(QUOTE_PRICE, rec) === null, guards.quoteFromOtherShowPassage(QUOTE_PRICE, rec, cfa) === null);
});

test('a short own title does not hide a different show whose title merely contains it', () => {
  const rent = { id: 'rent', title: 'Rent', openingDate: '2017-03-12', cast: [] };
  const current = { id: 'current', title: 'The Current War Show', openingDate: '2017-03-16', cast: [{ name: 'Alexander Hanson' }] };
  const idx = buildEvidenceIndex([rent, current]);
  const q = "Alexander Hanson's patient, funny performance is the best thing here and it never flags.";
  const d = { showId: 'rent', showTitle: 'Rent', publishDate: '2017-03-17',
    fullText: `Rent arrives. ${filler(4)} The Current War Show is the other opening. ${q}${filler(3)}` };
  assert.equal((quoteInOtherShowPassage(q, d, rent, idx) || {}).rule, 'other-show');
});
