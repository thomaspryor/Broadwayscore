// Regression test for compareShow()'s priorRuns corroboration (BRO-2544):
// test.yml's "Validate provisional show venue+dates against Playbill" step
// went red on two genuine recurring/remounted Off-Broadway shows whose
// current shows.json dates were verified correct (BroadwayWorld/TheaterMania
// season announcements) but whose only indexed Playbill production page
// described an EARLIER run at the same venue — the-dead-1904-off-broadway-2026
// (2026 remount vs Playbill's still-indexed 2024 page) and
// othello-bedlam-off-broadway-2026 (Nov 2026 encore vs Playbill's page for the
// May 2026 original run). Uses the real compareShow()/findCorroboratingPriorRun()
// functions (CLAUDE.md §15) — never re-implement the corroboration logic here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareShow, findCorroboratingPriorRun, daysBetween, urlYear } =
  require('./venue-date-compare.js');

const DEAD_1904_SHOW = {
  id: 'the-dead-1904-off-broadway-2026',
  title: 'The Dead, 1904',
  venue: 'American Irish Historical Society',
  openingDate: '2026-11-24',
  closingDate: '2027-01-03',
  category: 'off-broadway',
  isRevival: true,
  priorRuns: [
    { openingDate: '2024-11-26', closingDate: '2025-01-05', venue: 'American Irish Historical Society' },
  ],
};
const DEAD_1904_PARSED = {
  titleParse: { rawTitle: 'The Dead, 1904', market: 'Off-Broadway', venue: 'The American Irish Historical Society', year: 2024 },
  dates: { firstPreview: null, openingDate: '2024-11-26', closingDate: '2025-01-05' },
  tagLine: { revivalStatus: 'unknown' },
};
const DEAD_1904_URL = 'https://playbill.com/production/the-dead-1904-off-broadway-the-american-irish-historical-society-2024';

const OTHELLO_SHOW = {
  id: 'othello-bedlam-off-broadway-2026',
  title: 'Othello (Bedlam)',
  venue: 'West End Theatre',
  openingDate: null,
  closingDate: '2026-11-29',
  category: 'off-broadway',
  isRevival: true,
  priorRuns: [
    { openingDate: '2026-05-10', closingDate: '2026-05-31', venue: 'West End Theatre' },
  ],
};
const OTHELLO_PARSED = {
  titleParse: { rawTitle: 'Othello', market: 'Off-Broadway', venue: 'The West End Theatre', year: 2026 },
  dates: { firstPreview: null, openingDate: '2026-05-10', closingDate: '2026-05-31' },
  tagLine: { revivalStatus: 'unknown' },
};
const OTHELLO_URL = 'https://playbill.com/production/othello-off-broadway-the-west-end-theatre-2026';

test('compareShow: The Dead, 1904 2026 remount is fully explained by its 2024 priorRun (no unexplained mismatches)', () => {
  const { mismatches, explainedByPriorRun } = compareShow(DEAD_1904_SHOW, DEAD_1904_PARSED, DEAD_1904_URL);
  assert.deepEqual(mismatches, []);
  const fields = explainedByPriorRun.map(m => m.field).sort();
  assert.deepEqual(fields, ['closingDate', 'opening-year', 'openingDate']);
  // venue never enters either bucket — normalizeVenueName's leading-"The" strip
  // (venue-classification.js) already makes "American Irish Historical Society"
  // ≡ "The American Irish Historical Society" via venuesMatch(), so there's no
  // venue mismatch to explain in the first place.
  assert.ok(!mismatches.some(m => m.field === 'venue'));
  assert.ok(!explainedByPriorRun.some(m => m.field === 'venue'));
});

test('compareShow: Bedlam Othello Nov 2026 encore is explained by its May 2026 priorRun', () => {
  const { mismatches, explainedByPriorRun } = compareShow(OTHELLO_SHOW, OTHELLO_PARSED, OTHELLO_URL);
  assert.deepEqual(mismatches, []);
  assert.deepEqual(explainedByPriorRun.map(m => m.field), ['closingDate']);
});

test('compareShow: an unrelated priorRuns entry does NOT suppress a genuine mismatch', () => {
  const show = {
    id: 'fake-show-off-broadway-2026',
    title: 'Fake Show',
    venue: 'Real Venue',
    openingDate: '2026-11-24',
    closingDate: '2027-01-03',
    category: 'off-broadway',
    priorRuns: [
      { openingDate: '2024-11-26', closingDate: '2025-01-05', venue: 'Real Venue' },
    ],
  };
  const parsed = {
    titleParse: { rawTitle: 'Fake Show', market: 'Off-Broadway', venue: 'Totally Different Venue', year: 2023 },
    dates: { firstPreview: null, openingDate: '2023-03-01', closingDate: '2023-04-01' },
    tagLine: { revivalStatus: 'unknown' },
  };
  const url = 'https://playbill.com/production/fake-show-off-broadway-totally-different-venue-2023';
  const { mismatches, explainedByPriorRun } = compareShow(show, parsed, url);
  assert.deepEqual(mismatches.map(m => m.field).sort(), ['closingDate', 'opening-year', 'openingDate', 'venue']);
  assert.deepEqual(explainedByPriorRun, []);
});

test('compareShow: a show with no priorRuns behaves exactly as before (real mismatch surfaces)', () => {
  const show = {
    id: 'no-prior-runs-off-broadway-2026',
    title: 'No Prior Runs',
    venue: 'Some Venue',
    openingDate: '2026-11-24',
    closingDate: '2027-01-03',
    category: 'off-broadway',
  };
  const parsed = {
    titleParse: { rawTitle: 'No Prior Runs', market: 'Off-Broadway', venue: 'Some Venue', year: 2024 },
    dates: { firstPreview: null, openingDate: '2024-11-26', closingDate: '2025-01-05' },
    tagLine: { revivalStatus: 'unknown' },
  };
  const url = 'https://playbill.com/production/no-prior-runs-off-broadway-some-venue-2024';
  const { mismatches, explainedByPriorRun } = compareShow(show, parsed, url);
  assert.deepEqual(explainedByPriorRun, []);
  assert.deepEqual(mismatches.map(m => m.field).sort(), ['closingDate', 'opening-year', 'openingDate']);
});

test('findCorroboratingPriorRun: requires BOTH venue match and a date within 30 days — venue-only match is not enough', () => {
  const show = {
    priorRuns: [{ openingDate: '2020-01-01', closingDate: '2020-02-01', venue: 'Some Venue' }],
  };
  const parsed = {
    titleParse: { venue: 'Some Venue' },
    dates: { openingDate: '2024-11-26', closingDate: '2025-01-05' },
  };
  assert.equal(findCorroboratingPriorRun(show, parsed), null);
});

test('findCorroboratingPriorRun: returns null when show has no priorRuns', () => {
  assert.equal(findCorroboratingPriorRun({ priorRuns: [] }, DEAD_1904_PARSED), null);
  assert.equal(findCorroboratingPriorRun({}, DEAD_1904_PARSED), null);
});

test('daysBetween / urlYear still work as re-exported (parity with the pre-extraction inline versions)', () => {
  assert.equal(daysBetween('2024-11-26', '2025-01-05'), 40);
  assert.equal(daysBetween(null, '2025-01-05'), null);
  assert.equal(urlYear('https://playbill.com/production/foo-off-broadway-bar-2026'), 2026);
  assert.equal(urlYear('https://playbill.com/production/foo-off-broadway-bar'), null);
});
