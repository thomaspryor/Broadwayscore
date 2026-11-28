// Tests for pickTrProduction (BRO-4851). The Oedipus fixtures are the real
// Theatre Record results seen in pilot run 37713373821.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trTitleMatches, pickTrProduction, archiveMonth, pdfEraDate, windowFit, pressNightWindow } = require('./tr-production-pick.js');

const isLondonVenue = v => /london/i.test(v);
const OLD_VIC = { title: 'Oedipus', venue: 'The Old Vic Theatre, London', link: 'https://www.theatrerecord.com/archive/2025/2/17206-oedipus' };
const WYNDHAMS = { title: 'Oedipus', venue: "Wyndham's Theatre, London", link: 'https://www.theatrerecord.com/archive/2024/10/16980-oedipus' };
const EDINBURGH = { title: 'Oedipus', venue: 'Royal Lyceum, Edinburgh', link: 'https://www.theatrerecord.com/archive/2024/10/16990-oedipus' };

const wyndhamsShow = { id: 'oedipus-west-end-2024', title: 'Oedipus', venue: "Wyndham's Theatre", previewsStartDate: '2024-10-04', openingDate: '2024-10-15', closingDate: '2025-01-04', status: 'closed' };
const oldVicShow = { id: 'oedipus-west-end-2025', title: 'Oedipus', venue: 'The Old Vic', previewsStartDate: '2025-01-21', openingDate: '2025-02-04', closingDate: '2025-03-29', status: 'closed' };

test('archiveMonth reads the archive link month; PDF-era links are undated', () => {
  assert.equal(archiveMonth(OLD_VIC.link), 2025 * 12 + 1);
  assert.equal(archiveMonth('https://www.theatrerecord.com/archive/volume/38/dest/oedipus'), null);
});

test('the 2024 Wyndham\'s row does NOT get the newer Old Vic production (newest-first search)', () => {
  assert.equal(pickTrProduction([OLD_VIC, WYNDHAMS], wyndhamsShow, { isLondonVenue }), WYNDHAMS);
  assert.equal(pickTrProduction([OLD_VIC, WYNDHAMS], oldVicShow, { isLondonVenue }), OLD_VIC);
});

test('a closed show whose only dated match is another year gets nothing', () => {
  assert.equal(pickTrProduction([OLD_VIC], wyndhamsShow, { isLondonVenue }), null);
});

test('own venue beats any London venue inside the window', () => {
  const otherLondon = { ...WYNDHAMS, venue: 'Barbican Theatre, London', link: 'https://www.theatrerecord.com/archive/2024/10/1-oedipus' };
  assert.equal(pickTrProduction([otherLondon, WYNDHAMS], wyndhamsShow, { isLondonVenue }), WYNDHAMS);
  assert.equal(pickTrProduction([EDINBURGH, otherLondon], { ...wyndhamsShow, venue: 'Somewhere Else' }, { isLondonVenue }), otherLondon);
});

test('undated (PDF-era) results remain usable for a closed show', () => {
  const pdf = { title: 'Oedipus', venue: "Wyndham's Theatre, London", link: 'https://www.theatrerecord.com/archive/volume/40/dest/oedipus' };
  assert.equal(pickTrProduction([OLD_VIC, pdf], wyndhamsShow, { isLondonVenue }), pdf);
});

test('open shows keep the old fallback when nothing is in the window', () => {
  const lesMis = { title: 'Les Misérables', venue: 'Sondheim Theatre, London', link: 'https://www.theatrerecord.com/archive/2019/12/1-les-mis' };
  const show = { title: 'Les Misérables', venue: 'Sondheim Theatre', openingDate: '1985-12-04', status: 'open' };
  assert.equal(pickTrProduction([lesMis], show, { isLondonVenue }), lesMis);
});

test('shows without dates use the old venue preference (hint venue first)', () => {
  const pick = pickTrProduction([OLD_VIC, WYNDHAMS], { title: 'Oedipus' }, { hintVenue: "Wyndham's Theatre, London", isLondonVenue });
  assert.equal(pick, WYNDHAMS);
  assert.equal(pressNightWindow({}), null);
});

// BRO-6127: real PDF-era links from probe run 40100130206. Volume = year - 1980,
// issue N (fortnightly) falls in month floor((N-1)/2).
const JOSEPH_2021 = { title: 'JOSEPH AND THE AMAZING TECHNICOLOR DREAMCOAT', venue: 'London Palladium, London', link: 'https://www.theatrerecord.com/archive/volume/41/dest/14_joseph_and_the_amazing_techn' };
const JOSEPH_2019 = { title: 'JOSEPH AND THE AMAZING TECHNICOLOR DREAMCOAT', venue: 'London, Palladium', link: 'https://www.theatrerecord.com/archive/volume/39/dest/13_joseph_and_the_amazing_techn' };
const josephShow = { id: 'joseph-and-the-amazing-technicolor-dreamcoat-west-end-2019', title: 'Joseph and the Amazing Technicolor Dreamcoat', venue: 'London Palladium', openingDate: '2019-07-11', status: 'closed' };

test('pdfEraDate reads volume/issue and volume/page links', () => {
  assert.deepEqual(pdfEraDate(JOSEPH_2019.link), { month: 2019 * 12 + 6 });
  assert.deepEqual(pdfEraDate('https://www.theatrerecord.com/archive/volume/37/page/743'), { year: 2017 });
  assert.equal(pdfEraDate('https://www.theatrerecord.com/archive/volume/38/dest/oedipus'), null);
  assert.equal(pdfEraDate(OLD_VIC.link), null);
});

test('a 2019 revival picks the 2019 PDF issue, not the 2021 reopening', () => {
  assert.equal(pickTrProduction([JOSEPH_2021, JOSEPH_2019], josephShow, { isLondonVenue }), JOSEPH_2019);
});

test('PDF-era links outside the window never null a closed show (dates can be wrong)', () => {
  const only = { title: 'Pretty Woman', venue: 'Savoy Theatre, London', link: 'https://www.theatrerecord.com/archive/volume/40/dest/05_pretty_woman__the_musical' };
  const show = { title: 'Pretty Woman: The Musical', venue: 'Savoy Theatre', openingDate: '2021-07-08', status: 'closed' };
  assert.equal(pickTrProduction([only], show, { isLondonVenue }), only);
  assert.equal(windowFit(only.link, pressNightWindow(show)), 'out');
});

test('closed show: an out-of-window regional result is no pick, an unknown venue is kept', () => {
  const link = 'https://www.theatrerecord.com/archive/volume/40/dest/05_pride_and_prejudice';
  const show = { title: 'Pride and Prejudice', venue: 'Criterion Theatre', openingDate: '2021-12-01', status: 'closed' };
  const regional = { title: 'Pride and Prejudice', venue: 'Storyhouse, Chester', link };
  assert.equal(pickTrProduction([regional], show, { isLondonVenue }), null);
  const unknown = { title: 'Pride and Prejudice', venue: '', link };
  assert.equal(pickTrProduction([unknown], show, { isLondonVenue }), unknown);
});

test('closed show: a non-London result inside the date window is still no pick', () => {
  const show = { title: 'Pride and Prejudice (sort of)', venue: 'Criterion Theatre', openingDate: '2021-11-03', previewsStartDate: '2021-10-15', status: 'closed' };
  const chester = { title: 'PRIDE AND PREJUDICE', venue: 'Grosvenor Park Open Air Theatre, Chester', link: 'https://www.theatrerecord.com/archive/volume/41/dest/14_pride_and_prejudice' };
  assert.equal(pickTrProduction([chester], show, { isLondonVenue }), null);
});

test('trTitleMatches accepts a TR tagline after a colon, and nothing looser', () => {
  assert.equal(trTitleMatches('CURTAINS: A MUSICAL WHODUNNIT', 'Curtains'), true);
  assert.equal(trTitleMatches('Curtains', 'Curtains'), true);
  assert.equal(trTitleMatches('Curtains for Us', 'Curtains'), false);
  assert.equal(trTitleMatches('Strike Up The Band', 'The Band'), false);
});

// BRO-6427: a search article can link to a listings/index page. It must not
// win the venue preference, even when there is no dated production match.
test('listings and archive indexes never become production picks', () => {
  const indexes = [
    '/listings/current-west-end',
    '/listings/current-london',
    '/search?query=Oedipus',
    '/archive',
    '/archive/2015',
    '/archive/volume/35',
    '/archive/volume/35/index',
    '/archive/2015/index',
  ];
  for (const path of indexes) {
    const index = { ...WYNDHAMS, link: `https://www.theatrerecord.com${path}` };
    for (const show of [wyndhamsShow, { ...wyndhamsShow, status: 'open' }, { title: 'Oedipus' }]) {
      assert.equal(pickTrProduction([index], show, { isLondonVenue }), null, path);
      assert.equal(pickTrProduction([index, WYNDHAMS], show, {
        isLondonVenue, hintVenue: "Wyndham's Theatre",
      }), WYNDHAMS, path);
    }
  }
});

test('BRO-6427 PDF page routes are production links, not listings indexes', () => {
  for (const [title, venue, link] of [
    ['End of Longing (The)', 'Playhouse', '/archive/volume/36/page/117'],
    ['Di and Viv and Rose', 'Vaudeville', '/archive/volume/35/page/95'],
    ['1984', 'Playhouse', '/archive/volume/35/page/632'],
  ]) {
    const production = { title, venue, link: `https://www.theatrerecord.com${link}` };
    assert.equal(pickTrProduction([production], { title, venue }, {}), production);
  }
});

test('production picker preserves issue PDFs and named archive sections', () => {
  for (const path of [
    '/archive/issue/608',
    '/archive/volume/39/dest/13_joseph_and_the_amazing_techn',
    '/archive/2025/fringe/35877-julia-1984',
    '/archive/2024/international/123-production',
    '/archive/latest/123-production',
  ]) {
    const production = { ...WYNDHAMS, link: `https://www.theatrerecord.com${path}` };
    assert.equal(pickTrProduction([production], { title: 'Oedipus' }, {}), production, path);
  }
});

test('malformed and off-site links cannot stand in for TR productions', () => {
  for (const link of [undefined, '', 'not a URL', 'https://example.com/archive/2024/10/16980-oedipus']) {
    assert.equal(pickTrProduction([{ ...WYNDHAMS, link }], wyndhamsShow, { isLondonVenue }), null);
  }
});
