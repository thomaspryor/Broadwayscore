// Tests for pickTrProduction (BRO-4851). The Oedipus fixtures are the real
// Theatre Record results seen in pilot run 37713373821.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickTrProduction, archiveMonth, pressNightWindow } = require('./tr-production-pick.js');

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
