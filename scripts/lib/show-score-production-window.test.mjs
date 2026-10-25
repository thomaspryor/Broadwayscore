// BRO-5866: Show Score page must belong to this production (date window).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkProductionWindow,
  checkShowScoreProduction,
  checkPageProductionWindow,
  exemptionFor,
  slugNamesVenue,
  extractPageDates,
} = require('./show-score-production-window.js');

const safeHouse2026 = {
  id: 'safe-house-off-broadway-2026',
  previewsStartDate: '2026-09-04',
  openingDate: '2026-09-18',
  venue: 'Theatre Row',
};
// The St. Ann's Warehouse 2025 page's critic dates.
const stAnns2025 = ['February 21st, 2025', 'February 24th, 2025', 'February 25th, 2025', 'March 2nd, 2025'];

test('Safe House 2026 rejects the 2025 St. Ann\'s page', () => {
  const r = checkProductionWindow(stAnns2025, safeHouse2026);
  assert.equal(r.ok, false);
  assert.match(r.reason, /predate/);
  assert.equal(r.outside, 4);
});

test('dates inside the run pass', () => {
  const r = checkProductionWindow(['Sep 20, 2026', 'Sep 21, 2026', 'September 22nd, 2026'], safeHouse2026);
  assert.equal(r.ok, true);
});

test('one stray early date cannot save a wrong page, but a mostly-in-window page passes', () => {
  const show = { previewsStartDate: '2026-01-10' };
  const mostlyIn = ['Jan 1, 2020', 'Jan 20, 2026', 'Jan 21, 2026', 'Jan 22, 2026', 'Jan 23, 2026'];
  assert.equal(checkProductionWindow(mostlyIn, show).ok, true);
});

test('page from a much later production fails the late side', () => {
  const show = { openingDate: '2007-03-29', closingDate: '2007-08-25' };
  const r = checkProductionWindow(['Nov 3, 2016', 'Dec 1, 2016', 'Jan 5, 2017'], show);
  assert.equal(r.ok, false);
  assert.match(r.reason, /after this production closed/);
});

test('later dates with no closing date are not judged (open run)', () => {
  const show = { openingDate: '2014-01-01' };
  assert.equal(checkProductionWindow(['Nov 3, 2022', 'Dec 1, 2022', 'Jan 5, 2023'], show).ok, true);
});

test('fewer than 3 dates or no start date: ok, no guess', () => {
  assert.equal(checkProductionWindow(stAnns2025.slice(0, 2), safeHouse2026).ok, true);
  assert.equal(checkProductionWindow(stAnns2025, { id: 'x' }).ok, true);
  assert.equal(checkProductionWindow(stAnns2025, null).ok, true);
});

test('venue-named slug exempts a carried-over page', () => {
  const show = { id: 'mexodus-x', previewsStartDate: '2026-01-01', venue: 'Daryl Roth Theatre' };
  const url = 'https://www.show-score.com/off-broadway-shows/mexodus-daryl-roth-theatre';
  assert.equal(slugNamesVenue(url, show.venue), true);
  const r = checkShowScoreProduction(['Jan 1, 2024', 'Feb 1, 2024', 'Mar 1, 2024'], show, url);
  assert.equal(r.ok, true);
  assert.equal(r.exempt, true);
  // Safe House's plain slug does not name Theatre Row.
  assert.equal(slugNamesVenue('https://www.show-score.com/off-broadway-shows/safe-house', 'Theatre Row'), false);
  assert.equal(exemptionFor(safeHouse2026, 'https://www.show-score.com/off-broadway-shows/safe-house'), null);
});

test('SAME_PRODUCTION list exempts reviewed continuing runs', () => {
  const show = { id: 'slave-play-2021', previewsStartDate: '2021-11-23', venue: 'August Wilson Theatre' };
  const r = checkShowScoreProduction(['Oct 6, 2019', 'Oct 7, 2019', 'Oct 8, 2019'], show, 'https://www.show-score.com/broadway-shows/slave-play');
  assert.equal(r.ok, true);
  assert.equal(r.exempt, true);
});

test('extractPageDates reads Show Score date formats from html', () => {
  const html = '<div>February 21st, 2025</div><span>Feb 24, 2025</span><p>Sept. 3, 2025</p><p>no date 2025</p>';
  assert.deepEqual(extractPageDates(html), ['February 21st, 2025', 'Feb 24, 2025', 'Sept. 3, 2025']);
  assert.deepEqual(extractPageDates(''), []);
});

test('checkPageProductionWindow works end to end on html', () => {
  const html = stAnns2025.map((d) => `<time>${d}</time>`).join('');
  assert.equal(checkPageProductionWindow(html, safeHouse2026, 'https://www.show-score.com/off-broadway-shows/safe-house').ok, false);
});

test('dates inside a declared prior run count as this production (return engagement)', () => {
  const show = { id: 'rheology-off-broadway-2026', previewsStartDate: '2026-03-01', priorRuns: [{ openingDate: '2025-04-15', closingDate: '2025-05-15', venue: 'Bushwick Starr' }] };
  const dates = ['Apr 16, 2025', 'Apr 20, 2025', 'May 1, 2025'];
  assert.equal(checkProductionWindow(dates, show).ok, true);
  // A run marked inheritReviews:false is a separate production: still rejected.
  const separate = { ...show, priorRuns: [{ ...show.priorRuns[0], inheritReviews: false }] };
  assert.equal(checkProductionWindow(dates, separate).ok, false);
});
