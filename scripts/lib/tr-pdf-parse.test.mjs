/**
 * BRO-5141: the Joseph and the Amazing Technicolor Dreamcoat (West End 2021)
 * run filed Anna X, FRIEND (The One With Gunther) and other reviews from
 * Theatre Record's volume 41 issue 14 PDF under Joseph. The production
 * header lines below are copied from that issue's pdftotext output as it
 * survived inside the misfiled review texts; review prose is shortened.
 *
 * Two shapes defeated the parser: the title line carries a right-aligned
 * "Index" link ("ANNA X ... Index"), and the long Joseph title wraps over two
 * lines. So the title was never found, the fallback started at the issue's
 * first Reviews block, and no end boundary matched until the end of the PDF.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePdfReviews, parseRawPdfReviews, cutAtProductionHeader } = require('./tr-pdf-parse.js');

const JOSEPH = 'Joseph and the Amazing Technicolor Dreamcoat';
const PAD = ' '.repeat(52);

const ISSUE_14 = [
  `${PAD}Reviews`,
  'FRIEND (THE ONE WITH GUNTHER)',
  'THEATRE WEEKLY',
  '18 July 2021',
  'Bethany Jane Christian',
  '',
  'Online review For any fan of Friends, this show is a must-see, a parody packed with',
  'catchphrases and in-jokes. Funny and clever, the show is light-',
  'hearted, but niche.',
  'ANNA X                                                              Index',
  'New play written by JOSEPH CHARLTON',
  'Harold Pinter Theatre, London',
  'Previews / Opens              Press night                   Closes',
  '10 July 2021                  15 July 2021                  04 August 2021',
  'Cast & Creative',
  'Emma Corrin                   Nabhaan Rizwan',
  '',
  `${PAD}Reviews`,
  'ANNA X',
  'THE INDEPENDENT',
  '18 July 2021',
  'Paul Taylor',
  '',
  'Emma Corrin makes her West End debut in Anna X, the highly intriguing and talented new play by Joseph Charlton.',
  'Daniel Raggett directs a slick production on a set of scrolling screens and glitching monitors.',
  'I hope that Joseph Charlton continues to write for the theatre.',
  'JOSEPH AND THE AMAZING',
  'TECHNICOLOR DREAMCOAT',
  'Revival of musical composed by ANDREW LLOYD WEBBER with lyrics by TIM RICE',
  'London Palladium, London',
  'Previews / Opens              Press night                   Closes',
  '12 July 2021                  28 July 2021                  ???',
  'Running time                  1st Performed',
  '2hrs 05mins                  The Roundhouse, London',
  '',
  `${PAD}Reviews`,
  'JOSEPH AND THE AMAZING',
  'TECHNICOLOR DREAMCOAT',
  'LONDON THEATRE',
  '29 July 2021',
  'Marianka Swain',
  '',
  'Go go go Joseph! Laurence Connor\'s revival of the Lloyd Webber and Rice musical bounces back',
  'into the Palladium with Jac Yarrow in the coat and Alexandra Burke as the Narrator.',
  'THE TELEGRAPH',
  '28 July 2021',
  'Claire Allfree',
  '',
  'His beleaguered Cinderella may be yet to hit the stage, but Joseph is back at the Palladium',
  'with its technicolor dreamcoat, a Megamix and a full-capacity audience on its feet.',
].join('\n');

test('BRO-5141: layout parser keeps only the Joseph section of a multi-production issue', () => {
  const reviews = parsePdfReviews(ISSUE_14, JOSEPH);
  assert.deepEqual(reviews.map(r => r.outlet), ['London Theatre', 'The Telegraph']);
  for (const r of reviews) assert.doesNotMatch(r.fullText, /Anna X|Joseph Charlton|Friends/);
});

test('BRO-5141: a single-line title with the "Index" suffix bounds the section too', () => {
  const reviews = parsePdfReviews(ISSUE_14, 'Anna X');
  assert.deepEqual(reviews.map(r => r.outlet), ['The Independent']);
  assert.doesNotMatch(reviews[0].fullText, /TECHNICOLOR|Revival of musical|Previews/);
});

test('BRO-5141: title not found in a multi-production issue yields nothing, not the first Reviews block', () => {
  assert.deepEqual(parsePdfReviews(ISSUE_14, 'Some Other Show'), []);
});

test('BRO-5141: raw parser cuts a review where the next production\'s info page begins', () => {
  const friend = parseRawPdfReviews(ISSUE_14, 'Friend (The One With Gunther)');
  for (const r of friend) assert.doesNotMatch(r.fullText, /ANNA X|Previews|Harold Pinter/);
  const cut = cutAtProductionHeader([
    'hearted, but niche.',
    'ANNA X                                                              Index',
    'New play written by JOSEPH CHARLTON',
    'Harold Pinter Theatre, London',
    'Previews / Opens              Press night                   Closes',
  ]);
  assert.deepEqual(cut, ['hearted, but niche.']);
});

test('BRO-5141: text with no production header is left whole', () => {
  const lines = ['A plain review line.', 'Another line naming the PALLADIUM.'];
  assert.deepEqual(cutAtProductionHeader(lines), lines);
});

test('BRO-5141: 2019-format header ("TITLE" / "Goto" / "CITY, VENUE") is cut whole', () => {
  const cut = cutAtProductionHeader([
    'company and especially Ann Louise Ross and Oliver Ford Davies.',
    'GREY',
    'Goto',
    'LONDON, OVALHOUSE',
    'Previews / Opens 27 Jun 2019',
    'Press Night 01 Jul 2019',
  ]);
  assert.deepEqual(cut, ['company and especially Ann Louise Ross and Oliver Ford Davies.']);
});

test('BRO-5141: a title wrapped over three lines is found', () => {
  const text = [
    'THE CURIOUS INCIDENT OF THE DOG',
    'IN THE NIGHT-TIME',
    'Revival of play by SIMON STEPHENS',
    'Piccadilly Theatre, London',
    'Previews / Opens              Press night                   Closes',
    '',
    `${PAD}Reviews`,
    'THE CURIOUS INCIDENT',
    'OF THE DOG IN THE',
    'NIGHT-TIME',
    'THE GUARDIAN',
    '02 July 2021',
    'Arifa Akbar',
    '',
    'Christopher Boone is back, and the production still dazzles in its new home, with a cast that',
    'finds fresh detail in every scene.',
  ].join('\n');
  const reviews = parsePdfReviews(text, 'The Curious Incident of the Dog in the Night-Time');
  assert.deepEqual(reviews.map(r => r.outlet), ['The Guardian']);
});

test('BRO-5141: the header walk-back stops at three title lines (a caps line in the review above stays)', () => {
  const cut = cutAtProductionHeader([
    'and the audience roars its approval.',
    'BRAVO.',
    'JOSEPH AND THE AMAZING',
    'TECHNICOLOR DREAMCOAT',
    'Revival of musical composed by ANDREW LLOYD WEBBER with lyrics by TIM RICE',
    'London Palladium, London',
    'Previews / Opens              Press night                   Closes',
  ]);
  assert.deepEqual(cut, ['and the audience roars its approval.', 'BRAVO.']);
});
