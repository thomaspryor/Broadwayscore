import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { dropListingOpeningDateMismatch } = require('./london-venue-validation.js');

const mm = [{ field: 'openingDate', shows: 'x', playbill: 'y', deltaDays: 42 }, { field: 'venue', shows: 'a', playbill: 'b' }];
const parsed = d => ({ fromJsonLd: true, dates: { openingDate: d } });
const OLT = 'https://officiallondontheatre.com/show/into-the-woods-111473840/';

test('BRO-7737: an OLT first-upcoming-performance date later than the opening night is not a mismatch', () => {
  // into-the-woods-noel-coward-west-end-2026: opened 2026-10-07, listing start = fetch day.
  const out = dropListingOpeningDateMismatch(mm, { openingDate: '2026-10-07' }, parsed('2026-11-18'), OLT);
  assert.deepEqual(out.map(m => m.field), ['venue'], 'only the openingDate row is dropped');
});

test('BRO-7737: a listing start BEFORE the claimed opening still contradicts it', () => {
  const out = dropListingOpeningDateMismatch(mm, { openingDate: '2026-12-01' }, parsed('2026-11-18'), OLT);
  assert.equal(out.length, 2);
});

test('BRO-7737: a venue page or a show without an opening date keeps every mismatch', () => {
  assert.equal(dropListingOpeningDateMismatch(mm, { openingDate: '2026-10-07' }, parsed('2026-11-18'), 'https://almeida.co.uk/whats-on/x/').length, 2);
  assert.equal(dropListingOpeningDateMismatch(mm, {}, parsed('2026-11-18'), OLT).length, 2);
});

test('BRO-7737 review: a start years after the opening, or from printed text, stays a mismatch', () => {
  assert.equal(dropListingOpeningDateMismatch(mm, { openingDate: '2024-11-20' }, parsed('2026-12-20'), OLT).length, 2);
  assert.equal(dropListingOpeningDateMismatch(mm, { openingDate: '2025-12-14' }, parsed('2026-12-20'), OLT).length, 1, 'annual return is accepted');
  assert.equal(dropListingOpeningDateMismatch(mm, { openingDate: '2026-10-07' }, { dates: { openingDate: '2026-11-18' } }, OLT).length, 2);
});

test('BRO-7737 review: validateLondonShow end to end keeps a later-year run at the same house a mismatch', async () => {
  const { validateLondonShow } = require('./london-venue-validation.js');
  const html = d => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Event', name: 'Test Show', startDate: d, endDate: d, location: { name: 'Peacock Theatre' } })}</script>`;
  const run = async (opening, start) => validateLondonShow(
    { id: 'test-show-west-end-2024', title: 'Test Show', venue: 'Peacock Theatre', category: 'west-end', openingDate: opening, officialUrl: OLT },
    { fetchPage: async () => ({ content: html(start) }), serpQuery: async () => [] });
  assert.equal((await run('2024-11-20', '2026-12-20')).result, 'mismatch');
  assert.equal((await run('2026-10-07', '2026-11-18')).result, 'match');
});
