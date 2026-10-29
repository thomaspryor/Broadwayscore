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
const { parsePdfReviews, parseRawPdfReviews, cutAtProductionHeader, maskPdfText, parseDefaultPdfReviews, mentionsTitle, mergeDefaultReviews, dateKey, parseShortDate, isDateLine } = require('./tr-pdf-parse.js');

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

// BRO-6097: real masked pdftotext skeletons from the CI probe. Default mode
// used to return 0 for The Dresser (title is rarely in the first 300 chars of
// interleaved column text); the whole-review title mention recovers them.
test('default mode on masked real skeletons recovers reviews', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const dir = new URL('../../data/audit/we-historical-tr-skeletons/', import.meta.url);
  const cases = [
    ['the-dresser-west-end-2016', 'The Dresser', 5],
    ['murder-ballad-west-end-2016', 'Murder Ballad', 4],
    ['the-sewing-group-west-end-2016', 'The Sewing Group', 5],
  ];
  for (const [id, title, min] of cases) {
    const f = new URL(`${id}.default.txt`, dir);
    assert.ok(existsSync(f), `${id} skeleton missing`);
    const r = parseDefaultPdfReviews(readFileSync(f, 'utf8'), title);
    assert.ok(r.length >= min, `${id}: got ${r.length}, want >= ${min}`);
  }
});

test('default mode title match rejects passing mentions of common words', () => {
  const body = (extra) => ({ fullText: `${extra} `.repeat(1) + 'x'.repeat(300) });
  assert.equal(mentionsTitle(body('The company is excellent in this play.').fullText, 'Company'), false);
  assert.equal(mentionsTitle(body('echoes of Hamlet and the stage cast').fullText, 'Hamlet'), true);
  assert.equal(mentionsTitle(body('Like hamilton before it').fullText, 'Hamilton'), false);
  assert.equal(mentionsTitle(body('the band plays; the band was loud').fullText, 'The Band'), false);
  assert.equal(mentionsTitle(body('six actors in six roles').fullText, 'Six'), false);
  assert.equal(mentionsTitle(body('act 2 at 9 pm, 5 stars').fullText, '9 to 5'), false);
});

// BRO-6127: 2021-22 issues date September "08 Sept 2021". DATE_LONG only knew
// "Sep"/"September", so no outlet+date header matched and Frozen, Blithe
// Spirit, The Last Five Years and Rockets and Blue Lights all parsed to zero.
test('September is also written Sept', () => {
  assert.equal(isDateLine('08 Sept 2021'), true);
  assert.equal(isDateLine('08 Sep 2021'), true);
  assert.equal(isDateLine('08 September 2021'), true);
  assert.equal(isDateLine('08 Septx 2021'), false);
  assert.equal(dateKey('08 Sept 2021'), '2021-09-08');
});

// The probe's masked skeletons keep only capitals on short lines, so the
// markers the parser keys on ("Reviews", "Previews / Opens", the month) are
// restored here; every other line is the real layout.
const unmask = (t) => t
  .replace(/^(\s*)Rxxxxxx\s*$/gm, '$1Reviews')
  .replace(/Pxxxxxxx \/ Oxxxx/g, 'Previews / Opens')
  .replace(/(\d{2}) Sxxx (\d{4})/g, '$1 Sept $2');

test('layout mode on masked real 2021 skeletons finds every outlet header', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = new URL('../../data/audit/we-historical-tr-skeletons/', import.meta.url);
  const cases = [
    ['frozen-west-end-2021', 'Frozen', 4],
    ['blithe-spirit-west-end-2021', 'Blithe Spirit', 6],
    ['the-last-five-years-west-end-2021', 'The Last Five Years', 5],
    ['rockets-and-blue-lights-west-end-2021', 'Rockets and Blue Lights', 5],
  ];
  for (const [id, title, headers] of cases) {
    const stats = {};
    parsePdfReviews(unmask(readFileSync(new URL(`${id}.layout.txt`, dir), 'utf8')), title, stats);
    assert.equal(stats.sectionFound, true, `${id}: section`);
    assert.equal(stats.headers, headers, `${id}: headers`);
  }
});

// 2017-18 issues print the bare masthead ("GUARDIAN", "INDEPENDENT").
test('default mode reads bare mastheads on masked real 2018 skeletons', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = new URL('../../data/audit/we-historical-tr-skeletons/', import.meta.url);
  const read = (id) => readFileSync(new URL(`${id}.default.txt`, dir), 'utf8');
  const pressure = parseDefaultPdfReviews(read('pressure-west-end-2018'), 'Pressure');
  assert.ok(pressure.some(r => /independent/i.test(r.outlet)), 'Pressure: Independent');
  const kite = parseDefaultPdfReviews(read('the-kite-runner-west-end-2017'), 'The Kite Runner');
  assert.ok(kite.some(r => /guardian/i.test(r.outlet)), 'Kite Runner: Guardian');
});

// BRO-6154: -raw and default text have no "Previews / Opens" line, so reviews
// of the production after ours (whose prose reuses our title words) were
// filed under our show. Each production starts with "VENUE / run dates /
// TITLE"; a review belongs to the block above it.
const { productionRuns, sectionOwnedBy, locateReviews, productionSections } = require('./tr-pdf-parse.js');
const sectionProse = (t) => `${t} was staged with great energy and the company gave a long, detailed, memorable performance throughout the evening, `.repeat(4);
const issue = (outlet, date, critic, body) => [outlet, date, critic, body, ''].join('\n');
const TWO_PRODUCTIONS = [
  'LYTTELTON, NATIONAL THEATRE', '11 June - 14 August 2021', 'AFTER LIFE', 'A new play', '',
  issue('GUARDIAN', '11.06.21', 'Arifa Akbar', sectionProse('After Life')),
  issue('DAILY MAIL', '11.06.21', 'Quentin Letts', sectionProse('After Life')),
  'DERBY THEATRE', '17 July - 7 August 2021', 'ALL ABOUT EVE', 'A new musical', '',
  issue('OBSERVER', '18.07.21', 'Susannah Clapp', sectionProse('This play, after the life of Eve Harrington,')),
].join('\n');

test('BRO-6154 productionRuns reads title from the block under the run dates', () => {
  const runs = productionRuns(TWO_PRODUCTIONS.split('\n'));
  assert.deepEqual(runs.map(r => r.title), ['AFTER LIFE', 'ALL ABOUT EVE']);
});

test('BRO-6154 the running header is not a production run', () => {
  const runs = productionRuns(['Theatre Record 18 September - 17 October 2017', 'LONDON', '03 October - 02 December 2017', 'LABOUR OF LOVE']);
  assert.deepEqual(runs.map(r => r.title), ['LABOUR OF LOVE']);
});

test('BRO-6154 raw mode drops the next production\'s reviews that reuse our title words', () => {
  const got = parseRawPdfReviews(TWO_PRODUCTIONS, 'After Life');
  assert.deepEqual(got.map(r => r.outlet).sort(), ['Daily Mail', 'Guardian']);
});

test('BRO-6154 default mode keeps a review whose block cannot be told', () => {
  const noRuns = TWO_PRODUCTIONS.split('\n').filter(l => !/ - /.test(l)).join('\n');
  assert.equal(sectionOwnedBy(productionRuns(noRuns.split('\n')), 5, 'After Life'), null);
  assert.ok(parseRawPdfReviews(noRuns, 'After Life').length >= 2);
});

test('BRO-6154 ownership on the real masked Band issue (raw + default)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const mode of ['raw', 'default']) {
    const L = readFileSync(new URL(`../../data/audit/we-historical-tr-skeletons/the-band-west-end-2018.${mode}.txt`, import.meta.url), 'utf8').split('\n');
    const runs = productionRuns(L);
    assert.ok(runs.some(r => r.title === 'LABOUR OF LOVE'), `${mode}: Labour of Love block found`);
    const at = runs.find(r => r.title === 'LABOUR OF LOVE').line + 80;
    assert.equal(sectionOwnedBy(runs, at, 'Labour of Love'), true);
    const own = runs.find(r => r.title === 'THE BAND');
    if (mode === 'raw') {
      assert.ok(own, 'The Band own block found (same-month run line)');
      assert.equal(sectionOwnedBy(runs, own.line + 40, 'The Band'), true);
    }
    assert.equal(sectionOwnedBy(runs, at, 'The Band'), false);
  }
});

test('BRO-6154 locateReviews attributes a review to its production section', () => {
  const t = ['ANNA X    Index', 'Previews / Opens   Press night', 'THE GUARDIAN', '1 May 2021', 'Some long first line of review text here', 'BE MORE CHILL', 'Previews / Opens'].join('\n');
  assert.equal(productionSections(t.split('\n')).length, 2);
  const [r] = locateReviews(t, [{ outlet: 'The Guardian', date: '1 May 2021', fullText: 'Some long first line of review text here' }], 'Anna X');
  assert.equal(r.line, 4);
  assert.equal(r.owned, null);
  const t2 = ['x', '01 May \u2013 30 June 2021', 'ANNA X', 'The Guardian', 'Some long first line of review text here'].join('\n');
  assert.equal(locateReviews(t2, [{ outlet: 'The Guardian', fullText: 'Some long first line of review text here' }], 'Anna X')[0].owned, true);
  assert.equal(locateReviews(t2, [{ outlet: 'The Guardian', fullText: 'Some long first line of review text here' }], 'Other Show')[0].owned, false);
});

test('BRO-6154 a block sharing a real word with our title stays unknown, a disjoint one is dropped', () => {
  const runs = productionRuns(['X', '03 October - 02 December 2017', 'PRIDE AND PREJUDICE* (*SORT OF)', 'a'].concat(['y', '', '04 December - 02 January 2018', 'ALL ABOUT EVE']));
  assert.equal(sectionOwnedBy(runs, 3, 'Pride & Prejudice (Sort Of)'), true);
  assert.equal(sectionOwnedBy(runs, 3, 'Pride and Joy'), null);
  assert.equal(sectionOwnedBy(runs, 9, 'After Life'), false);
});

test('BRO-6154 run blocks: same-month dates, wrapped titles, outlet lines are not titles', () => {
  const L = ['x', '26 \u2013 30 September 2017', 'THE TRACKERS OF', 'OXYRHYNCHUS', 'text', '03 October \u2013 02 December 2017', 'GUARDIAN', 'THE BAND'];
  const runs = productionRuns(L);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].title, 'THE TRACKERS OF OXYRHYNCHUS');
  assert.equal(runs[1].title, 'THE BAND');
});

test('BRO-6154 a missed run line for our own show leaves the review unknown, not dropped', () => {
  const L = ['x', '03 October \u2013 02 December 2017', 'OTHER SHOW', 'a', 'NOVELLO', '03 October 2017 onwards', 'ALL ABOUT EVE', 'review text'];
  const runs = productionRuns(L);
  assert.equal(sectionOwnedBy(runs, 7, 'All About Eve', L), null);
  assert.equal(sectionOwnedBy(runs, 7, 'After Life', L), false);
});

test('BRO-6154 venueOwnedBy: a review under another theatre header is not ours, same venue or no header stays', async () => {
  const { venueOwnedBy } = await import('node:module').then(m => m.createRequire(import.meta.url)('./tr-pdf-parse.js'));
  const L = ['NOËL COWARD THEATRE', 'Previews / Opens   Press night', 'a', 'b', 'WYNDHAM’S THEATRE', 'Previews / Opens   Press night', 'c', 'd'];
  assert.equal(venueOwnedBy(L, 3, 'Noël Coward Theatre'), true);
  assert.equal(venueOwnedBy(L, 7, 'Noël Coward Theatre'), false);
  assert.equal(venueOwnedBy(L, 0, 'Noël Coward Theatre'), null);
  assert.equal(venueOwnedBy(L, 7, ''), null);
  assert.equal(venueOwnedBy(['LONDON, YOUNG VIC THEATRE', 'Previews / Opens', 'x'], 2, 'Royal Court'), false);
  assert.equal(venueOwnedBy(['LONDON, ROYAL COURT THEATRE UPSTAIRS', 'Previews / Opens', 'x'], 2, 'Royal Court'), true);
});

test('BRO-6154 venueOwnedBy tolerates renames, possessives and the title in the header', async () => {
  const { venueOwnedBy } = await import('node:module').then(m => m.createRequire(import.meta.url)('./tr-pdf-parse.js'));
  const h = (t) => [t, 'Previews / Opens', 'x'];
  assert.equal(venueOwnedBy(h("DUKE OF YORK\u2019S THEATRE"), 2, 'Tom Stoppard Theatre', 'Rosmersholm'), true);
  assert.equal(venueOwnedBy(h('WYNDHAMS THEATRE'), 2, "Wyndham's Theatre", 'Curtains'), true);
  assert.equal(venueOwnedBy(h('ALL ABOUT EVE'), 2, 'No\u00ebl Coward Theatre', 'All About Eve'), true);
  assert.equal(venueOwnedBy(h('WYNDHAM\u2019S THEATRE'), 2, 'No\u00ebl Coward Theatre', 'All About Eve'), false);
});

// BRO-6287 (side item 5): a bare masthead key must not turn a short production
// title into an outlet marker, while the printed forms still match.
const { isKnownOutletLine } = require('./tr-pdf-parse.js');
test('isKnownOutletLine: printed mastheads match, ambiguous bare keys do not', () => {
  for (const ok of ['THE GUARDIAN', 'GUARDIAN', 'INDEPENDENT', 'METRO (LONDON)', 'THE SUN', 'THE I', 'THE LIST', 'METRO', 'THE TIMES (LONDON)', 'SUN (LONDON)'])
    assert.equal(isKnownOutletLine(ok), true, ok);
  for (const no of ['SUN', 'I', 'LIST', 'STAGE', 'TIMES', 'MIRROR', 'EXPRESS', 'STANDARD', 'AFTER LIFE'])
    assert.equal(isKnownOutletLine(no), false, no);
});

// BRO-6287: 2021 issues have no run-dates lines or venue headers, only a caps
// caption (production title) directly above each review's outlet line. The
// structure below is copied from the masked layout diagnostic of the Be More
// Chill / South Pacific / After Life issues; the prose is filler.
const { captionOwnedBy } = require('./tr-pdf-parse.js');
const CHILL_BODY = 'Be More Chill: the staging is lively and the songs land well, with a cast that sells every beat of the show. '.repeat(4);
const chillIssue = [
  'Reviews', '', 'BE MORE CHILL', 'Daily Mail', '', 'BE MORE CHILL', 'FINANCIAL TIMES', '12 July 2021', 'Hannah Bennett', CHILL_BODY, 'It is a fine night out.',
  '', 'SOUTH PACIFIC', 'FINANCIAL TIMES', '16 July 2021', 'Another Critic', CHILL_BODY, 'Rodgers and Hammerstein again.',
  '', 'BE MORE CHILL', 'THE GUARDIAN', '13 July 2021', 'Third Critic', CHILL_BODY, 'Squip.',
].join('\n');

test('captionOwnedBy: our caption true, foreign caption false, none null', () => {
  const lines = chillIssue.split('\n');
  const at = (txt, nth = 0) => lines.map((l, i) => l === txt ? i : -1).filter(i => i >= 0)[nth];
  assert.equal(captionOwnedBy(lines, at('FINANCIAL TIMES', 0), 'Be More Chill'), true);
  assert.equal(captionOwnedBy(lines, at('FINANCIAL TIMES', 1), 'Be More Chill'), false);
  assert.equal(captionOwnedBy(lines, at('THE GUARDIAN'), 'Be More Chill'), true);
  assert.equal(captionOwnedBy(['text', 'some prose line.', 'FINANCIAL TIMES'], 2, 'Be More Chill'), null);
  // a wrapped masthead is not a caption (real King Lear 2018 skeleton: INTERNATIONAL / NEW YORK TIMES)
  assert.equal(captionOwnedBy(['INTERNATIONAL', 'NEW YORK TIMES', '28.07.18'], 1, 'King Lear'), null);
  // a long foreign title wrapping over two caps lines (After Life skeleton)
  assert.equal(captionOwnedBy(['ADVENTURES WITH THE', 'PAINTED PEOPLE', 'DAILY MAIL'], 2, 'After Life'), false);
  // a title that shares a real word stays unknown rather than being dropped
  assert.equal(captionOwnedBy(['PRIDE AND PREJUDICE* (*SORT OF)', 'GUARDIAN'], 1, 'Pride and Prejudice (sort of)'), true);
});

test('default and raw parsers drop the review captioned with another show', () => {
  const def = parseDefaultPdfReviews(chillIssue, 'Be More Chill', null);
  const outlets = def.map(r => `${r.outlet}|${r.date}`);
  assert.ok(outlets.some(o => o.includes('12 July 2021')), 'ours kept');
  assert.ok(!outlets.some(o => o.includes('16 July 2021')), 'South Pacific review dropped: ' + outlets);
});

test('caption guard: raw and layout parsers drop foreign caption, trailing caption is stripped', () => {
  const raw = parseRawPdfReviews(chillIssue, 'Be More Chill', null);
  const rawKeys = raw.map(r => r.date);
  assert.ok(rawKeys.some(d => d.includes('12 July 2021')), 'raw keeps ours');
  assert.ok(!rawKeys.some(d => d.includes('16 July 2021')), 'raw drops South Pacific: ' + rawKeys);
  const lay = parsePdfReviews(['BE MORE CHILL', ...chillIssue.split('\n')].join('\n'), 'Be More Chill', {});
  assert.ok(!lay.some(r => r.date.includes('16 July 2021')), 'layout drops South Pacific');
  for (const r of [...raw, ...lay]) assert.ok(!/(SOUTH PACIFIC|BE MORE CHILL)\s*$/.test(r.fullText), 'caption leaked: ' + r.fullText.slice(-40));
});

test('captionOwnedBy: domain-like outlets and blank gaps', () => {
  assert.equal(captionOwnedBy(['WHATSONSTAGE.COM', 'THE GUARDIAN'], 1, 'Frozen'), null);
  assert.equal(captionOwnedBy(['FROZEN', '', 'THE GUARDIAN'], 2, 'Frozen'), true);
});

// BRO-6287: structure copied from the masked raw diagnostic of Be More Chill
// (vol 41 issue 13). pdftotext glues each page's form feed to the next page's
// first line, so a page-top caption ("...\fTHE WINTER'S TALE") was invisible,
// and only a block's first review has a caption; later ones must inherit it.
test('raw parser: form-feed captions and caption inheritance drop another show\'s later reviews', () => {
  const body = 'Be More Chill: the staging is lively and the songs land well, with a cast that sells every beat of the show. '.repeat(4);
  const foreign = 'A Winter\'s Tale with a spare, fast staging and a company that handles the verse with ease and speed. '.repeat(4);
  const issue = [
    'Jane Doe\fBE MORE CHILL', 'EVERYTHING-THEATRE.CO.UK', '07 July 2021', 'Mary Pollard', body,
    'DAILY MAIL', '16 July 2021', 'Patrick Marmion', body,
    'last words of page\fTHE WINTER’S TALE', 'THE STAGE', '12 July 2021', 'Olivia Rook', foreign,
    'CHICHESTER OBSERVER', '13 July 2021', 'Phil Hewitt', foreign,
    'FINANCIAL TIMES', '16 July 2021', 'Sarah Hemming', foreign,
    'page end\fBE MORE CHILL', 'THE GUARDIAN', '14 July 2021', 'Third Critic', body,
  ].join('\n');
  const raw = parseRawPdfReviews(issue, 'Be More Chill', null);
  const got = raw.map(r => `${r.outlet}|${r.date}`).join(' ; ');
  assert.ok(/Daily Mail\|16 July 2021/.test(got), 'ours kept (inherits our caption): ' + got);
  assert.ok(/Guardian\|14 July 2021/.test(got), 'ours after a foreign block kept: ' + got);
  for (const d of ['12 July 2021|', '13 July 2021|']) assert.ok(!got.includes(d), 'foreign dropped');
  assert.ok(!/Financial Times\|16 July 2021/.test(got), 'foreign FT (no caption of its own) dropped: ' + got);
  assert.ok(!/Stage\|12 July/.test(got) && !/Chichester/.test(got), got);
  // inheritance is a raw/default behaviour only: the bare call stays unknown
  const lines = issue.split(/\n|\f/);
  const ft = lines.indexOf('FINANCIAL TIMES');
  assert.equal(captionOwnedBy(lines, ft, 'Be More Chill'), null);
  assert.equal(captionOwnedBy(lines, ft, 'Be More Chill', { inherit: true }), false);
  // our own caption between a foreign block and the review restores ownership
  assert.equal(captionOwnedBy(lines, lines.indexOf('THE GUARDIAN'), 'Be More Chill', { inherit: true }), true);
});

// BRO-6287 ship-check: inheritance must not outrank a positive run-line match,
// must stop at a run-dates line, and must work in default mode too.
test('caption inheritance: run line and wrapped titles stop it; default mode inherits', () => {
  const body = 'Be More Chill: the staging is lively and the songs land well, with a cast that sells every beat of the show. '.repeat(4);
  const foreign = 'A Winter\'s Tale with a spare, fast staging and a company that handles the verse with ease and speed. '.repeat(4);
  const lines = [
    'THE WINTER’S TALE', 'THE STAGE', '12 July 2021', 'Olivia Rook', foreign,
    '01 Jun 2021 – 30 Sep 2021', 'BE MORE CHILL', 'THE GUARDIAN', '14 July 2021', 'Critic', body,
  ];
  // our run line sits between the foreign review and ours: inheritance gives up
  assert.equal(captionOwnedBy(lines, lines.indexOf('THE GUARDIAN'), 'Be More Chill', { inherit: true }), true);
  const noCaption = ['THE WINTER’S TALE', 'THE STAGE', '12 July 2021', 'Olivia Rook', foreign, '01 Jun 2021 – 30 Sep 2021', 'BE MORE CHILL', 'x', 'THE GUARDIAN', '14 July 2021'];
  assert.equal(captionOwnedBy(noCaption, 8, 'Be More Chill', { inherit: true }), null);
  // a wrapped title of ours between the blocks stops the walk
  const wrapped = ['SOUTH PACIFIC', 'THE STAGE', '12 July 2021', 'A', foreign, 'THE CURIOUS INCIDENT OF THE DOG', 'IN THE NIGHT-TIME', 'text', 'THE GUARDIAN', '14 July 2021'];
  assert.equal(captionOwnedBy(wrapped, 8, 'The Curious Incident of the Dog in the Night-Time', { inherit: true }), null);
  // default mode: foreign block's caption-less second review is dropped
  const def = ['SOUTH PACIFIC', 'THE STAGE', '12 July 2021', 'Olivia Rook', foreign + ' Be More Chill.', 'FINANCIAL TIMES', '16 July 2021', 'Sarah Hemming', foreign + ' Be More Chill.',
    'BE MORE CHILL', 'THE GUARDIAN', '14 July 2021', 'Third Critic', body, 'THE TIMES', '15 July 2021', 'Fourth Critic', body].join('\n');
  const got = parseDefaultPdfReviews(def, 'Be More Chill', null).map(r => r.date).join(',');
  assert.ok(!got.includes('16 July 2021') && !got.includes('12 July 2021'), got);
  assert.ok(got.includes('14 July 2021') && got.includes('15 July 2021'), got);
});

// BRO-6302: a shared common word (KING, LOVE, NIGHT) no longer makes another
// production's block "unknown". King Lear (2018) kept EXIT THE KING's and THE
// KING AND I's reviews; Love Letters (2021) kept LOVE BITES'.
const { sharesTitleWord } = require('./tr-pdf-parse.js');
test('BRO-6302 sectionOwnedBy: a block sharing only a common title word is foreign', () => {
  const runs = productionRuns(['X', '03 October - 02 December 2018', 'EXIT THE KING', 'a', 'b', '04 December - 02 January 2019', 'THE KING AND I', 'c']);
  assert.equal(sectionOwnedBy(runs, 3, 'King Lear'), false);
  assert.equal(sectionOwnedBy(runs, 7, 'King Lear'), false);
  assert.equal(sectionOwnedBy(runs, 3, 'Exit the King'), true);
  const r2 = productionRuns(['X', '01 May - 30 June 2021', 'LOVE BITES', 'a']);
  assert.equal(sectionOwnedBy(r2, 3, 'Love Letters'), false);
  // A distinctive shared word still reads as TR's own spelling of our title.
  assert.equal(sectionOwnedBy(r2, 3, 'Love Bites Back'), null);
});
test('BRO-6302 captionOwnedBy: a caption sharing only a common word is foreign', () => {
  const lines = ['LONG DAY’S JOURNEY', 'x', 'MY NIGHT WITH REG', 'FINANCIAL TIMES', '16 July 2018', 'body'];
  assert.equal(captionOwnedBy(lines, 3, "Long Day's Journey into Night"), false);
  assert.equal(captionOwnedBy(lines, 3, 'My Night with Reg'), true);
});
test('BRO-6302 sharesTitleWord: generic words ignored unless the title has nothing else', () => {
  assert.equal(sharesTitleWord('THE SHARK IS BROKEN', 'Broken Lad'), false);
  assert.equal(sharesTitleWord('THE LION KING', 'The Lion King (revival)'), true);
  // All-generic title keeps its words so TR spelling variants stay unknown.
  assert.equal(sharesTitleWord('COME FROM AWAY!', 'Come From Away'), true);
  assert.equal(sharesTitleWord('PIGEON ENGLISH', 'Pride and Prejudice'), false);
});
test('BRO-6302 review round: TR short forms and hyphen-wrapped captions stay ours', () => {
  // Every caption word is in our title: TR's short form, not another show.
  assert.equal(sharesTitleWord('ALL OUT', 'All Out: Comedy About Ambition'), true);
  assert.equal(sharesTitleWord('THE CHRISTMAS PRINCE', 'The (Very Gay) Christmas Prince'), true);
  // One shared generic word is still not enough (THE KING AND I under King Lear).
  assert.equal(sharesTitleWord('THE KING AND I', 'King Lear'), false);
  const lines = ['A MIDSUM-', 'MER NIGHT\u2019S DREAM', 'FINANCIAL TIMES', '16 July 2018', 'body'];
  assert.notEqual(captionOwnedBy(lines, 2, "A Midsummer Night's Dream"), false);
});
test('BRO-6302 all-common-word title: a block naming something else is foreign', () => {
  assert.equal(sharesTitleWord('KING LEAR', 'The King and I'), false);
  assert.equal(sharesTitleWord('EXIT THE KING', 'The King and I'), false);
  assert.equal(sharesTitleWord('KING AND I', 'The King and I'), true);
  const runs = productionRuns(['X', '03 July - 02 September 2018', 'THE KING AND I', 'a', 'b', '25 July - 02 October 2018', 'KING LEAR', 'c']);
  assert.equal(sectionOwnedBy(runs, 3, 'The King and I'), true);
  assert.equal(sectionOwnedBy(runs, 7, 'The King and I'), false);
});
test('BRO-6302 a one-word caption that opens our title stays ours', () => {
  assert.equal(sharesTitleWord('ALL IN', 'All In: Comedy About Love'), true);
  assert.equal(sharesTitleWord('KING', 'King Lear'), true);
  assert.equal(sharesTitleWord('KING', 'The Lion King'), false);
});

// BRO-6507: skeleton windows must reach the review page, not stop at index hits.
import { createRequire as __cr6507 } from 'node:module';
import { test as __t6507 } from 'node:test';
import __a6507 from 'node:assert/strict';
__t6507('skeletonKeepLines prefers the bare title line over contents/index hits', () => {
  const { skeletonKeepLines } = __cr6507(import.meta.url)('./tr-pdf-parse.js');
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(`NO MAN'S LAND - Review of the play ${i}`);
  for (let i = 0; i < 400; i++) lines.push(`filler ${i}`);
  lines.push('NO MAN\u2019S LAND   Index');
  const keep = skeletonKeepLines(lines, "No Man's Land");
  __a6507.ok(keep.has(lines.length - 1), 'reaches the bare title line');
  __a6507.ok(keep.has(lines.length - 100));
  __a6507.ok(!keep.has(250), 'does not spend the window on contents hits');
});
