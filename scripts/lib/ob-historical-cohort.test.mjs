// BRO-6153: OB historical backfill cohort rules. Requires the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideObHistoricalEntry, toAddShowAction, isStructuralOnlyMismatch, playbillFacts, isObHistoricalRow } = require('./ob-historical-cohort.js');
const { applyAddShow } = require('./add-show-action.js');
const { isTmRowInWindow, isCurrentTmRow } = require('./theatermania-ob.js');
const { selectPromotable } = require('../promote-ob-historical.js');

const TODAY = '2026-10-25';
const entry = (o = {}) => ({
  id: 'archduke-off-broadway-2025', title: 'Archduke', slug: 'archduke-off-broadway-2025',
  venue: 'Laura Pels Theatre', previewsStartDate: '2025-10-23', openingDate: '2025-11-12',
  closingDate: '2025-12-21', type: 'play', playbillUrl: 'https://playbill.com/production/archduke-x', ...o,
});

test('decideObHistoricalEntry: a closed, dated, full run is promotable', () => {
  assert.deepEqual(decideObHistoricalEntry(entry(), { todayIso: TODAY }), { ok: true, reason: 'promotable' });
});

test('decideObHistoricalEntry: missing Playbill opening or closing date is refused', () => {
  assert.equal(decideObHistoricalEntry(entry({ closingDate: null }), { todayIso: TODAY }).ok, false);
  assert.equal(decideObHistoricalEntry(entry({ openingDate: null }), { todayIso: TODAY }).ok, false);
});

test('decideObHistoricalEntry: a provisional id year (no Playbill dates) is refused', () => {
  assert.equal(decideObHistoricalEntry(entry({ idYearProvisional: true }), { todayIso: TODAY }).ok, false);
});

test('decideObHistoricalEntry: closed exactly 90 days ago is refused, 91 is allowed (matches spend-purpose)', () => {
  assert.equal(decideObHistoricalEntry(entry({ closingDate: '2026-07-27' }), { todayIso: TODAY }).ok, false);
  assert.equal(decideObHistoricalEntry(entry({ closingDate: '2026-07-26' }), { todayIso: TODAY }).ok, true);
});

test('decideObHistoricalEntry: a run under 14 days (from first preview) is refused', () => {
  const short = entry({ previewsStartDate: '2025-12-10', openingDate: '2025-12-12', closingDate: '2025-12-21' });
  assert.match(decideObHistoricalEntry(short, { todayIso: TODAY }).reason, /shorter than 14/);
  const noPrev = entry({ previewsStartDate: null, openingDate: '2025-12-01', closingDate: '2025-12-21' });
  assert.equal(decideObHistoricalEntry(noPrev, { todayIso: TODAY }).ok, true);
});

test('toAddShowAction: closed OB row tagged ob-historical:tm with Playbill date source and evidence', () => {
  const a = toAddShowAction(entry(), { discoveredAt: '2026-10-25T00:00:00.000Z', dateSource: 'playbill-ob-historical', evidenceUrls: ['https://playbill.com/x', null] });
  assert.equal(a.type, 'add-show');
  assert.equal(a.show.status, 'closed');
  assert.equal(a.show.category, 'off-broadway');
  assert.equal(a.show.market, 'broadway');
  assert.equal(a.show.discoverySource, 'ob-historical:tm');
  assert.equal(a.show.openingDateSource, 'playbill-ob-historical');
  assert.deepEqual(a.show.evidenceUrls, ['https://playbill.com/x']);
  assert.equal(a.show.slug, a.show.id);
  assert.deepEqual(a.show.tags, []);
  assert.equal('isRevival' in a.show, false);
  const rev = toAddShowAction(entry({ isRevival: true }), { discoveredAt: 'x', dateSource: 'y' });
  assert.deepEqual(rev.show.tags, ['revival']);
  assert.equal(rev.show.isRevival, true);
});

test('toAddShowAction output passes the real add-show action guard', () => {
  const a = toAddShowAction(entry({ isRevival: true }), { discoveredAt: '2026-10-25T00:00:00.000Z', dateSource: 'playbill-ob-historical', evidenceUrls: ['https://playbill.com/x'] });
  const r = applyAddShow([], a);
  assert.equal(r.ok, true, r.reason);
});

test('decideObHistoricalEntry: refuses when Playbill printed no opening date (buildShowEntry fell back to preview)', () => {
  assert.match(decideObHistoricalEntry(entry({ openingFromPlaybill: false }), { todayIso: TODAY }).reason, /no opening date/);
  assert.equal(decideObHistoricalEntry(entry({ openingFromPlaybill: true }), { todayIso: TODAY }).ok, true);
});

test('isStructuralOnlyMismatch: revival/type-only mismatches are takeable facts, any date/venue mismatch is not', () => {
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', mismatches: [{ field: 'isRevival' }] }), true);
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', mismatches: [{ field: 'isRevival' }, { field: 'type' }] }), true);
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', mismatches: [{ field: 'isRevival' }, { field: 'openingDate' }] }), false);
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', mismatches: [] }), false);
  assert.equal(isStructuralOnlyMismatch({ result: 'match', mismatches: [] }), false);
});

test('playbillFacts: takes Playbill play/musical and revival labels, and whether it printed an opening date', () => {
  const r = { parsed: { tagLine: { showType: 'musical', revivalStatus: 'revival' }, dates: { openingDate: null, firstPreview: '2025-01-01' } } };
  assert.deepEqual(playbillFacts(r, { type: 'play' }), { type: 'musical', isRevival: true, openingFromPlaybill: false });
  const r2 = { parsed: { tagLine: { showType: null, revivalStatus: 'unknown' }, dates: { openingDate: '2025-02-01' } } };
  assert.deepEqual(playbillFacts(r2, { type: 'play' }), { type: 'play', isRevival: null, openingFromPlaybill: true });
});

test('isTmRowInWindow: uses the earliest of preview/opening; no dates → false', () => {
  const w = { fromIso: '2025-06-01', toIso: '2026-02-28' };
  assert.equal(isTmRowInWindow({ acf: { preview_date: '20250528', opening_date: '20250610' } }, w), false);
  assert.equal(isTmRowInWindow({ acf: { preview_date: null, opening_date: '20250610' } }, w), true);
  assert.equal(isTmRowInWindow({ acf: { opening_date: '20260228' } }, w), true);
  assert.equal(isTmRowInWindow({ acf: { opening_date: '20260301' } }, w), false);
  assert.equal(isTmRowInWindow({ acf: {} }, w), false);
});

test('isCurrentTmRow is unchanged by the historical filter (a long-closed row is not current)', () => {
  assert.equal(isCurrentTmRow({ acf: { opening_date: '20250610', closing_date: '20250713' } }, TODAY), false);
});

test('selectPromotable: refuses an id already in shows and a same title+venue row; keeps a new one', () => {
  const match = (title, venue, open, close) => ({
    title, venue, result: 'match', playbillUrl: `https://playbill.com/production/${title.toLowerCase()}`,
    parsed: { dates: { openingDate: open, firstPreview: null, closingDate: close }, titleParse: { venue } },
  });
  const shows = [{ id: 'lowcountry-off-broadway-2025', title: 'Lowcountry', venue: 'Atlantic Theater Company', category: 'off-broadway', status: 'closed' }];
  const { toPromote, skipped } = selectPromotable([
    match('Lowcountry', 'Atlantic Theater Company', '2025-06-10', '2025-07-13'),
    match('Archduke', 'Laura Pels Theatre', '2025-11-12', '2025-12-21'),
  ], shows);
  assert.deepEqual(toPromote.map(e => e.id), ['archduke-off-broadway-2025']);
  assert.equal(skipped.length, 1);
});

test('isObHistoricalRow: tag or ob-historical discoverySource, Off-Broadway rows only', () => {
  assert.equal(isObHistoricalRow({ market: 'broadway', category: 'off-broadway', tags: ['historical'] }), true);
  assert.equal(isObHistoricalRow({ market: 'broadway', category: 'off-broadway', tags: [], discoverySource: 'ob-historical:tm' }), true);
  assert.equal(isObHistoricalRow({ market: 'broadway', category: 'off-broadway', tags: [], discoverySource: 'theatermania-ob' }), false);
  assert.equal(isObHistoricalRow({ market: 'broadway', category: 'broadway', tags: ['historical'] }), false);
  assert.equal(isObHistoricalRow(null), false);
});

test('toAddShowAction: refuses a placeholder venue (sanitizeVenueForWrite)', () => {
  assert.equal(toAddShowAction(entry({ venue: 'TBA' }), { discoveredAt: 'x', dateSource: 'y' }), null);
});

test('toAddShowAction: strips wrapping quotes Playbill prints around some titles', () => {
  assert.equal(toAddShowAction(entry({ title: '"Anna Christie"' }), { discoveredAt: 'x', dateSource: 'y' }).show.title, 'Anna Christie');
  assert.equal(toAddShowAction(entry({ title: '“Anna Christie”' }), { discoveredAt: 'x', dateSource: 'y' }).show.title, 'Anna Christie');
  assert.equal(toAddShowAction(entry({ title: 'Say "Hello"' }), { discoveredAt: 'x', dateSource: 'y' }).show.title, 'Say "Hello"');
});
