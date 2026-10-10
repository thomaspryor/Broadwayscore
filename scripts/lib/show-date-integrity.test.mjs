import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { previewsAfterOpening, excessivePreviewGap, inheritedDateFromSibling, suspiciousInheritedYear } = require('./show-date-integrity.js');

test('excessivePreviewGap: flags previews implausibly far before opening (wrong-production previews)', () => {
  // sunset-baby: 2013 original's previews on the 2024 revival.
  assert.equal(excessivePreviewGap({ previewsStartDate: '2013-12-17', openingDate: '2024-02-22' }), true);
  // a-midsummer 1971: a 1-year-off previews typo.
  assert.equal(excessivePreviewGap({ previewsStartDate: '1970-01-16', openingDate: '1971-01-20' }), true);
  // oratorio: 2022 vs 2025.
  assert.equal(excessivePreviewGap({ previewsStartDate: '2022-02-15', openingDate: '2025-10-16' }), true);
});

test('excessivePreviewGap: normal previews windows are fine', () => {
  assert.equal(excessivePreviewGap({ previewsStartDate: '2024-04-30', openingDate: '2024-05-22' }), false); // 3 weeks
  assert.equal(excessivePreviewGap({ previewsStartDate: '2026-10-08', openingDate: '2026-10-29' }), false);
  assert.equal(excessivePreviewGap({ previewsStartDate: '2024-12-04', openingDate: '2024-05-22' }), false); // previews-after-opening (handled elsewhere)
  assert.equal(excessivePreviewGap({ openingDate: '2024-05-22' }), false);
  assert.equal(excessivePreviewGap(null), false);
});

test('excessivePreviewGap: COVID-delayed shows are exempt (previews pre-shutdown, opening post-reopen)', () => {
  assert.equal(excessivePreviewGap({ previewsStartDate: '2020-02-25', openingDate: '2022-04-17' }), false); // The Minutes
  assert.equal(excessivePreviewGap({ previewsStartDate: '2020-03-02', openingDate: '2021-12-09' }), false); // Company
  assert.equal(excessivePreviewGap({ previewsStartDate: '2020-03-07', openingDate: '2021-10-14' }), false); // Lehman Trilogy
  // a >1yr gap NOT spanning the shutdown is still flagged
  assert.equal(excessivePreviewGap({ previewsStartDate: '2024-02-13', openingDate: '2025-02-24' }), true); // grangeville (377d)
});

test('previewsAfterOpening: true only when previews date is after opening', () => {
  assert.equal(previewsAfterOpening({ previewsStartDate: '2024-12-04', openingDate: '2024-05-22' }), true); // three-houses bug
  assert.equal(previewsAfterOpening({ previewsStartDate: '2024-04-30', openingDate: '2024-05-22' }), false); // fixed
  assert.equal(previewsAfterOpening({ previewsStartDate: '2024-05-22', openingDate: '2024-05-22' }), false); // same day
  assert.equal(previewsAfterOpening({ openingDate: '2024-05-22' }), false);
  assert.equal(previewsAfterOpening(null), false);
});

test('inheritedDateFromSibling: exact openingDate match with a same-title sibling → flagged (the clone bugs)', () => {
  // a-few-good-men-2026 carrying the 1989 production's opening date.
  const sibs = [{ id: 'a-few-good-men-1989', openingDate: '1989-11-15' }];
  const v = inheritedDateFromSibling({ id: 'a-few-good-men-2026', openingDate: '1989-11-15' }, sibs);
  assert.equal(v?.field, 'openingDate');
  assert.equal(v?.siblingId, 'a-few-good-men-1989');
});

test('inheritedDateFromSibling: previewsStartDate match also flagged', () => {
  const sibs = [{ id: 'x-2014', previewsStartDate: '2013-12-17' }];
  const v = inheritedDateFromSibling({ id: 'x-2024', previewsStartDate: '2013-12-17' }, sibs);
  assert.equal(v?.field, 'previewsStartDate');
});

test('inheritedDateFromSibling: distinct dates → null (legit; different productions open different nights)', () => {
  // Book of Mormon WE (2013) vs BW (2011) — different opening dates, NOT flagged.
  const sibs = [{ id: 'book-of-mormon-2011', openingDate: '2011-03-24' }];
  assert.equal(inheritedDateFromSibling({ id: 'the-book-of-mormon-west-end-2024', openingDate: '2013-03-21' }, sibs), null);
  // fixed revival with real distinct date
  assert.equal(inheritedDateFromSibling({ id: 'a-few-good-men-2026', openingDate: '2026-10-29' }, [{ id: 'a-few-good-men-1989', openingDate: '1989-11-15' }]), null);
  assert.equal(inheritedDateFromSibling({ id: 'x-2026', openingDate: '2026-01-01' }, []), null);
  assert.equal(inheritedDateFromSibling(null, []), null);
});

const NOW = 2026;

test('suspiciousInheritedYear: warns on recent-id revival with a decades-older opening, pre-open', () => {
  // awake-and-sing-2026 with the original 1935 opening (namesake NOT a same-date sibling).
  assert.equal(suspiciousInheritedYear({ id: 'awake-and-sing-2026', openingDate: '1935-02-19', status: 'open' }, NOW), true);
  assert.equal(suspiciousInheritedYear({ id: 'a-few-good-men-2026', openingDate: '1989-11-15', status: 'open' }, NOW), true);
});

test('suspiciousInheritedYear: does NOT warn after the fix, nor on non-recent-id long-runners', () => {
  assert.equal(suspiciousInheritedYear({ id: 'a-few-good-men-2026', openingDate: '2026-10-29', status: 'upcoming' }, NOW), false);
  // WE long-runner with a 2021 (non-recent) import id — excluded by recency.
  assert.equal(suspiciousInheritedYear({ id: 'les-miserables-west-end-2021', openingDate: '1985-12-04', status: 'open' }, NOW), false);
  // closed historical backfill — excluded by status gate.
  assert.equal(suspiciousInheritedYear({ id: 'kinky-boots-off-broadway-2026', openingDate: '2022-08-25', status: 'closed' }, NOW), false);
});

test('suspiciousInheritedYear: a recent-import long-runner CAN warn (acceptable — warning, not error)', () => {
  // book-of-mormon-west-end-2024 opened 2013: idY recent + 11y gap + open → warns (noise tolerated).
  assert.equal(suspiciousInheritedYear({ id: 'the-book-of-mormon-west-end-2024', openingDate: '2013-03-21', status: 'open' }, NOW), true);
});
