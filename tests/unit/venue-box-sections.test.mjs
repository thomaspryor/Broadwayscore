/**
 * venue-box-sections (BRO-5294): a WSJ drama column reviews two or three shows,
 * each with a production box; the scorer must read only the target show's
 * section. Shape modelled on the-nance-2013 (The Nance + a Motown pan) and
 * act-one-2014. Invented placeholder prose, not review text.
 * Run with: node --import tsx --test tests/unit/venue-box-sections.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { extractVenueBoxSection } = await import(path.resolve(here, '../../scripts/llm-scoring/venue-box-sections.ts'));

const SHOWS = [
  { id: 'the-nance-2013', title: 'The Nance', venue: 'Lyceum Theatre', openingDate: '2013-04-15' },
  { id: 'motown-the-musical-2013', title: 'Motown: The Musical', venue: 'Lunt-Fontanne Theatre', openingDate: '2013-04-14' },
];
const P = (s, n) => (s + ' ').repeat(n);
const NANCE = P('The Nance is a warm play about a burlesque comic and the cast is excellent.', 6) + P('The staging is careful and the evening is moving.', 8);
const MOTOWN = P('Motown is a jukebox revue that strings songs together with thin scenes.', 5) + P('The book is clumsy and the evening drags.', 14);
const BOX_N = 'Lyceum Theatre, 149 W. 45th St. ($67-$137), 212-239-6200, closes Aug. 11';
const BOX_M = 'Lunt-Fontanne Theatre, 205 W. 46th St. ($59-$150), 877-250-2929';

test('box-before layout: the target section is the one after its box', () => {
  const text = `${BOX_N} ${NANCE} ${BOX_M} ${MOTOWN}`;
  const r = extractVenueBoxSection(text, SHOWS[0], SHOWS);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /The Nance is a warm play/);
  assert.doesNotMatch(r.text, /jukebox/);
  const m = extractVenueBoxSection(text, SHOWS[1], SHOWS);
  assert.equal(m.ok, true, m.reason);
  assert.match(m.text, /jukebox/);
  assert.doesNotMatch(m.text, /burlesque/);
});

test('a box cluster in the middle of a review refuses (master-class-2011 shape: the review continues after the boxes)', () => {
  const setup = P('The Nance opens with a long setup about burlesque and The Nance takes its time.', 7);
  const verdict = P('The Nance pays off richly in the second half and the cast is superb.', 6);
  const text = `${setup} ${BOX_N} ${BOX_M} ${verdict} ${MOTOWN}`;
  const r = extractVenueBoxSection(text, SHOWS[0], SHOWS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cluster/);
  // The old rule took the text before the cluster and lost the verdict.
  assert.equal((r.text || '').includes('pays off richly'), false);
});

test('both reviews after a clustered header refuse (network-2018 / the-cher-show-2018 shape)', () => {
  const text = `${BOX_N} ${BOX_M} ${NANCE} ${MOTOWN}`;
  const r = extractVenueBoxSection(text, SHOWS[0], SHOWS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /also names boxed show|ambiguous/);
});

test('a single-review page with one box is untouched', () => {
  const r = extractVenueBoxSection(`${NANCE} ${BOX_N}`, SHOWS[0], SHOWS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /fewer than 2/);
});

test('a bare price in the prose is not a box: a single review is never cut to a fragment', () => {
  const text = `${BOX_N} ${NANCE} Premium seats ($299) sell fast. ${P('The cast is excellent and The Nance is moving.', 12)}`;
  const r = extractVenueBoxSection(text, SHOWS[0], SHOWS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /fewer than 2/);
});

test('venue words match whole words only (Studio 54 never matches "W. 54th St.")', () => {
  const studio = { id: 'cabaret-2014', title: 'Cabaret', venue: 'Studio 54', openingDate: '2014-04-24' };
  const text = `Lyceum Theatre, 149 W. 54th St. ($67-$137), 212-239-6200 ${P('Cabaret is back and Cabaret is sharp.', 30)} Lunt-Fontanne Theatre, 205 W. 46th St. ($59-$150), 877-250-2929 ${MOTOWN}`;
  assert.equal(extractVenueBoxSection(text, studio, [studio, ...SHOWS]).ok, false);
});

test('the scorer trim and detector use the box section (master-class / godot gaps)', async () => {
  const { trimMultiShowText } = await import(path.resolve(here, '../../scripts/llm-scoring/trim-multi-show.ts'));
  assert.equal(trimMultiShowText('', 'X', 'x').trimFailed, true);
  assert.equal(trimMultiShowText(null, 'X', 'x').trimFailed, true);
});

test("a section does not end with the next show's caption, credit and theatre lines (act-one-2014 tail)", async () => {
  const { dropTrailingShortLines } = await import(path.resolve(here, '../../scripts/llm-scoring/venue-box-sections.ts'));
  const body = P('The revival is a pleasure from start to finish and the cast is in fine form.', 3);
  const tail = "\nChris Somebody, left, and Jim Other in 'Of Mice and Men.'\nA. Photographer\nLongacre Theatre, 220 W. 48th St.";
  assert.equal(dropTrailingShortLines(body + tail), body.trim());
  assert.equal(dropTrailingShortLines(body), body.trim());
  // A short closing verdict stays.
  assert.equal(dropTrailingShortLines(body + "\nDon't miss it."), (body + "\nDon't miss it.").trim());
  // Hard-wrapped prose (every line under 100 chars) is not eaten.
  const wrapped = 'The revival is a pleasure from start to finish\nand the cast is in fine form all night long.\nI loved it.';
  assert.equal(dropTrailingShortLines(wrapped), wrapped);
});

test('a box tail with an abbreviated month stays in the box (venus-in-fur-2011: "212-239-6200, closes Dec. 18")', () => {
  const box = 'Lyceum Theatre, 149 W. 45th St.\n\n($67-$137), 212-239-6200, closes Dec. 18';
  const text = `${BOX_M} ${MOTOWN}\n\n${box}\n\n${NANCE}`;
  const r = extractVenueBoxSection(text, SHOWS[0], SHOWS);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /^The Nance is a warm play/);
});

test('a run-date tail never swallows the next sentence on the same line', () => {
  const box = 'Lyceum Theatre, 149 W. 45th St. ($67-$137), 212-239-6200, through Sunday. Mr. Smith, 45, plays the lead.';
  const text = `${BOX_M} ${MOTOWN}\n\n${box} ${NANCE}`;
  const r = extractVenueBoxSection(text, SHOWS[0], SHOWS);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /Mr\. Smith, 45, plays the lead/);
});

test('title mentions are whole words: "Rent" is not counted inside "different" or "current" (BRO-5261)', () => {
  const shows = [
    { id: 'rent-2030', title: 'Rent', venue: 'Nederlander Theatre', openingDate: '2030-04-01' },
    { id: 'the-nance-2030', title: 'The Nance', venue: 'Lyceum Theatre', openingDate: '2030-04-02' },
  ];
  const rentReview = P('Rent is back and this Rent revival sings with real fire.', 8) + P('The cast is young and fierce.', 20);
  const other = P('A different evening with current concerns and parents who differ.', 10) + P('The Nance is a careful play.', 8);
  const rentBox = 'Nederlander Theatre, 208 W. 41st St. ($59-$199), 877-250-2929';
  const text = `${rentReview} ${rentBox} ${other} ${BOX_N}`;
  const r = extractVenueBoxSection(text, shows[0], shows);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /Rent revival sings/);
  assert.doesNotMatch(r.text, /different evening/);
});
