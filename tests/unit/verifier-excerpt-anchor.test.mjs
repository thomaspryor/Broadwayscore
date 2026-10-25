// BRO-5344: verifierExcerpt() skips an excerpt that is not a quote of a complete fullText.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifierExcerpt, isQuoteOfFullText } = require('../../scripts/lib/excerpt-fields.js');

const SKIP = { skipNonQuotes: true };
const body = 'Lincoln Center Theater has staged a long, careful and affectionate version of the memoir. '.repeat(6)
  + 'The songs are tuneful and the dancing is energetic, but the book is thin and the second act drags badly.';
const base = { contentTier: 'complete', fullText: body };

test('paraphrase absent from complete fullText is skipped', () => {
  const row = { ...base, dtliExcerpt: "Lincoln Center Theater's production of 'Act One' is a touching tribute to Moss Hart" };
  assert.equal(verifierExcerpt(row, SKIP), '');
});

test('next excerpt field is used when the first is a paraphrase', () => {
  const real = 'The songs are tuneful and the dancing is energetic, but the book is thin';
  assert.equal(verifierExcerpt({ ...base, dtliExcerpt: 'A wholly unrelated summary of another show entirely here', showScoreExcerpt: real }, SKIP), real);
});

test('real quote, with quote marks and an ellipsis, is kept', () => {
  const row = { ...base, dtliExcerpt: "'The songs are tuneful and the dancing is energetic, but the book is thin'...and more" };
  assert.ok(verifierExcerpt(row, SKIP));
});

test('stitched fragments count when any fragment matches', () => {
  const row = { ...base, dtliExcerpt: 'Complexly layered and brilliant overall...the book is thin and the second act drags' };
  assert.ok(verifierExcerpt(row, SKIP));
});

test('no judgement without a complete fullText', () => {
  const ex = 'Totally different words that appear nowhere in the stored text at all';
  assert.equal(isQuoteOfFullText(ex, { contentTier: 'excerpt', fullText: body }), true);
  assert.equal(isQuoteOfFullText(ex, { contentTier: 'complete', fullText: 'short' }), true);
  assert.equal(verifierExcerpt({ contentTier: 'stub', fullText: 'x', dtliExcerpt: ex }), ex);
});

test('short excerpts (under 5 words) are not judged', () => {
  assert.equal(isQuoteOfFullText('Great show', base), true);
});

test('default call keeps the first excerpt (reverify scripts verify the stored text itself)', () => {
  const row = { ...base, dtliExcerpt: 'A wholly unrelated summary of another show entirely here' };
  assert.equal(verifierExcerpt(row), row.dtliExcerpt);
});

test('spaced ellipsis, bracketed inserts and entities do not read as non-quotes', () => {
  const t = { contentTier: 'complete', fullText: 'He is a wonderful actor and the show is a triumph of staging. '.repeat(8) + 'Rock & roll never dies.' };
  assert.equal(isQuoteOfFullText('Noise that is absent from text here . . . the show is a triumph of staging', t), true);
  assert.equal(isQuoteOfFullText('[Smith] is a wonderful actor and the show is a triumph', t), true);
  assert.equal(isQuoteOfFullText('Rock &amp; roll never dies', { ...t, fullText: t.fullText + ' ' }), true);
});

test('numeric and curly entities decode to the apostrophe', () => {
  const t = { contentTier: 'complete', fullText: "It's a wonderful night at the theater and the cast is superb. ".repeat(8) };
  assert.equal(isQuoteOfFullText('It&#39;s a wonderful night at the theater and the', t), true);
  assert.equal(isQuoteOfFullText('It&rsquo;s a wonderful night at the theater and the', t), true);
});

test('every excerpt failing returns empty; legacy web-search rows still return empty', () => {
  const row = { ...base, dtliExcerpt: 'Unrelated words that never occur in this review text', bwwExcerpt: 'Another unrelated sentence from some other production entirely' };
  assert.equal(verifierExcerpt(row, SKIP), '');
});

test('accented letters fold instead of shredding words (Les Misérables)', () => {
  const t = { contentTier: 'complete', fullText: 'Les Misérables returns to Broadway with a thundering, utterly moving new staging tonight. '.repeat(6) };
  assert.equal(isQuoteOfFullText('Les Miserables returns to Broadway with a thundering', t), true);
});
