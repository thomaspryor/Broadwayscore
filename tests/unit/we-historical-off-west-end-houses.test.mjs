// BRO-8120: the historical WE backfill must cover Off-West-End producing houses
// (Almeida, Young Vic, Barbican, Donmar...), minting off-west-end rows. Real functions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCandidates } = require('../../scripts/discover-historical-shows-we.js');
const { buildShowEntry, effectiveDecision } = require('../../scripts/promote-historical-we.js');
const { decideWeHistoricalPromotion, isWeHistoricalVenue, historicalCategoryForVenue } = require('../../scripts/lib/we-historical-corroboration.js');
const { isOffWestEndProducingHouse } = require('../../scripts/lib/venue-classification.js');

const TODAY = '2026-11-23';
const cand = (venue) => ({ title: 'Some Play', venue, openingDate: '2024-10-10', previewsStartDate: '2024-09-30',
  closingDate: '2024-11-30', season: '2024-2025', genres: ['play'], signals: ['wos-review'] });

test('producing houses are in scope, other non-WE venues and Old Vic are not', () => {
  for (const v of ['Almeida Theatre', 'Young Vic', 'Barbican Theatre', 'Donmar Warehouse']) {
    assert.equal(isOffWestEndProducingHouse(v), true, v);
    assert.equal(historicalCategoryForVenue(v), 'off-west-end', v);
  }
  assert.equal(historicalCategoryForVenue('Royal Court Theatre'), 'west-end');
  assert.equal(isWeHistoricalVenue('Bristol Old Vic'), false);
  assert.equal(isWeHistoricalVenue('Wembley Arena'), false);
});

test('decideWeHistoricalPromotion accepts an Almeida run, still rejects a non-London house', () => {
  assert.equal(decideWeHistoricalPromotion(cand('Almeida Theatre'), { today: TODAY }).promotable, true);
  assert.equal(decideWeHistoricalPromotion(cand('Bristol Old Vic'), { today: TODAY }).promotable, false);
});

test('discovery lists an in-season Young Vic listing as a promotable candidate', () => {
  const { candidates } = buildCandidates({ season: '2024-2025', today: TODAY, shows: [], oliviers: [],
    reviews: [{ title: 'Some Play', venue: 'Young Vic', date: '2024-10-12', url: 'https://x/r' }],
    listings: [{ title: 'Some Play', venue: 'Young Vic', openingDate: '2024-10-10', previewsStartDate: '2024-09-30', closingDate: '2024-11-30', genres: ['play'], url: 'https://x/l' }] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].decision.promotable, true);
});

test('promotion mints an off-west-end id/category for Donmar, west-end for a West End house', () => {
  const d = buildShowEntry(cand('Donmar Warehouse'), new Map());
  assert.equal(d.category, 'off-west-end');
  assert.match(d.id, /-off-west-end-2024$/);
  assert.equal(d.market, 'west-end');
  const w = buildShowEntry(cand('Harold Pinter Theatre'), new Map());
  assert.equal(w.category, 'west-end');
  assert.match(w.id, /-west-end-2024$/);
});

test('an approval override works for a producing house', () => {
  const c = { ...cand('Barbican Theatre'), decision: { promotable: false, reason: 'x' } };
  const r = effectiveDecision(c, { '2024-2025': { 'Some Play': { decision: 'approve', reason: 'ok' } } }, TODAY);
  assert.equal(r.promotable, true);
});

test('every spelling of a producing house resolves through the real normalizer, incl. The Pit and Tricycle', () => {
  for (const v of ['The Pit (Barbican)', 'The Pit', 'Barbican Centre', 'Tricycle Theatre', 'Donmar', 'Hampstead Theatre', 'The Bush Theatre', 'Lyric Hammersmith Theatre', 'Southwark Playhouse Elephant']) {
    assert.equal(isOffWestEndProducingHouse(v), true, v);
  }
});

test('OLT and Theatre Record A-Z discovery routes accept producing houses too', () => {
  const { buildOltCandidates } = require('../../scripts/lib/we-olt-candidates.js');
  const { azLookups } = require('../../scripts/lib/we-az-lookups.js');
  const out = buildOltCandidates({ season: '2024-2025', today: TODAY, shows: [], pages: [
    { title: 'Some Play', venue: 'Almeida Theatre', openingDate: '2024-10-10', previewsStartDate: '2024-09-30', closingDate: '2024-11-30' }] });
  assert.equal((out.candidates || out).length >= 1, true);
  const r = azLookups({ titles: [{ title: 'Some Play', venue: 'Almeida', opened: '2024-10-10' }] });
  assert.equal(r.lookups.length, 1);
});

test('a run declared as a priorRun of a transfer row is not minted again (Punch / Young Vic)', () => {
  const { planPromotions } = require('../../scripts/promote-historical-we.js');
  const shows = [{ id: 'punch-west-end-2025', title: 'Punch', market: 'west-end', venue: 'Apollo Theatre', openingDate: '2025-05-01',
    priorRuns: [{ openingDate: '2025-03-06', closingDate: '2025-04-12', venue: 'Young Vic' }] }];
  const c = { title: 'Punch', venue: 'Young Vic', openingDate: '2025-03-06', previewsStartDate: '2025-02-25', closingDate: '2025-04-12', season: '2024-2025', genres: ['play'], signals: ['wos-review'] };
  const r = planPromotions({ candidates: [c], shows, approvals: {}, today: TODAY });
  assert.equal(r.toPromote.length, 0);
  assert.match(r.skipped[0].reason, /priorRun/);
  const other = planPromotions({ candidates: [{ ...c, title: 'Different Play' }], shows, approvals: {}, today: TODAY });
  assert.equal(other.toPromote.length, 1);
});
