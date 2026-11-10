// BRO-7291 class 2: the printed byline beats listing names and site-wide accounts. Replays the BRO-7256/7257
// hand fixes (anastasia: "TheShowReport" -> Chris Daniels; heartbreak-house: "Steven Morris" -> Kayden J.
// Merritt) and the cousins the sweep found (puppet-up, the-music-man, the-notebook). Fixtures are only the
// header/credit lines, never review prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { printedBylineOverride, extractBylineFromText } = require('./byline-from-text.js');

const CASES = [
  ['the-show-report', 'TheShowReport', 'TheShowReport Jun 14 6 min read Updated: Jun 15 ANASTASIA ... CHRIS DANIELS ARTS & ENTERTAINMENT REVIEWER THE SHOW REPORT', 'Chris Daniels'],
  ['the-show-report', 'TheShowReport', 'Orchestra seating at 7:30 PM. CHRIS DANIELS ARTS & ENTERTAINMENT REVIEWER THE SHOW REPORT Photo Credits ROGER MASTROIANNI', 'Chris Daniels'],
  ['stage-raw', 'Steven Morris', 'Echoes of the Future from 1916, in Antaeus Theatre\'s Marvelous "Heartbreak House" By Kayden J. Merritt RECOMMENDED Elinore Gunn', 'Kayden J. Merritt'],
  ['stage-raw', 'Steven Morris', '(Photo by Omar Gaieck) Reviewed by Joel Beers Ricardo Montalbán Theatre Through August 9 RECOMMENDED', 'Joel Beers'],
  ['stage-raw', 'Steven Morris', 'The Company (Photo by Marshall Meadows) Reviewed by G. Bruce Smith Ahmanson Theatre Through Nov. 8 RECOMMENDED', 'G. Bruce Smith'],
  ['stage-raw', 'Martín Hernández', 'Rachel Sorsa (Photo by Keith Stevenson) Reviewed by Martίn Hernández Ruskin Group Theatre Through August 9', null],
];

for (const [outlet, stored, text, want] of CASES) {
  test(`${outlet}: stored "${stored}" -> ${want || 'kept'}`, () => {
    assert.equal(printedBylineOverride(outlet, text, 'https://example.org/review', stored), want);
  });
}

test('an unknown Stage Raw name glued to the venue is not trusted (no "Name Venue Theatre" bylines)', () => {
  assert.equal(extractBylineFromText('stage-raw', 'Reviewed by Pat Newcritic Odyssey Theatre Through May 3'), null);
});

test('a Show Report page with no printed credit keeps whatever the record has', () => {
  assert.equal(printedBylineOverride('the-show-report', 'TheShowReport Jun 14 6 min read a review with no credit line', null, 'TheShowReport'), null);
});
