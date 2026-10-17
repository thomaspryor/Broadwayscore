// Colocated tests for scripts/lib/tour-runtime.js (BRO-4750). Runs in the
// scripts/lib/*.test.mjs glob batch in test.yml.
// The HTML snippets are the Details lists copied from live tourstoyou.org pages
// on 2026-10-05 (mrs-doubtfire-1: colon outside the <strong>; waitress-1: colon
// inside it), so a change to the markup handling is tested against real shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractTourRuntime, parseIntermissions, titleKey, pageIsTour, candidateUrls } = require('./tour-runtime.js');

const DOUBTFIRE = '<ul><li><strong>Runtime</strong>: 2 hours 35 minutes</li><li><strong>Intermissions</strong>: 1</li><li><strong>Age Recommendation</strong>: 8+</li></ul>';
const WAITRESS = '<ul><li><strong>Runtime:</strong> 2 hours 30 minutes</li><li><strong>Intermissions:</strong> 1</li><li><strong>Age Recommendation:</strong> 12+</li></ul>';

test('colon outside the <strong>: runtime and intermissions read', () => {
  assert.deepEqual(extractTourRuntime(`<div>${DOUBTFIRE}</div>`), { minutes: 155, runtime: '2h 35m', intermissions: 1 });
});

test('colon inside the <strong>: same result (the Waitress page shape)', () => {
  assert.deepEqual(extractTourRuntime(`<div>${WAITRESS}</div>`), { minutes: 150, runtime: '2h 30m', intermissions: 1 });
});

test('the list repeated for desktop and mobile (identical blocks) still reads once', () => {
  assert.deepEqual(extractTourRuntime(`<section>${DOUBTFIRE}</section><section>${DOUBTFIRE}</section>`), { minutes: 155, runtime: '2h 35m', intermissions: 1 });
});

test('blocks that disagree on the length fail closed', () => {
  assert.equal(extractTourRuntime(`${DOUBTFIRE}${WAITRESS}`), null);
});

test('no runtime on the page, or an empty one, is null', () => {
  assert.equal(extractTourRuntime('<ul><li><strong>Age Recommendation</strong>: 8+</li></ul>'), null);
  assert.equal(extractTourRuntime('<ul><li><strong>Runtime</strong>: </li></ul>'), null);
  assert.equal(extractTourRuntime(''), null);
  assert.equal(extractTourRuntime(null), null);
});

test('a multi-part listing is null (no single number is honest)', () => {
  assert.equal(extractTourRuntime('<ul><li><strong>Runtime</strong>: Part One: 2 hours 45 minutes &amp; Part Two: 2 hours 35 minutes</li></ul>'), null);
});

test('an implausible length (over 5 hours) is null', () => {
  assert.equal(extractTourRuntime('<ul><li><strong>Runtime</strong>: 9 hours</li></ul>'), null);
});

test('a runtime with no Intermissions item reads, intermissions unknown', () => {
  assert.deepEqual(extractTourRuntime('<ul><li><strong>Runtime</strong>: 1 hour 40 minutes</li><li><strong>Age Recommendation</strong>: 12+</li></ul>'), { minutes: 100, runtime: '1h 40m', intermissions: null });
});

test('an Intermissions item that belongs to a different list is not borrowed', () => {
  const html = '<ul><li><strong>Runtime</strong>: 2 hours</li></ul><p>other</p><ul><li><strong>Intermissions</strong>: 3</li></ul>';
  assert.equal(extractTourRuntime(html).intermissions, null);
});

test('parseIntermissions: counts, none, junk', () => {
  assert.equal(parseIntermissions('1'), 1);
  assert.equal(parseIntermissions('2 (one of 15 minutes)'), 2);
  assert.equal(parseIntermissions('None'), 0);
  assert.equal(parseIntermissions('No intermission'), 0);
  assert.equal(parseIntermissions('0'), 0);
  assert.equal(parseIntermissions(''), null);
  assert.equal(parseIntermissions('TBD'), null);
});

const page = (title) => `<html><head><title>${title} &#8211; Tours To You</title></head><body></body></html>`;

test('pageIsTour: the page title names this tour', () => {
  assert.equal(pageIsTour(page('Mrs. Doubtfire'), { title: 'Mrs. Doubtfire' }), true);
  assert.equal(pageIsTour(page('Beauty and the Beast'), { title: "Disney's Beauty and the Beast" }), false, 'Disney prefix is not a prefix of the page title, fails closed');
  assert.equal(pageIsTour(page('Beauty and the Beast'), { title: 'Beauty and the Beast' }), true);
  assert.equal(pageIsTour(page('Hell&#8217;s Kitchen'), { title: "Hell's Kitchen" }), true);
  assert.equal(pageIsTour(page('Jersey Boys'), { title: 'Jersey Boys' }), true);
  assert.equal(pageIsTour(page('&#038; Juliet'), { title: '& Juliet' }), true, 'numeric ampersand entity, as on the live & Juliet page');
});

test('pageIsTour: a page that merely starts with the tour title is not the tour (the live six redirect, a longer show)', () => {
  assert.equal(pageIsTour(page('Annie Get Your Gun'), { title: 'Annie' }), false);
  assert.equal(pageIsTour(page('Peter Pan Goes Wrong'), { title: 'Peter Pan' }), false);
  assert.equal(pageIsTour(page('&#8216;SIX&#8217; Casting Announced for the 2025-2026 Season'), { title: 'Six' }), false);
  assert.equal(pageIsTour(page('Cats: The Jellicle Ball'), { title: 'Cats' }), true, 'a colon subtitle names the show');
  assert.equal(pageIsTour(page('Hamilton (Angelica Tour)'), { title: 'Hamilton' }), true, 'a bracket subtitle names the show');
});

test('pageIsTour: a subtitle on the page still matches, a longer tour title does not', () => {
  assert.equal(pageIsTour(page('A Beautiful Noise, The Neil Diamond Musical'), { title: 'A Beautiful Noise' }), true);
  assert.equal(pageIsTour(page('A Beautiful Noise'), { title: 'A Beautiful Noise: The Neil Diamond Musical' }), false);
});

test('pageIsTour: another show, a 404 page and a page with no title never match', () => {
  assert.equal(pageIsTour(page('Come From Away'), { title: 'Operation Mincemeat' }), false);
  assert.equal(pageIsTour(page('Page not found'), { title: 'Waitress' }), false);
  assert.equal(pageIsTour('<html></html>', { title: 'Waitress' }), false);
  assert.equal(pageIsTour(page('Waitress'), { title: '' }), false);
});

test('pageIsTour: a different show that merely shares a first word does not match', () => {
  assert.equal(pageIsTour(page('Six'), { title: 'Sister Act' }), false);
  assert.equal(pageIsTour(page('Wicked'), { title: 'Wicked: Part Two' }), false, 'a longer, different title is not the same page');
});

test('titleKey: case, accents, ampersands, apostrophes and "the musical" are folded away', () => {
  assert.equal(titleKey('Hell’s Kitchen'), 'hells kitchen');
  assert.equal(titleKey('Rock & Roll: The Musical'), 'rock and roll');
  assert.equal(titleKey('The Lion King'), 'lion king');
});

test('candidateUrls: the saved schedule source first, then the slug guesses, no duplicates', () => {
  const tour = { id: 'x-tour-2025', title: 'Waitress', tourScheduleSlug: 'waitress-1' };
  const schedules = { tours: { 'x-tour-2025': { source: 'https://tourstoyou.org/shows/waitress-1/' } } };
  assert.deepEqual(candidateUrls(tour, schedules), ['https://tourstoyou.org/shows/waitress-1/']);
  assert.deepEqual(candidateUrls({ id: 'y', title: 'Life of Pi' }, { tours: {} }), [
    'https://tourstoyou.org/shows/life-of-pi/',
    'https://tourstoyou.org/shows/life-of-pi-the-musical/',
  ]);
});

test('extractTourRuntime: only plain runtime text; loose or misread shapes fail closed', () => {
  const li = (t) => `<ul><li><strong>Runtime</strong>: ${t}</li></ul>`;
  assert.equal(extractTourRuntime(li('2.5 hours')), null, '2.5 hours would read as 5h');
  assert.equal(extractTourRuntime(li('Approximately 2 hrs. 35 mins.')), null, 'would read as 2h');
  assert.equal(extractTourRuntime(li('Approx. 2 hours 35 minutes')), null);
  assert.equal(extractTourRuntime(li('TBD')), null);
  assert.equal(extractTourRuntime(li('N/A')), null);
  assert.deepEqual(extractTourRuntime(li('2 hours')), { minutes: 120, runtime: '2h', intermissions: null });
  assert.deepEqual(extractTourRuntime(li('1 hour 40 minutes')), { minutes: 100, runtime: '1h 40m', intermissions: null });
  assert.deepEqual(extractTourRuntime(li('90 minutes')), { minutes: 90, runtime: '1h 30m', intermissions: null });
  assert.deepEqual(extractTourRuntime(li('2 Hours and 20 Minutes')), { minutes: 140, runtime: '2h 20m', intermissions: null });
});

test('parseIntermissions: spelled-out counts', () => {
  assert.equal(parseIntermissions('One'), 1);
  assert.equal(parseIntermissions('two'), 2);
});
