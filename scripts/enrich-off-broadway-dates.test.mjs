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
const {
  parseUSDate,
  extractDatesFromProductionPage,
  validateOBProductionPageTitle,
  mergeSources,
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
