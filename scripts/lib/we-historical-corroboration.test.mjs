import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recordsAgree, venueFamily, signalMatchesListing, decideWeHistoricalPromotion } = require('./we-historical-corroboration.js');

test('recordsAgree: exact match', () => {
  const a = { title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  const b = { title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  assert.equal(recordsAgree(a, b), true);
});

test('recordsAgree: tolerates opening-date drift within the window (preview vs press night)', () => {
  const a = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' };
  const b = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-23' };
  assert.equal(recordsAgree(a, b), true);
});

test('recordsAgree: rejects opening dates outside the window', () => {
  const a = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' };
  const b = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2025-01-15' };
  assert.equal(recordsAgree(a, b), false);
});

test('recordsAgree: rejects venue mismatch (same title, different production)', () => {
  const a = { title: 'Cats', venue: 'London Palladium', openingDate: '2024-06-01' };
  const b = { title: 'Cats', venue: 'New Wimbledon Theatre', openingDate: '2024-06-05' };
  assert.equal(recordsAgree(a, b), false);
});

test('recordsAgree: rejects title mismatch', () => {
  const a = { title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  const b = { title: 'The Cherry Orchard', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  assert.equal(recordsAgree(a, b), false);
});

test('recordsAgree: fails closed when either side is missing an opening date (title+venue alone is not enough — venues restage the same title years apart)', () => {
  const a = { title: 'Cats', venue: 'London Palladium', openingDate: null };
  const b = { title: 'Cats', venue: 'London Palladium', openingDate: '2019-06-01' };
  assert.equal(recordsAgree(a, b), false);
  assert.equal(recordsAgree(b, a), false);
});

test('recordsAgree: normalizes accents/case in title and venue', () => {
  const a = { title: 'JUNO AND THE PAYCOCK', venue: 'gielgud theatre', openingDate: '2024-10-03' };
  const b = { title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  assert.equal(recordsAgree(a, b), true);
});

// --- decideWeHistoricalPromotion (plan v3.1) ---------------------------------

const TODAY = '2026-10-07';
const KYOTO = {
  title: 'Kyoto', venue: '@sohoplace', previewsStartDate: '2025-01-09', openingDate: null,
  closingDate: '2025-05-03', genres: ['play'], signals: ['wos-review', 'olivier-2025'], season: '2024-2025',
};

test('decide: dated West End run with a review signal is promotable', () => {
  const d = decideWeHistoricalPromotion(KYOTO, { today: TODAY });
  assert.equal(d.promotable, true);
});

test('decide: non-West-End venue is a persistent no (Off-West End is out of scope)', () => {
  const d = decideWeHistoricalPromotion({ ...KYOTO, venue: 'Kiln Theatre' }, { today: TODAY });
  assert.deepEqual([d.promotable, d.persistent], [false, true]);
});

test('decide: start outside the season is a persistent no', () => {
  const d = decideWeHistoricalPromotion({ ...KYOTO, previewsStartDate: '2025-09-02', closingDate: '2025-12-01' }, { today: TODAY });
  assert.deepEqual([d.promotable, d.persistent], [false, true]);
});

test("decide: concerts, opera, dance, children's shows are out", () => {
  for (const g of ['event', 'opera', 'dance', 'children', 'concert']) {
    const d = decideWeHistoricalPromotion({ ...KYOTO, genres: [g] }, { today: TODAY });
    assert.equal(d.promotable, false, g);
  }
});

test('decide: a run shorter than 14 days is out (one-night specials, short visits)', () => {
  const d = decideWeHistoricalPromotion({ ...KYOTO, closingDate: '2025-01-15' }, { today: TODAY });
  assert.deepEqual([d.promotable, d.persistent], [false, true]);
});

test('decide: a late press night does not make a long run "short" (run measured from first preview)', () => {
  const macbeth = { ...KYOTO, title: 'Macbeth', venue: 'Harold Pinter Theatre', previewsStartDate: '2024-10-01', openingDate: '2024-12-08', closingDate: '2024-12-14' };
  assert.equal(decideWeHistoricalPromotion(macbeth, { today: TODAY }).promotable, true);
});

test('decide: not closed yet, or no closing date, is a NON-persistent no', () => {
  const open = decideWeHistoricalPromotion({ ...KYOTO, closingDate: '2027-01-01' }, { today: TODAY });
  const none = decideWeHistoricalPromotion({ ...KYOTO, closingDate: null }, { today: TODAY });
  assert.deepEqual([open.promotable, open.persistent], [false, false]);
  assert.deepEqual([none.promotable, none.persistent], [false, false]);
});

test('decide: no review signal is a NON-persistent no (approvals file can overrule)', () => {
  const d = decideWeHistoricalPromotion({ ...KYOTO, signals: [] }, { today: TODAY });
  assert.deepEqual([d.promotable, d.persistent], [false, false]);
});

test('venueFamily: National Theatre stage names collapse; unrelated venues do not', () => {
  assert.equal(venueFamily('National Theatre'), 'national-theatre');
  assert.equal(venueFamily('Lyttelton Theatre'), 'national-theatre');
  assert.equal(venueFamily('National Theatre Lyttelton'), 'national-theatre');
  assert.equal(venueFamily('Olivier Theatre'), 'national-theatre');
  assert.equal(venueFamily('Royal Court'), 'royal-court');
  assert.equal(venueFamily('@sohoplace'), venueFamily('sohoplace'));
  assert.notEqual(venueFamily('Prince Edward Theatre'), venueFamily('Prince of Wales Theatre'));
  assert.equal(venueFamily('Noel Coward Theatre'), venueFamily('Noël Coward Theatre'));
});

test('signalMatchesListing: WOS review dated inside the run, same venue family', () => {
  const listing = { title: 'Here We Are', venue: 'Lyttelton Theatre', previewsStartDate: '2025-04-23', openingDate: '2025-05-08', closingDate: '2025-06-28' };
  assert.equal(signalMatchesListing({ title: 'Here We Are', venue: 'National Theatre', date: '2025-05-09' }, listing), true);
  // A review of a different year's production (revival) does not match.
  assert.equal(signalMatchesListing({ title: 'Here We Are', venue: 'National Theatre', date: '2027-03-01' }, listing), false);
  // Same title elsewhere (regional run) does not match.
  assert.equal(signalMatchesListing({ title: 'Here We Are', venue: 'Crucible Theatre', date: '2025-05-09' }, listing), false);
});

test('signalMatchesListing: undated Olivier signal matches on title + any listed venue', () => {
  const listing = { title: 'The Years', venue: 'Harold Pinter Theatre', previewsStartDate: '2025-01-24', closingDate: '2025-04-19' };
  assert.equal(signalMatchesListing({ title: 'The Years', venues: ['Almeida Theatre', 'Harold Pinter Theatre'] }, listing), true);
  assert.equal(signalMatchesListing({ title: 'The Years', venues: ['Almeida Theatre'] }, listing), false);
});
