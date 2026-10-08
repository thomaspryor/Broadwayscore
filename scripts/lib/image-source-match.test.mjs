// Tests for production-level image matching (BRO-2242, BRO-4851). Fixtures are
// the real Mezzanine / Theatr cache entries and shows.json rows involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeVenueName, venuesMatch, pickMezzanineCandidate, theatrEligible, isRejectedImage, ibdbEligible, buildVenueCityIndex,
} = require('./image-source-match.js');

const at = (iso) => ({ __type: 'Date', iso });
const MEZZ_OEDIPUS = [
  { name: 'Oedipus', artUrl: 'https://x/oedipus old vic.png', theater: 'Old Vic Theatre', isBroadway: false, openedAt: at('2025-01-21T05:00:00.000Z'), ratingsCount: 190 },
  { name: 'Oedipus', artUrl: 'https://x/oedipus wyndhams.jpg', theater: "Wyndham's Theatre", isBroadway: false, openedAt: at('2024-10-04T04:00:00.000Z'), ratingsCount: 208 },
  { name: 'Oedipus', artUrl: 'https://x/oedipus sheen.jpg', theater: 'Sheen Center', isBroadway: false, openedAt: null, ratingsCount: 0 },
  { name: 'Oedipus', artUrl: 'https://x/oedipus studio 54.jpg', theater: 'Studio 54', isBroadway: true, openedAt: at('2025-10-30T04:00:00.000Z'), ratingsCount: 932 },
];
const oldVic = { id: 'oedipus-west-end-2025', title: 'Oedipus', category: 'west-end', venue: 'The Old Vic', previewsStartDate: '2025-01-21', openingDate: '2025-02-04', status: 'closed' };
const wyndhams = { id: 'oedipus-west-end-2024', title: 'Oedipus', category: 'west-end', venue: "Wyndham's Theatre", previewsStartDate: '2024-10-04', openingDate: '2024-10-15', status: 'closed' };
const broadway = { id: 'oedipus-2025', title: 'Oedipus', category: 'broadway', venue: 'Studio 54', openingDate: '2025-11-13', status: 'open' };

test('venue names normalize to the same tokens, and only exact token matches count', () => {
  assert.equal(normalizeVenueName('The Old Vic'), 'old vic');
  assert.ok(venuesMatch('The Old Vic', 'Old Vic Theatre'));
  assert.ok(venuesMatch('Noël Coward Theatre', 'Noel Coward'));
  assert.ok(!venuesMatch('Old Vic', 'Young Vic'));
  assert.ok(!venuesMatch('Apollo Theatre', 'Apollo Victoria Theatre'));
  assert.ok(!venuesMatch('', ''));
});

test('Mezzanine: each Oedipus row gets its own production, never Studio 54', () => {
  assert.equal(pickMezzanineCandidate(oldVic, MEZZ_OEDIPUS).candidate.theater, 'Old Vic Theatre');
  assert.equal(pickMezzanineCandidate(wyndhams, MEZZ_OEDIPUS).candidate.theater, "Wyndham's Theatre");
  assert.equal(pickMezzanineCandidate(broadway, MEZZ_OEDIPUS).candidate.theater, 'Studio 54');
});

test('Mezzanine: London row with no venue match drops Broadway and undated candidates', () => {
  const elsewhere = { ...oldVic, venue: 'Somewhere Else' };
  // Old Vic (2025-01-21) is nearest among dated non-Broadway rows.
  assert.equal(pickMezzanineCandidate(elsewhere, MEZZ_OEDIPUS).candidate.theater, 'Old Vic Theatre');
  const onlyNyc = MEZZ_OEDIPUS.filter(c => c.theater === 'Studio 54' || c.theater === 'Sheen Center');
  assert.equal(pickMezzanineCandidate(elsewhere, onlyNyc).candidate, null);
});

test('Mezzanine: previews date stands in for a missing opening date', () => {
  const noOpening = { ...oldVic, venue: 'Elsewhere', openingDate: null };
  assert.equal(pickMezzanineCandidate(noOpening, MEZZ_OEDIPUS).candidate.theater, 'Old Vic Theatre');
  const undated = { ...noOpening, previewsStartDate: null };
  assert.equal(pickMezzanineCandidate(undated, MEZZ_OEDIPUS).candidate, null); // several candidates, no date
});

test('Mezzanine: Earnest at the Noël Coward and White Rabbit at the Duchess match by venue', () => {
  const earnest = [
    { artUrl: 'https://x/earnest-nt.jpg', theater: 'National Theatre - Lyttelton', isBroadway: false, openedAt: at('2024-11-13T00:00:00Z') },
    { artUrl: 'https://x/earnest-nc.jpg', theater: 'Noël Coward Theatre', isBroadway: false, openedAt: at('2025-09-18T00:00:00Z') },
  ];
  const show = { title: 'The Importance of Being Earnest', category: 'west-end', venue: 'Noel Coward Theatre', previewsStartDate: '2025-09-18' };
  assert.equal(pickMezzanineCandidate(show, earnest).candidate.artUrl, 'https://x/earnest-nc.jpg');
  const wrr = [
    { artUrl: 'https://x/wrr-duchess.jpg', theater: 'Duchess Theatre', isBroadway: false, openedAt: at('2026-06-09T00:00:00Z') },
    { artUrl: 'https://x/wrr-soho.jpg', theater: '@sohoplace', isBroadway: false, openedAt: at('2024-10-01T00:00:00Z') },
  ];
  const wrr24 = { title: 'White Rabbit Red Rabbit', category: 'west-end', venue: 'Soho Place', previewsStartDate: '2024-10-01' };
  // "@sohoplace" vs "Soho Place" is not an exact token match, so the date decides.
  assert.equal(pickMezzanineCandidate(wrr24, wrr).candidate.artUrl, 'https://x/wrr-soho.jpg');
  assert.equal(pickMezzanineCandidate({ ...wrr24, venue: 'Duchess Theatre', previewsStartDate: '2026-06-09' }, wrr).candidate.artUrl, 'https://x/wrr-duchess.jpg');
});

test('Theatr: NYC-only, so London rows and closed rows with a same-title sibling are refused', () => {
  const othelloBway = { name: 'Othello', eventCategory: 'Broadway', venue: { name: 'Ethel Barrymore Theatre' } };
  const othelloWe = { id: 'othello-west-end-2025', title: 'Othello', category: 'west-end', venue: 'Theatre Royal Haymarket', status: 'closed' };
  const othello1970 = { id: 'othello-1970', title: 'Othello', category: 'broadway', venue: 'ANTA Theatre', status: 'closed' };
  const othello2025 = { id: 'othello-2025', title: 'Othello', category: 'broadway', venue: 'Ethel Barrymore Theatre', status: 'closed' };
  const all = [othelloWe, othello1970, othello2025];
  assert.equal(theatrEligible(othelloWe, othelloBway, all), false);
  assert.equal(theatrEligible(othello1970, othelloBway, all), false);
  assert.equal(theatrEligible(othello2025, othelloBway, all), true); // own venue
  const solo = { id: 'solo-2026', title: 'Solo Show', category: 'off-broadway', venue: 'Somewhere', status: 'open' };
  assert.equal(theatrEligible(solo, { venue: { name: 'Elsewhere' } }, [solo]), true);
});

test('IBDB is Broadway-only', () => {
  assert.equal(ibdbEligible({ category: 'west-end' }), false);
  assert.equal(ibdbEligible({ category: 'off-west-end' }), false);
  assert.equal(ibdbEligible({ category: 'broadway' }), true);
});

test('rejectedImageUrls blocks a re-fetch of the same source, query string ignored', () => {
  const show = { rejectedImageUrls: ['https://cdn/theatr/godot-poster.jpg'] };
  assert.equal(isRejectedImage({ poster: 'https://cdn/theatr/godot-poster.jpg?w=720' }, show), true);
  assert.equal(isRejectedImage({ poster: 'https://cdn/other.jpg' }, show), false);
  assert.equal(isRejectedImage({ poster: 'https://cdn/theatr/godot-poster.jpg' }, {}), false);
});

test('Mezzanine: venue city from shows.json keeps each row in its own city', () => {
  const index = buildVenueCityIndex([
    { venue: 'Theatre Royal Haymarket', category: 'west-end' },
    { venue: 'Studio 54', category: 'broadway' },
    { venue: 'Lyceum Theatre', category: 'broadway' },
    { venue: 'Lyceum Theatre', category: 'west-end' },
  ]);
  assert.equal(index.get('royal haymarket'), 'london');
  assert.equal(index.get('lyceum'), undefined); // both cities: neutral
  const godot = [
    { artUrl: 'https://x/godot-haymarket.jpg', theater: 'Theatre Royal Haymarket', isBroadway: false, openedAt: at('2009-04-29T00:00:00Z') },
    { artUrl: 'https://x/godot-studio54.jpg', theater: 'Studio 54', isBroadway: true, openedAt: at('2009-04-30T00:00:00Z') },
  ];
  const row = { title: 'Waiting for Godot', category: 'broadway', venue: 'Some Renamed House', openingDate: '2009-04-30' };
  assert.equal(pickMezzanineCandidate(row, godot, index).candidate.theater, 'Studio 54');
  // Unreliable isBroadway flag: the 2002 Martin Beck row is false but must still win for Broadway.
  const mancha = [
    { artUrl: 'https://x/mancha-92.jpg', theater: 'Marquis Theatre', isBroadway: true, openedAt: at('1992-03-31T00:00:00Z') },
    { artUrl: 'https://x/mancha-02.jpg', theater: 'Martin Beck Theatre', isBroadway: false, openedAt: at('2002-11-23T00:00:00Z') },
  ];
  const m02 = { title: 'Man of La Mancha', category: 'broadway', venue: 'Al Hirschfeld Theatre', openingDate: '2002-12-05', previewsStartDate: '2002-11-23' };
  assert.equal(pickMezzanineCandidate(m02, mancha, index).candidate.theater, 'Martin Beck Theatre');
});
