import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { vetoBrokenDateChanges, changesBreakDateIntegrity, previewsAfterOpening, excessivePreviewGap, inheritedDateFromSibling, suspiciousInheritedYear } = require('./show-date-integrity.js');

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

// BRO-7131: the 120-day warning tier (a moved/postponed run that kept its old previews date).
import { createRequire as _cr } from 'node:module';
const { longPreviewGap: _lpg } = _cr(import.meta.url)('./show-date-integrity.js');
test('longPreviewGap warns on a 2024+ opening with >120 days of previews', () => {
  assert.equal(_lpg({ previewsStartDate: '2026-04-15', openingDate: '2026-11-06' }), true); // tango shape, 205 days
  assert.equal(_lpg({ previewsStartDate: '2026-09-01', openingDate: '2026-11-06' }), false); // 66 days, normal
  assert.equal(_lpg({ previewsStartDate: '2019-01-01', openingDate: '2019-08-01' }), false); // pre-2024: out of scope
  assert.equal(_lpg({ previewsStartDate: '2026-11-06', openingDate: '2026-11-06' }), false);
  assert.equal(_lpg({ openingDate: '2026-11-06' }), false);
});

test('changesBreakDateIntegrity (BRO-8234): vetoes the wrong-production enricher writes that failed validate-data', () => {
  // assassins-off-west-end-2014 matched to a 2027 listing.
  assert.equal(changesBreakDateIntegrity(
    { previewsStartDate: '2014-11-21', openingDate: '2014-12-01' },
    [{ field: 'openingDate', old: '2014-12-01', new: '2027-07-01' }]), true);
  // west-side-story-west-end-2026: previews 2026-11-12, opening null -> 2027-11-25 (378d).
  assert.equal(changesBreakDateIntegrity(
    { previewsStartDate: '2026-11-12', openingDate: null },
    [{ field: 'openingDate', old: null, new: '2027-11-25' }]), true);
  // previews written after the existing opening.
  assert.equal(changesBreakDateIntegrity(
    { previewsStartDate: null, openingDate: '2026-05-01' },
    [{ field: 'previewsStartDate', old: null, new: '2026-06-01' }]), true);
  // sane press night passes; non-date changes are never judged.
  assert.equal(changesBreakDateIntegrity(
    { previewsStartDate: '2026-11-12', openingDate: null },
    [{ field: 'openingDate', old: null, new: '2026-12-02' }]), false);
  assert.equal(changesBreakDateIntegrity(
    { previewsStartDate: '2014-11-21', openingDate: '2027-07-01' },
    [{ field: 'openingDateSource', old: null, new: 'theatremonkey' }]), false);
  assert.equal(changesBreakDateIntegrity(null, []), false);
});

test('changesBreakDateIntegrity: closing-date signal and cold opens', () => {
  assert.equal(changesBreakDateIntegrity(
    { openingDate: '2014-12-01', closingDate: '2015-01-31' },
    [{ field: 'openingDate', old: '2014-12-01', new: '2027-07-01' }]), true);
  // cold open (previews == opening) is legitimate.
  assert.equal(changesBreakDateIntegrity(
    { previewsStartDate: '2026-05-01', openingDate: null },
    [{ field: 'openingDate', old: null, new: '2026-05-01' }]), false);
});

test('vetoBrokenDateChanges: drops the whole set and reports discrepancies; passes sane sets through', () => {
  const show = { previewsStartDate: '2014-11-21', openingDate: '2014-12-01' };
  const bad = [{ field: 'openingDate', old: '2014-12-01', new: '2027-07-01' }, { field: 'openingDateSource', old: null, new: 'theatremonkey' }];
  const r = vetoBrokenDateChanges(show, bad, 'tm');
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.vetoed, [{ field: 'openingDate', current: '2014-12-01', external: '2027-07-01', source: 'tm', reason: 'vetoed: breaks date-integrity gates' }]);
  const ok = [{ field: 'openingDate', old: null, new: '2026-12-02' }];
  assert.deepEqual(vetoBrokenDateChanges({ previewsStartDate: '2026-11-12', openingDate: null }, ok, 'tm'), { changes: ok, vetoed: [] });
});

test('enrich-west-end-dates.js routes BOTH change writers through the veto (wiring guard)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../enrich-west-end-dates.js', import.meta.url), 'utf8');
  assert.match(src, /vetoBrokenDateChanges\(show, mergePressNightChanges/);
  assert.match(src, /vetoBrokenDateChanges\(infShow, inf\.changes/);
});
