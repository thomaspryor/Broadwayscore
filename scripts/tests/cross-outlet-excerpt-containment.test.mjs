/**
 * cross-outlet-excerpt-containment.test.mjs — BRO-7663 pair rule + BRO-7684 show-dir rule.
 *
 * A bylineless, url-less aggregator quote whose words sit (>=85% trigram
 * containment) inside another outlet's fullText is that review re-filed under
 * the wrong outlet (BRO-7663). Only the weekly detect-cross-outlet-duplicates.js
 * flagged it, so the quote counted as a second review for up to a week. The
 * rebuild now flags it in the same run, with no LLM, via the real
 * excerptContainmentFlags() (pipeline proof: cross-outlet-excerpt-containment-rebuild.test.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const { excerptContainment, excerptCopySide, excerptContainmentFlags, applyExcerptContainmentFlag } = require(path.join(ROOT, 'scripts/lib/cross-outlet-group.js'));

// BRO-7663: an aggregator excerpt filed under the wrong outlet must pair with the
// fullText it was lifted from (trigram Jaccard alone scored it ~3%).
test('BRO-7663: excerptContainment / excerptCopySide pair rule', () => {
  const filler = Array.from({ length: 400 }, (_, i) => `word${i} filler sentence about staging`).join(' ');
  const quote = 'In the end what stands out most is that while the mothers quarrel over gardening approaches their sons romance is a total non-issue for everyone onstage tonight.';
  const full = `${filler} ${quote} ${filler}`;

  // 1. Excerpt fully inside a long review: contained, excerpt side is the copy.
  assert.equal(excerptContainment(quote, full), 100);
  const ex = { text: quote, textSource: 'excerpts' };
  const ft = { text: full, textSource: 'fullText' };
  assert.deepEqual(excerptCopySide(ex, ft), { copy: 'a', containment: 100 });
  assert.deepEqual(excerptCopySide(ft, ex), { copy: 'b', containment: 100 });

  // 2. Curly vs straight apostrophes still match.
  assert.equal(excerptContainment('It’s probably a high compliment to say that if you liked the original form then you will like this one too', "It's probably a high compliment to say that if you liked the original form then you will like this one too. " + filler), 100);

  // 2b. Accented and plain spellings match (Jenůfa / Jenufa).
  assert.equal(excerptContainment('The soprano sings Jenůfa with a radiant fragility that the whole cast of this production matches', 'The soprano sings Jenufa with a radiant fragility that the whole cast of this production matches. ' + filler), 100);

  // 3. An unrelated excerpt is not paired.
  assert.equal(excerptCopySide({ text: 'A wholly different critic writes that the lighting design overwhelms every quiet scene in the second act tonight.', textSource: 'excerpts' }, ft), null);

  // 4. Too-short excerpts are not judged; two fullTexts are left to Jaccard.
  assert.equal(excerptContainment('a total non-issue', full), null);
  assert.equal(excerptCopySide({ text: full, textSource: 'fullText' }, ft), null);

  // 5. A quote with its own url or a named byline is not auto-paired (may be the real review).
  assert.equal(excerptCopySide({ ...ex, hasUrl: true }, ft), null);
  assert.equal(excerptCopySide({ ...ex, criticName: 'Soyica Diggs Colbert' }, ft), null);
  assert.deepEqual(excerptCopySide({ ...ex, criticName: 'Unknown' }, ft), { copy: 'a', containment: 100 });
});

const SHOW = 'operation-mincemeat-2025';
const QUOTE = 'The cast of five plays dozens of roles with such breakneck precision that the evening feels less like a musical than a magic trick performed in plain sight';
const FULL = [
  'Operation Mincemeat arrives on Broadway after a long run in London, and it has lost none of its cheek on the journey across the Atlantic.',
  'The story of the British intelligence officers who dressed a corpse as a courier to fool the Nazis is absurd enough on its own.',
  `${QUOTE}.`,
  'The songs borrow from sea shanties, Gilbert and Sullivan and modern pop without ever feeling like a pastiche of any of them.',
  'A late ballad sung by a secretary who writes the dead man love letters stops the show cold and earns every tear it draws from the audience.',
  'There are moments when the jokes pile up faster than the plot can carry them, but the energy rarely flags across two and a half hours.',
].join(' ');

const fullRec = () => ({
  showId: SHOW, outlet: 'The New York Times', outletId: 'nytimes', criticName: 'Jesse Green',
  url: 'https://www.nytimes.com/2025/03/20/theater/operation-mincemeat-review.html',
  publishDate: '2025-03-20', fullText: FULL, assignedScore: 85, contentTier: 'complete', source: 'collect-review-texts',
});
const quoteRec = (extra = {}) => ({
  showId: SHOW, outlet: 'New York Daily News', outletId: 'nydailynews', criticName: 'Unknown',
  publishDate: '2025-03-20', source: 'bww-roundup', bwwExcerpt: `${QUOTE}.`,
  assignedScore: 85, bwwSentiment: 'positive', contentTier: 'excerpt', ...extra,
});

// --- the pure rule ---
test('a bylineless url-less quote inside a sibling fullText is flagged against that file', () => {
  const flags = excerptContainmentFlags([
    { file: 'nytimes--jesse-green.json', data: fullRec() },
    { file: 'nydailynews--unknown.json', data: quoteRec() },
  ]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].file, 'nydailynews--unknown.json');
  assert.equal(flags[0].primaryFile, 'nytimes--jesse-green.json');
  assert.ok(flags[0].containment >= 85);
  const d = applyExcerptContainmentFlag(quoteRec(), SHOW, flags[0], new Date('2026-11-20T00:00:00Z'));
  assert.equal(d.crossOutletDuplicate, true);
  assert.equal(d.crossOutletPrimaryFile, `${SHOW}/nytimes--jesse-green.json`);
  assert.equal(d.crossOutletMethod, 'excerpt-containment');
});

test('a quote with its own url, a named critic, or a human clear is never flagged', () => {
  for (const extra of [
    { url: 'https://www.nydailynews.com/2025/03/20/operation-mincemeat-review/' },
    { criticName: 'Joe Dziemianowicz' },
    { crossOutletDuplicate: false, crossOutletClearReason: 'human: different review' },
  ]) {
    const flags = excerptContainmentFlags([
      { file: 'nytimes--jesse-green.json', data: fullRec() },
      { file: 'nydailynews--unknown.json', data: quoteRec(extra) },
    ]);
    assert.deepEqual(flags, [], JSON.stringify(extra));
  }
});

test('a quote that is not inside the sibling fullText is not flagged', () => {
  const flags = excerptContainmentFlags([
    { file: 'nytimes--jesse-green.json', data: fullRec() },
    { file: 'nydailynews--unknown.json', data: quoteRec({ bwwExcerpt: 'A clumsy, overlong evening whose jokes land with a thud and whose songs vanish from memory before the curtain call has even finished.' }) },
  ]);
  assert.deepEqual(flags, []);
});

