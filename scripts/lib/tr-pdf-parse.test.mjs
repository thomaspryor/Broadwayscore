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
