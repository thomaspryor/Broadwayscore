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

test('clustered boxes between the reviews: the first show takes the text before; the second refuses (eclipsed-2016 shape)', () => {
  const text = `${NANCE} ${BOX_N} ${BOX_M} ${MOTOWN}`;
  assert.match(extractVenueBoxSection(text, SHOWS[0], SHOWS).text, /burlesque/);
  const second = extractVenueBoxSection(text, SHOWS[1], SHOWS);
  assert.equal(second.ok, false);
  assert.match(second.reason, /cluster/);
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
