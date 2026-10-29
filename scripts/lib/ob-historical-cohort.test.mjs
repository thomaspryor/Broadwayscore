// BRO-6153: OB historical backfill cohort rules. Requires the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isEntryInWindow, decideObHistoricalEntry, toAddShowAction, isStructuralOnlyMismatch, playbillFacts, isObHistoricalRow, transferLinkFields } = require('./ob-historical-cohort.js');
const { applyAddShow } = require('./add-show-action.js');
const { isTmRowInWindow, isCurrentTmRow, findTmSameTitleShow, isDistinctTransfer } = require('./theatermania-ob.js');
const { selectPromotable, inferObShowType, onlyMusicalTitles } = require('../promote-ob-historical.js');

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

// BRO-6254: Prince Faggot ran at Playwrights Horizons (May-Aug 2025), then
// transferred to Studio Seaview (Sep-Dec 2025). The cohort must see the first
// run as its own production; discovery must not change.
const seaview = {
  id: 'prince-faggot-off-broadway-2025', title: 'Prince Faggot', slug: 'prince-faggot-off-broadway-2025',
  venue: 'Studio Seaview', previewsStartDate: '2025-09-10', openingDate: '2025-09-10', closingDate: '2025-12-13',
  status: 'closed', category: 'off-broadway', market: 'broadway',
};
const phCandidate = { title: 'Prince Faggot', venue: 'Playwrights Horizons', previewsStartDate: '2025-05-23', openingDate: '2025-06-16', closingDate: '2025-08-03' };

test('isDistinctTransfer: other venue and runs apart is another production', () => {
  assert.equal(isDistinctTransfer(phCandidate, seaview), true);
});

test('isDistinctTransfer: same venue, overlapping runs, coarse TM venue or missing dates stay the same production', () => {
  assert.equal(isDistinctTransfer({ ...phCandidate, venue: 'Studio Seaview' }, seaview), false, 'same venue');
  assert.equal(isDistinctTransfer({ ...phCandidate, closingDate: '2025-09-20' }, seaview), false, 'overlapping runs');
  assert.equal(isDistinctTransfer({ ...phCandidate, closingDate: null }, seaview), false, 'no closing date: unprovable');
  assert.equal(isDistinctTransfer(phCandidate, { ...seaview, closingDate: null }), false, 'holder has no closing date');
  const row = { ...seaview, venue: 'Theatre Row, Theatre 5' };
  assert.equal(isDistinctTransfer({ ...phCandidate, venue: 'Theatre Row' }, row), false, 'TM coarse venue name');
  assert.equal(isDistinctTransfer({ ...phCandidate, venue: null }, seaview), false);
});

test('findTmSameTitleShow: discovery default still matches the transfer; the cohort opt-in lets it through', () => {
  assert.equal(findTmSameTitleShow(phCandidate, [seaview])?.id, seaview.id, 'default behaviour unchanged');
  assert.equal(findTmSameTitleShow(phCandidate, [seaview], { allowTransfers: true }), null);
  const sameRun = { ...phCandidate, venue: 'Studio Seaview', previewsStartDate: '2025-09-10', openingDate: '2025-09-10', closingDate: '2025-12-13' };
  assert.equal(findTmSameTitleShow(sameRun, [seaview], { allowTransfers: true })?.id, seaview.id, 'the same run is still caught');
  assert.equal(findTmSameTitleShow(phCandidate, [{ ...seaview, status: 'open' }], { allowTransfers: true })?.status, 'open', 'a running row always matches');
});

test('selectPromotable: a same-year transfer gets a venue-scoped id instead of a duplicate-id skip', () => {
  const ph = {
    title: 'Prince Faggot', venue: 'Playwrights Horizons', result: 'match', playbillUrl: 'https://playbill.com/production/prince-faggot-playwrights-horizons',
    parsed: { dates: { openingDate: '2025-06-16', firstPreview: '2025-05-30', closingDate: '2025-08-03' }, titleParse: { venue: 'Playwrights Horizons/Peter Jay Sharp Theater' } },
  };
  const { toPromote, skipped, transferOf } = selectPromotable([ph], [seaview]);
  assert.deepEqual(skipped, []);
  assert.equal(toPromote.length, 1);
  assert.equal(toPromote[0].id, 'prince-faggot-playwrights-horizons-off-broadway-2025');
  assert.equal(toPromote[0].slug, toPromote[0].id);
  assert.equal(toAddShowAction(toPromote[0], { discoveredAt: 'x', dateSource: 'y' }).show.id, toPromote[0].id);
  assert.equal(transferOf.get(toPromote[0].id), seaview.id);
  assert.deepEqual(transferLinkFields(toPromote[0], seaview), { crossLinkFrom: seaview.id }, 'earlier run: link from the later row');
  const a = { ...toAddShowAction(toPromote[0], { discoveredAt: 'x', dateSource: 'y' }), ...transferLinkFields(toPromote[0], seaview) };
  const applied = applyAddShow(JSON.parse(JSON.stringify([seaview])), a);
  assert.equal(applied.ok, true, applied.reason);
  // An overlapping same-id row is still refused as a duplicate.
  const overlap = { ...ph, parsed: { ...ph.parsed, dates: { openingDate: '2025-09-12', firstPreview: '2025-09-10', closingDate: '2025-12-13' } } };
  const r2 = selectPromotable([overlap], [seaview]);
  assert.equal(r2.toPromote.length, 0);
  assert.equal(r2.skipped[0].reason, 'duplicate id');
});

test('transferLinkFields: later new run names the earlier one; no opening date gives no link', () => {
  assert.deepEqual(transferLinkFields({ openingDate: '2026-01-10' }, seaview), { priorRunOf: seaview.id });
  assert.deepEqual(transferLinkFields({ openingDate: null }, seaview), {});
  assert.deepEqual(transferLinkFields({ openingDate: '2025-06-16' }, undefined), {});
});

test('selectPromotable: two same-year runs both new in one batch get distinct ids', () => {
  const m = (venue, prev, open, close) => ({
    title: 'Prince Faggot', venue, result: 'match', playbillUrl: `https://playbill.com/production/pf-${venue.length}`,
    parsed: { dates: { openingDate: open, firstPreview: prev, closingDate: close }, titleParse: { venue } },
  });
  const { toPromote, skipped } = selectPromotable([
    m('Studio Seaview', '2025-09-10', '2025-09-10', '2025-12-13'),
    m('Playwrights Horizons', '2025-05-30', '2025-06-16', '2025-08-03'),
  ], []);
  assert.deepEqual(skipped, []);
  assert.deepEqual(toPromote.map(e => e.id), ['prince-faggot-off-broadway-2025', 'prince-faggot-playwrights-horizons-off-broadway-2025']);
});

test('isStructuralOnlyMismatch (BRO-6470): a TM preview date inside Playbill\'s preview-to-opening span is the same run', () => {
  const dates = { firstPreview: '2021-11-05', openingDate: '2021-12-08', closingDate: '2022-01-15' };
  // Kimberly Akimbo, Atlantic 2021, as validateOne reported it.
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', parsed: { dates }, mismatches: [
    { field: 'openingDate', shows: '2021-11-05', playbill: '2021-12-08' }, { field: 'isRevival' },
  ] }), true);
  // An opening outside the span is still a conflict, and so is a closing gap riding on it.
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', parsed: { dates }, mismatches: [
    { field: 'openingDate', shows: '2021-09-01', playbill: '2021-12-08' }, { field: 'closingDate', shows: '2021-10-01' },
  ] }), false);
  // A closing gap alone, with a claimed opening that agreed, is TM's loose closing date.
  const closingOnly = { result: 'mismatch', parsed: { dates }, mismatches: [{ field: 'closingDate', shows: '2021-01-08' }] };
  assert.equal(isStructuralOnlyMismatch(closingOnly, { claimedOpening: '2021-12-08' }), true);
  // With no claimed opening nothing was compared, so a closing gap may be another production.
  assert.equal(isStructuralOnlyMismatch(closingOnly), false);
  assert.equal(isStructuralOnlyMismatch(closingOnly, { claimedOpening: null }), false);
  // A TM date with a time suffix is still read as a day.
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', parsed: { dates }, mismatches: [
    { field: 'openingDate', shows: '2021-11-05T00:00:00', playbill: '2021-12-08' },
  ] }), true);
  // Year: only the run's own preview/opening year is tolerated; venue never is.
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', parsed: { dates }, mismatches: [{ field: 'opening-year', shows: 2021, playbill: 2022 }] }), true);
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', parsed: { dates }, mismatches: [{ field: 'opening-year', shows: 2019, playbill: 2022 }] }), false);
  assert.equal(isStructuralOnlyMismatch({ result: 'mismatch', parsed: { dates }, mismatches: [{ field: 'venue' }] }), false);
});

// BRO-6506: 15 OB musicals went in as plays because the title was the only signal.
test('inferObShowType: Playbill tag > TM genre > title > same-titled catalog musical > flagged play', () => {
  const r = (o) => ({ title: 'The Connector', parsed: { tagLine: {} }, ...o });
  assert.deepEqual(inferObShowType(r({ parsed: { tagLine: { showType: 'musical' } } })), { type: 'musical', guessed: false });
  // Playbill's explicit Play wins over a TM musical genre.
  assert.deepEqual(inferObShowType(r({ parsed: { tagLine: { showType: 'play' } }, listingGenre: 'Musical' })), { type: 'play', guessed: false });
  // Bare "Off-Broadway" tag-line (The Connector, Walk on Through): TM genre decides.
  assert.deepEqual(inferObShowType(r({ listingGenre: 'Comedy; Musical' })), { type: 'musical', guessed: false });
  assert.deepEqual(inferObShowType(r({ listingGenre: 'Play; World Premiere' })), { type: 'play', guessed: false });
  // TM "Play; Comedy": knownShowType says nothing, the Play genre still counts and beats the catalog.
  assert.deepEqual(inferObShowType(r({ title: 'Peter Pan', listingGenre: 'Play; Comedy' }), new Set(['peter pan'])), { type: 'play', guessed: false });
  // Any genre at all silences the catalog rule ("Cabaret; Comedy" stays a flagged guess).
  assert.deepEqual(inferObShowType(r({ title: 'Peter Pan', listingGenre: 'Cabaret; Comedy' }), new Set(['peter pan'])), { type: 'play', guessed: true });
  assert.deepEqual(inferObShowType(r({ title: 'Dog Man: The Musical' })), { type: 'musical', guessed: false });
  // Catalog-only inference still goes on the hand-check list.
  assert.deepEqual(inferObShowType(r({ title: 'Animal Wisdom' }), new Set(['animal wisdom'])), { type: 'musical', guessed: true });
  assert.deepEqual(inferObShowType(r()), { type: 'play', guessed: true });
});

test('selectPromotable: carries the inferred type and lists guessed ids', () => {
  const match = (title, venue, extra = {}) => ({
    title, venue, result: 'match', playbillUrl: `https://playbill.com/production/${title.toLowerCase().replace(/ /g, '-')}`,
    parsed: { dates: { openingDate: '2024-02-06', firstPreview: null, closingDate: '2024-03-17' }, titleParse: { venue }, tagLine: { tags: ['Off-Broadway'], showType: null } },
    ...extra,
  });
  const { toPromote, typeGuessed } = selectPromotable([
    match('The Connector', 'The Robert W. Wilson MCC Theater Space', { listingGenre: 'Musical' }),
    match('Archduke', 'Laura Pels Theatre'),
  ], []);
  assert.deepEqual(toPromote.map(e => [e.id, e.type]), [['the-connector-off-broadway-2024', 'musical'], ['archduke-off-broadway-2024', 'play']]);
  assert.deepEqual(typeGuessed, ['archduke-off-broadway-2024']);
});

test('onlyMusicalTitles: a title the catalog holds as both play and musical never counts', () => {
  const t = onlyMusicalTitles([
    { title: 'Peter Pan', type: 'musical' }, { title: 'Peter Pan', type: 'play' },
    { title: 'Animal Wisdom', type: 'musical' }, { title: 'Archduke', type: 'play' },
  ]);
  assert.deepEqual([...t], ['animal wisdom']);
});

test('BRO-6496: isEntryInWindow uses the first preview, else the opening', () => {
  const w = { fromIso: '2018-06-01', toIso: '2020-03-15' };
  assert.equal(isEntryInWindow(entry({ previewsStartDate: '2019-10-01', openingDate: '2019-10-20' }), w), true);
  assert.equal(isEntryInWindow(entry({ previewsStartDate: '2018-05-20', openingDate: '2018-06-10' }), w), false);
  assert.equal(isEntryInWindow(entry({ previewsStartDate: null, openingDate: '2008-03-01' }), w), false);
  assert.equal(isEntryInWindow(entry({ previewsStartDate: null, openingDate: null }), w), false);
});

test('BRO-6496: toAddShowAction keeps ob-historical:tm by default and takes a census source', () => {
  const opts = { discoveredAt: '2026-10-29T00:00:00.000Z', dateSource: 'playbill-ob-historical' };
  assert.equal(toAddShowAction(entry(), opts).show.discoverySource, 'ob-historical:tm');
  const a = toAddShowAction(entry(), { ...opts, discoverySource: 'ob-historical:census' });
  assert.equal(a.show.discoverySource, 'ob-historical:census');
  assert.equal(isObHistoricalRow(a.show), true);
});
