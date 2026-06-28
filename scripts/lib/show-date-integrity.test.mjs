import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { previewsAfterOpening, inheritedDateFromSibling, suspiciousInheritedYear } = require('./show-date-integrity.js');

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
