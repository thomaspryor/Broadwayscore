// BRO-5320: audit-run-contamination reports a review dated inside an earlier run's window.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const audit = require('../../scripts/audit-run-contamination.js');

test('class 2: opt-out prior run row is reported, not explained (Comedy About Spies 2026)', () => {
  const shows = [{
    id: 'spies-2026', previewsStartDate: '2026-08-01', openingDate: '2026-08-06',
    priorRuns: [{ openingDate: '2025-04-14', closingDate: '2025-08-03', inheritReviews: false }],
  }];
  const rows = ['2025-05-13', '2025-05-14', '2025-06-18'].map((publishDate, i) => ({ showId: 'spies-2026', outletId: `o${i}`, criticName: 'X', publishDate }));
  const r = audit.class2({ shows, rows, files: new Map() });
  assert.equal(r.byWhy['opt-out-prior-run'], 3);
  assert.equal(r.unexplained, 3);
});

test('class 5: a 2020 review copied onto an unlinked 2021 run is reported (Leopoldstadt)', () => {
  const shows = [
    { id: 'leo-2020', previewsStartDate: '2020-01-25', openingDate: '2020-02-12', closingDate: '2020-03-14' },
    { id: 'leo-2021', previewsStartDate: '2021-08-07', openingDate: '2021-08-07', closingDate: '2021-10-30' },
  ];
  const rows = [
    { showId: 'leo-2020', url: 'https://standard.co.uk/leo', publishDate: '2020-02-13' },
    { showId: 'leo-2021', url: 'https://standard.co.uk/leo', publishDate: '2020-02-13' },
  ];
  assert.equal(audit.class5({ shows, rows }).sameUrlTwoShows, 1);
});

test('class 5: linked runs (priorRuns) are not reported', () => {
  const shows = [
    { id: 'leo-2020', previewsStartDate: '2020-01-25', openingDate: '2020-02-12', closingDate: '2020-03-14' },
    { id: 'leo-2021', previewsStartDate: '2021-08-07', openingDate: '2021-08-07', closingDate: '2021-10-30', priorRuns: ['leo-2020'] },
  ];
  const rows = [
    { showId: 'leo-2020', url: 'https://standard.co.uk/leo', publishDate: '2020-02-13' },
    { showId: 'leo-2021', url: 'https://standard.co.uk/leo', publishDate: '2020-02-13' },
  ];
  assert.equal(audit.class5({ shows, rows }).sameUrlTwoShows, 0);
});
