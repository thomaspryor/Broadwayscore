// Unit tests for the Phase 3 "per-show Playbill production-page lookup"
// added for BRO-1108 (gap-filler for OB shows the Playbill schedule article
// doesn't carry — see scripts/enrich-off-broadway-dates.js SOURCE 3).
//
// Only the pure parsing/validation/merge functions are exercised here.
// Network-calling paths (discoverOBPlaybillUrl, scrapePlaybillProductionPages)
// are covered indirectly by --dry-run / --show=ID manual runs and the daily
// workflow's audit trail (data/audit/date-enrichment-corrections.json).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAnnouncedPastRunCandidate, pastRunChanges } = require('./lib/ob-announced-past-run');
const {
  parseUSDate,
  extractDatesFromProductionPage,
  validateOBProductionPageTitle,
  mergeSources,
  isPreviewStrictlyAfterOpening,
  isNullOpeningFill,
  isPhase3DefaultCandidate,
  acceptScheduleMatch,
} = require('./enrich-off-broadway-dates.js');

// Real Playbill production pages render First Preview / Opening Date as
// <span class="info-circular-{pre-text,text,post-text}"> triples inside a
// single <div class="info-circular">...</div> — confirmed against 53 real
// successful extractions in data/audit/date-enrichment-corrections.json
// (e.g. blood-love-off-broadway-theater-555-2026). The regex is div-close
// sensitive: nesting <div> instead of <span> for the pre/text/post triple
// would truncate the match at the first nested </div>.
function productionPageFixture({ title = 'Spare Parts', preview, opening, market = 'Off-Broadway', venue = 'Theatre Row Theatre', year = '2026' } = {}) {
  const block = (label, pre, day, post) => `
    <div class="bsp-list-promo-title">${label}</div>
    <div class="bsp-list-promo-body">
      <div class="info-circular">
        <span class="info-circular-pre-text">${pre}</span>
        <span class="info-circular-text">${day}</span>
        <span class="info-circular-post-text">${post}</span>
      </div>
    </div>`;
  const parts = [];
  if (preview) parts.push(block('First Preview', preview.pre, preview.day, preview.post));
  if (opening) parts.push(block('Opening Date', opening.pre, opening.day, opening.post));
  return `<!DOCTYPE html><html><head><title>${title} (${market}, ${venue}, ${year}) | Playbill</title></head><body>${parts.join('\n')}</body></html>`;
}

test('parseUSDate — parses month-day-year', () => {
  assert.equal(parseUSDate('February 4, 2026'), '2026-02-04');
  assert.equal(parseUSDate('Feb 4, 2026'), '2026-02-04');
});

test('parseUSDate — defaults year when omitted', () => {
  const currentYear = new Date().getFullYear();
  assert.equal(parseUSDate('Apr 16', currentYear), `${currentYear}-04-16`);
});

test('parseUSDate — rejects unparseable text', () => {
  assert.equal(parseUSDate(''), null);
  assert.equal(parseUSDate('not a date'), null);
});

test('parseUSDate — rejects years outside the rolling sanity window', () => {
  assert.equal(parseUSDate('Apr 16, 1990'), null);
  assert.equal(parseUSDate('Apr 16, 2099'), null);
});

test('extractDatesFromProductionPage — extracts both First Preview and Opening Date', () => {
  const html = productionPageFixture({
    preview: { pre: 'Feb', day: '26', post: '2026' },
    opening: { pre: 'Mar', day: '8', post: '2026' },
  });
  const dates = extractDatesFromProductionPage(html);
  assert.deepEqual(dates, { firstPreview: '2026-02-26', opening: '2026-03-08' });
});

test('extractDatesFromProductionPage — Opening Date only (no preview period)', () => {
  const html = productionPageFixture({ opening: { pre: 'Sep', day: '8', post: '2026' } });
  const dates = extractDatesFromProductionPage(html);
  assert.deepEqual(dates, { firstPreview: null, opening: '2026-09-08' });
});

test('extractDatesFromProductionPage — returns null when no date blocks present', () => {
  assert.equal(extractDatesFromProductionPage('<html><body>no dates here</body></html>'), null);
  assert.equal(extractDatesFromProductionPage(''), null);
});

test('validateOBProductionPageTitle — accepts a matching off-Broadway title within the year window', () => {
  const html = productionPageFixture({ title: 'Spare Parts' });
  const show = { title: 'Spare Parts', openingDate: '2026-03-08', id: 'spare-parts-off-broadway-2026' };
  assert.equal(validateOBProductionPageTitle(html, show), true);
});

test('validateOBProductionPageTitle — rejects a Broadway (non-OB) page', () => {
  const html = productionPageFixture({ title: 'Spare Parts', market: 'Broadway' });
  const show = { title: 'Spare Parts', openingDate: '2026-03-08', id: 'spare-parts-off-broadway-2026' };
  assert.equal(validateOBProductionPageTitle(html, show), false);
});

test('validateOBProductionPageTitle — rejects cross-production year mismatch', () => {
  // Same title, but the page is a 2024 production and the show is a 2026 one.
  // Guards the music-city-off-broadway-2026 class of bug (2026-04-29 dry-run).
  const html = productionPageFixture({ title: 'Music City', year: '2024' });
  const show = { title: 'Music City', openingDate: '2026-03-23', id: 'music-city-off-broadway-2026' };
  assert.equal(validateOBProductionPageTitle(html, show), false);
});

test('validateOBProductionPageTitle — rejects an unrelated show title', () => {
  const html = productionPageFixture({ title: 'The Maids of Honor' });
  const show = { title: 'The Maids', openingDate: '2026-03-08', id: 'the-maids-off-broadway-2026' };
  assert.equal(validateOBProductionPageTitle(html, show), false);
});

test('mergeSources — two agreeing sources yield high confidence', () => {
  const playbill = [{ title: 'Kenrex', firstPreview: '2026-04-16', opening: '2026-04-26', source: 'playbill' }];
  const lortel = [{ title: 'Kenrex', firstPreview: '2026-04-16', opening: '2026-04-26', source: 'lortel' }];
  const merged = mergeSources(playbill, lortel);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence, 'high');
});

test('mergeSources — disagreeing sources yield discrepancy confidence', () => {
  const playbill = [{ title: 'Kenrex', firstPreview: '2026-04-16', opening: '2026-04-26', source: 'playbill' }];
  const lortel = [{ title: 'Kenrex', firstPreview: '2026-04-16', opening: '2026-05-10', source: 'lortel' }];
  const merged = mergeSources(playbill, lortel);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence, 'discrepancy');
});

test('mergeSources — single-source entry is not auto-trusted', () => {
  const playbill = [{ title: 'Kenrex', firstPreview: '2026-04-16', opening: '2026-04-26', source: 'playbill' }];
  const merged = mergeSources(playbill, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence, 'single-source');
});

test('mergeSources — opening agrees but only one source has a preview date is NOT high confidence', () => {
  // Both sources agree on opening, but Lortel doesn't report a preview date.
  // fpAgreement is null (can't compare), which must NOT be treated as "agrees" —
  // only a real two-field agreement earns 'high'.
  const playbill = [{ title: 'Kenrex', firstPreview: '2026-04-16', opening: '2026-04-26', source: 'playbill' }];
  const lortel = [{ title: 'Kenrex', firstPreview: null, opening: '2026-04-26', source: 'lortel' }];
  const merged = mergeSources(playbill, lortel);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence, 'single-source');
});

test('production page does not borrow the next label date', () => {
  const html = `<div class="bsp-list-promo-title">First Preview</div>
    <div class="bsp-list-promo-title">Opening Date</div><div class="info-circular">
    <span class="info-circular-pre-text">Apr</span><span class="info-circular-text">26</span>
    <span class="info-circular-post-text">2026</span></div>`;
  assert.deepEqual(extractDatesFromProductionPage(html), { firstPreview: null, opening: '2026-04-26' });
});

test('production page extracts closing dates', () => {
  const html = productionPageFixture({ opening: { pre: 'Apr', day: '1', post: '2026' } }) +
    `<div class="bsp-list-promo-title">Closing Date</div><div class="info-circular">
    <span class="info-circular-pre-text">May</span><span class="info-circular-text">1</span>
    <span class="info-circular-post-text">2026</span></div>`;
  assert.equal(extractDatesFromProductionPage(html).closing, '2026-05-01');
});

test('announced past runs require clean reviews and complete past source dates', () => {
  const show = { id: 'sample-off-broadway-2026', category: 'off-broadway', status: 'announced' };
  const review = { showId: show.id, publishDate: '2026-04-02' };
  const entry = { source: 'playbill-production-page', opening: '2026-04-01', closing: '2026-05-01', firstPreview: '2026-03-30' };
  assert.equal(isAnnouncedPastRunCandidate(show, [review]), true);
  for (const flag of ['wrongShow', 'wrongProduction', 'isRoundupArticle'])
    assert.equal(isAnnouncedPastRunCandidate(show, [{ ...review, [flag]: true }]), false);
  assert.equal(isAnnouncedPastRunCandidate(show, [{ ...review, publishDate: '2025-04-02' }]), false);
  assert.equal(isAnnouncedPastRunCandidate(show, [{ ...review, publishDate: null }]), true);
  assert.equal(pastRunChanges(show, entry, '2026-11-24').find(c => c.field === 'status').new, 'closed');
  assert.equal(pastRunChanges(show, { ...entry, opening: '2025-04-01' }, '2026-11-24'), null);
  assert.equal(pastRunChanges(show, { ...entry, closing: '2027-01-01' }, '2026-11-24'), null);
  assert.equal(pastRunChanges(show, { ...entry, closing: null }, '2026-11-24'), null);
});

// BRO-1108 regression: The Ford/Hill Project (BAM Fisher, opened 2026-09-08
// with no preview period) was silently dropped by a `>=` bad-data guard that
// treated "same date" as invalid. Only strictly-after is actually bad data.
test('isPreviewStrictlyAfterOpening — same date (no previews) is NOT bad data', () => {
  assert.equal(isPreviewStrictlyAfterOpening({ firstPreview: '2026-09-08', opening: '2026-09-08' }), false);
});

test('isPreviewStrictlyAfterOpening — preview before opening is NOT bad data', () => {
  assert.equal(isPreviewStrictlyAfterOpening({ firstPreview: '2026-04-15', opening: '2026-04-26' }), false);
});

test('isPreviewStrictlyAfterOpening — preview after opening IS bad data', () => {
  assert.equal(isPreviewStrictlyAfterOpening({ firstPreview: '2026-05-01', opening: '2026-04-26' }), true);
});

test('isPreviewStrictlyAfterOpening — missing either date is NOT bad data (nothing to compare)', () => {
  assert.equal(isPreviewStrictlyAfterOpening({ firstPreview: null, opening: '2026-04-26' }), false);
  assert.equal(isPreviewStrictlyAfterOpening({ firstPreview: '2026-04-15', opening: null }), false);
});

// Null-opening fill (2026-09-27): our-sinatra/midnight/truly-howard-hughes sat
// at status=previews with openingDate=null while Playbill had the date,
// because single-source writes were audit-only even with nothing to overwrite.
test('isNullOpeningFill — null opening + plausible single-source date fills', () => {
  const show = { openingDate: null, previewsStartDate: '2026-09-12' };
  assert.equal(isNullOpeningFill(show, { opening: '2026-09-27', firstPreview: '2026-09-12', confidence: 'single-source' }), true);
});

test('isNullOpeningFill — null opening, no known preview, still fills', () => {
  assert.equal(isNullOpeningFill({ openingDate: null }, { opening: '2026-10-21', confidence: 'single-source' }), true);
});

test('isNullOpeningFill — existing opening date is never a null-fill', () => {
  assert.equal(isNullOpeningFill({ openingDate: '2026-09-20', previewsStartDate: '2026-09-12' }, { opening: '2026-09-27', confidence: 'single-source' }), false);
});

test('isNullOpeningFill — discrepancy between sources does not fill', () => {
  assert.equal(isNullOpeningFill({ openingDate: null }, { opening: '2026-09-27', confidence: 'discrepancy' }), false);
});

test('isNullOpeningFill — opening before known first preview (wrong production) does not fill', () => {
  assert.equal(isNullOpeningFill({ openingDate: null, previewsStartDate: '2026-09-12' }, { opening: '2025-10-01', confidence: 'single-source' }), false);
});

test('isNullOpeningFill — opening far after known preview does not fill', () => {
  assert.equal(isNullOpeningFill({ openingDate: null, previewsStartDate: '2026-01-10' }, { opening: '2026-09-27', confidence: 'single-source' }), false);
});

test('isNullOpeningFill — source first-preview far from known preview does not fill', () => {
  assert.equal(isNullOpeningFill({ openingDate: null, previewsStartDate: '2026-09-12' }, { opening: '2026-12-01', firstPreview: '2026-11-20', confidence: 'single-source' }), false);
});

test('isNullOpeningFill — preview after opening in source is bad data', () => {
  assert.equal(isNullOpeningFill({ openingDate: null }, { opening: '2026-09-20', firstPreview: '2026-09-25', confidence: 'single-source' }), false);
});

test('isPhase3DefaultCandidate — same-date class queued', () => {
  assert.equal(isPhase3DefaultCandidate({ openingDate: '2026-04-15', previewsStartDate: '2026-04-15' }, '2026-09-27'), true);
});

test('isPhase3DefaultCandidate — null opening already in previews queued', () => {
  assert.equal(isPhase3DefaultCandidate({ status: 'previews', openingDate: null, previewsStartDate: '2026-09-11' }, '2026-09-27'), true);
});

test('isPhase3DefaultCandidate — null opening, previews not started, left to Phase 1', () => {
  assert.equal(isPhase3DefaultCandidate({ openingDate: null, previewsStartDate: '2026-11-01' }, '2026-09-27'), false);
  assert.equal(isPhase3DefaultCandidate({ openingDate: null }, '2026-09-27'), false);
});

test('isPhase3DefaultCandidate — distinct confirmed dates not queued', () => {
  assert.equal(isPhase3DefaultCandidate({ openingDate: '2026-09-25', previewsStartDate: '2026-09-11' }, '2026-09-27'), false);
});

test('isPhase3DefaultCandidate — closed or long-running null-opening shows not queued', () => {
  assert.equal(isPhase3DefaultCandidate({ status: 'closed', openingDate: null, previewsStartDate: '2026-09-01' }, '2026-09-27'), false);
  assert.equal(isPhase3DefaultCandidate({ status: 'previews', openingDate: null, previewsStartDate: '2024-01-06' }, '2026-09-27'), false);
});

test('isNullOpeningFill — id year more than 1y from source opening does not fill', () => {
  assert.equal(isNullOpeningFill({ id: 'girls-chance-music-off-broadway-2024', openingDate: null }, { opening: '2026-05-28', confidence: 'single-source' }), false);
  assert.equal(isNullOpeningFill({ id: 'midnight-off-broadway-2026', openingDate: null }, { opening: '2026-09-27', confidence: 'single-source' }), true);
});

// Our Sinatra 2026-09-27: Playbill's schedule lists "Our Sinatra"; the catalog
// has "Our Sinatra: A Musical Celebration" → matchTitleToShow says "medium".
test('acceptScheduleMatch — high always accepted', () => {
  assert.equal(acceptScheduleMatch({ confidence: 'high', show: { category: 'off-broadway', venue: 'X' } }, {}), true);
});
test('acceptScheduleMatch — medium accepted when venues share a distinctive word', () => {
  const r = { confidence: 'medium', show: { category: 'off-broadway', venue: 'The Marjorie S. Deane Little Theater' } };
  assert.equal(acceptScheduleMatch(r, { raw: { playbill: { venue: 'Marjorie S. Deane Little Theater @ The West Side Y' } } }), true);
});
test('acceptScheduleMatch — medium rejected when venues differ or only share generic words', () => {
  const r = { confidence: 'medium', show: { category: 'off-broadway', venue: 'SoHo Playhouse' } };
  assert.equal(acceptScheduleMatch(r, { raw: { playbill: { venue: 'Minetta Lane Theatre' } } }), false);
  assert.equal(acceptScheduleMatch({ confidence: 'medium', show: { category: 'off-broadway', venue: 'New World Stages' } }, { raw: { playbill: { venue: 'New York Theatre Workshop' } } }), false);
  assert.equal(acceptScheduleMatch(r, {}), false);
});
test('acceptScheduleMatch — low / non-OB never accepted', () => {
  assert.equal(acceptScheduleMatch({ confidence: 'low', show: { category: 'off-broadway', venue: 'SoHo Playhouse' } }, { raw: { playbill: { venue: 'SoHo Playhouse' } } }), false);
  assert.equal(acceptScheduleMatch({ confidence: 'high', show: { category: 'broadway', venue: 'X' } }, {}), false);
});
