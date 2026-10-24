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
const { parsePdfReviews, parseRawPdfReviews, cutAtProductionHeader, maskPdfText, parseDefaultPdfReviews, mergeDefaultReviews, dateKey, parseShortDate } = require('./tr-pdf-parse.js');

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

test('maskPdfText keeps structure lines and drops prose (BRO-6097)', () => {
  const prose = 'A lovely evening at the Théâtre with CAPITALS and Mixed Case words that run past seventy characters.';
  const out = maskPdfText(['THE STAGE', '21.12.17', 'Michael Billington', prose].join('\n'), ['Joseph']);
  const lines = out.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['THE STAGE', '21.12.17', 'Mxxxxxx Bxxxxxxxxx']);
  assert.equal(lines[3], prose.replace(/\p{L}/gu, 'x'));
  assert.equal(maskPdfText('Joseph at the Palladium', ['Joseph']), 'Joseph xx xxx Pxxxxxxxx');
});

// BRO-6097: plain pdftotext reads a 3-column page column by column, so the
// caption, headline, date and critic are not adjacent (shape taken from a
// real 2016 issue's skeleton; the prose here is invented).
const prose = (n, extra = '') => Array.from({ length: n }, (_, i) =>
  `The Dresser returns to the Duke of York's with a fine cast and a sure director, line ${i}. ${extra}`);

test('BRO-6097: default parser pairs a caption with a date a few lines below and finds the critic', () => {
  const text = [
    'THE TIMES', 'A headline about the Dresser play', ...prose(1), '14.10.16', 'Ann Thompson', ...prose(4),
    'EVENING STANDARD', 'Strapline', '14.10.16', 'Fiona Mountford', ...prose(4),
  ].join('\n');
  const out = parseDefaultPdfReviews(text, 'The Dresser');
  assert.deepEqual(out.map(r => [r.outlet, r.date, r.critic]), [
    ['The Times', '14.10.16', 'Ann Thompson'],
    ['Evening Standard', '14.10.16', 'Fiona Mountford'],
  ]);
  for (const r of out) assert.doesNotMatch(r.fullText, /14\.10\.16|Ann Thompson|Fiona Mountford/);
});

test('BRO-6097: default parser ignores caps headlines and reviews of other shows', () => {
  const other = Array.from({ length: 6 }, (_, i) => `Murder Ballad is loud and sweaty at the Arts Theatre, line ${i}.`);
  const text = [
    'THE DRESSER', '14.10.16', 'THE TIMES', 'x', '15.10.16', 'Critic One', ...other,
  ].join('\n');
  assert.deepEqual(parseDefaultPdfReviews(text, 'The Dresser'), []);
  assert.deepEqual(parseDefaultPdfReviews('', 'The Dresser'), []);
});

test('BRO-6097: default parser cuts a review where the next production header begins', () => {
  const text = [
    'THE STAGE', '10.11.16', 'Mark Shenton', ...prose(4),
    'MURDER BALLAD', 'Musical by JULIA JORDAN', 'Arts Theatre, London',
    'Previews / Opens              Press night                   Closes',
    '08 November 2016', 'Cast & Creative',
  ].join('\n');
  const [r] = parseDefaultPdfReviews(text, 'The Dresser');
  assert.ok(r);
  assert.doesNotMatch(r.fullText, /MURDER BALLAD|Arts Theatre, London|Previews/);
});

// BRO-6097 review fixes: neighbouring reviews, venue lines as critics, dedupe.
test('BRO-6097: default parser stops at a neighbouring review from an outlet it does not list', () => {
  const text = [
    'THE TIMES', 'Headline', '14.10.16', 'Ann Thompson', ...prose(4),
    'A short caps-less strapline',
    'MORNING STAR', 'Another headline', '16.10.16', 'Gordon Parsons',
    ...Array.from({ length: 4 }, (_, i) => `Murder Ballad is loud and sweaty at the Arts Theatre, line ${i}.`),
  ].join('\n');
  const [r, ...rest] = parseDefaultPdfReviews(text, 'The Dresser');
  assert.equal(rest.length, 0);
  assert.equal(r.critic, 'Ann Thompson');
  assert.doesNotMatch(r.fullText, /MORNING STAR|Gordon Parsons|16\.10\.16|Murder Ballad|strapline/);
});

test('BRO-6097: critic search skips venue lines and accepts lowercase particles', () => {
  const body = prose(4);
  const venue = parseDefaultPdfReviews(['THE TIMES', '14.10.16', 'Theatre Royal Haymarket', "Duke Of York's", 'Ann Thompson', ...body].join('\n'), 'The Dresser');
  assert.equal(venue[0].critic, 'Ann Thompson');
  const particle = parseDefaultPdfReviews(['THE TIMES', '14.10.16', 'Jan van Dijk', ...body].join('\n'), 'The Dresser');
  assert.equal(particle[0].critic, 'Jan van Dijk');
  const none = parseDefaultPdfReviews(['THE TIMES', '14.10.16', ...body].join('\n'), 'The Dresser');
  assert.equal(none[0].critic, null);
});

test('BRO-6097: dates reduce to one ISO key whatever the format', () => {
  assert.equal(parseShortDate('14.10.2016'), '2016-10-14');
  assert.equal(parseShortDate('14.10.16'), '2016-10-14');
  assert.equal(dateKey('14 October 2016'), '2016-10-14');
  assert.equal(dateKey('14.10.16'), dateKey('14 October 2016'));
  assert.equal(dateKey('32 October 2016'), '32 October 2016');
});

test('BRO-6097: default merge drops the same review but keeps a second named critic', () => {
  const have = [{ outlet: 'The Times', date: '14 October 2016', critic: 'Ann Thompson', fullText: 'a' }];
  const same = { outlet: 'The Times', date: '14.10.16', critic: '', fullText: 'b' };
  const other = { outlet: 'The Times', date: '14.10.16', critic: 'Libby Purves', fullText: 'c' };
  const twin = { outlet: 'The Times', date: '14.10.16', critic: 'A. Thompson', fullText: 'd' };
  assert.deepEqual(mergeDefaultReviews(have, [same, twin]).map(r => r.fullText), ['a']);
  assert.deepEqual(mergeDefaultReviews(have, [other]).map(r => r.fullText), ['a', 'c']);
});
