// End-to-end logic tests for the WE historical backfill (BRO-4851):
// discover-historical-shows-we.js buildCandidates() and
// promote-historical-we.js planPromotions(). Root-level scripts/*.test.mjs
// are not globbed by test.yml, so these live here and require the scripts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCandidates, collapseDuplicateListings } = require('../discover-historical-shows-we.js');
const { planPromotions, effectiveDecision, fixAllCapsTitle, buildShowEntry } = require('../promote-historical-we.js');
const { planWetMerge, matchWetRow } = require('../merge-wet-stars-urls.js');

const SEASON = '2024-2025';
const TODAY = '2026-10-07';

const listing = (o) => ({ previewsStartDate: null, openingDate: null, closingDate: null, genres: ['play'], url: `https://wos/${o.title}`, ...o });

const LISTINGS = [
  listing({ title: 'Kyoto', venue: '@sohoplace', previewsStartDate: '2025-01-09', closingDate: '2025-05-03' }),
  listing({ title: 'Oedipus', venue: "Wyndham's Theatre", previewsStartDate: '2024-10-04', openingDate: '2024-10-15', closingDate: '2025-01-04' }),
  listing({ title: 'Oedipus', venue: 'Old Vic Theatre', previewsStartDate: '2025-01-21', openingDate: '2025-02-04', closingDate: '2025-03-29' }),
  listing({ title: 'Juno and the Paycock', venue: 'Gielgud Theatre', previewsStartDate: '2024-09-21', openingDate: '2024-10-03', closingDate: '2024-11-23' }),
  listing({ title: 'Some Fringe Play', venue: 'Kiln Theatre', openingDate: '2024-10-01', closingDate: '2024-11-01' }),
  listing({ title: 'A Concert', venue: 'Apollo Theatre', openingDate: '2024-10-01', closingDate: '2024-11-01', genres: ['event'] }),
  listing({ title: 'Last Season Show', venue: 'Apollo Theatre', openingDate: '2024-05-01', closingDate: '2024-11-01' }),
];
const REVIEWS = [
  { title: 'Oedipus', venue: "Wyndham's Theatre", date: '2024-10-16', url: 'https://wos/r1' },
  { title: 'Oedipus', venue: 'Old Vic', date: '2025-02-05', url: 'https://wos/r2' },
  { title: 'Coriolanus', venue: 'National Theatre', date: '2024-09-25', url: 'https://wos/r3' },
];
const OLIVIERS = [{ title: 'Kyoto', venues: ['@sohoplace'], year: 2025 }];
const SHOWS = [
  { id: 'juno-and-the-paycock-west-end-2024', title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' },
];

function run() {
  return buildCandidates({ season: SEASON, listings: LISTINGS, reviews: REVIEWS, oliviers: OLIVIERS, shows: SHOWS, today: TODAY });
}

test('buildCandidates keeps only in-season West End listings', () => {
  const { candidates } = run();
  const titles = candidates.map(c => `${c.title}@${c.venue}`);
  assert.ok(!titles.some(t => t.startsWith('Some Fringe Play')), 'Off-West End venue dropped');
  assert.ok(!titles.some(t => t.startsWith('Last Season Show')), 'previous season dropped');
  assert.ok(titles.includes('A Concert@Apollo Theatre'), 'concert kept as a candidate (rejected by decision)');
});

test('buildCandidates attaches signals to the right production of a same-title pair', () => {
  const { candidates } = run();
  const wyndhams = candidates.find(c => c.title === 'Oedipus' && c.venue.startsWith('Wyndham'));
  const oldVic = candidates.find(c => c.title === 'Oedipus' && c.venue === 'Old Vic Theatre');
  assert.equal(wyndhams.sourceUrls.wosReview, 'https://wos/r1');
  assert.equal(oldVic.sourceUrls.wosReview, 'https://wos/r2');
  assert.equal(wyndhams.decision.promotable, true);
  assert.equal(oldVic.decision.promotable, true);
});

test('buildCandidates marks rows already in shows.json and never promotes them', () => {
  const juno = run().candidates.find(c => c.title === 'Juno and the Paycock');
  assert.equal(juno.inShowsJson, 'juno-and-the-paycock-west-end-2024');
  assert.equal(juno.decision.promotable, false);
});

test('buildCandidates catches the same production listed at a different venue (same title, start within a week)', () => {
  const shows = [{ id: 'burlesque-west-end-2026', title: 'Kyoto', venue: 'The Arts at Marble Arch', previewsStartDate: '2025-01-10' }];
  const { candidates } = buildCandidates({ season: SEASON, listings: LISTINGS, reviews: REVIEWS, oliviers: OLIVIERS, shows, today: TODAY });
  assert.equal(candidates.find(c => c.title === 'Kyoto').inShowsJson, 'burlesque-west-end-2026');
});

test('buildCandidates reports West End reviews with no listing, for a human', () => {
  const { unlistedReviews } = run();
  assert.deepEqual(unlistedReviews.map(r => r.title), ['Coriolanus']);
});

test('collapseDuplicateListings keeps one row per production, preferring the one with an opening date', () => {
  const rows = collapseDuplicateListings([
    listing({ title: 'MJ the Musical', venue: 'Prince Edward Theatre', previewsStartDate: '2024-03-06' }),
    listing({ title: 'MJ the Musical', venue: 'Prince Edward Theatre', previewsStartDate: '2024-03-06', openingDate: '2024-03-27' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].openingDate, '2024-03-27');
});

test('planPromotions: id year comes from the start date, not the season start', () => {
  const { candidates } = run();
  const { toPromote } = planPromotions({ candidates, shows: SHOWS, approvals: {} });
  const ids = toPromote.map(e => e.id).sort();
  assert.deepEqual(ids, ['kyoto-west-end-2025', 'oedipus-west-end-2024', 'oedipus-west-end-2025']);
});

test('planPromotions writes dates, no provisional, no todaytixId, and evidence URLs', () => {
  const { toPromote } = planPromotions({ candidates: run().candidates, shows: SHOWS, approvals: {} });
  const e = toPromote.find(x => x.id === 'oedipus-west-end-2024');
  assert.equal(e.previewsStartDate, '2024-10-04');
  assert.equal(e.openingDate, '2024-10-15');
  assert.equal(e.closingDate, '2025-01-04');
  assert.equal(e.status, 'closed');
  assert.equal(e.slug, e.id);
  assert.equal('provisional' in e, false);
  assert.equal('todaytixId' in e, false);
  assert.deepEqual(e.evidenceUrls, ['https://wos/Oedipus', 'https://wos/r1']);
});

test('planPromotions honours --only and re-checks duplicates against current shows.json', () => {
  const candidates = run().candidates;
  const only = new Set(['Kyoto']);
  assert.deepEqual(planPromotions({ candidates, shows: SHOWS, approvals: {}, only }).toPromote.map(e => e.id), ['kyoto-west-end-2025']);
  const nowPresent = [...SHOWS, { id: 'kyoto-west-end-2025', title: 'Kyoto', venue: '@sohoplace', previewsStartDate: '2025-01-09' }];
  assert.deepEqual(planPromotions({ candidates, shows: nowPresent, approvals: {}, only }).toPromote, []);
});

test('effectiveDecision: approvals can overrule a judgement call but not missing facts', () => {
  const c = { title: 'Ballet Shoes', venue: 'Olivier Theatre', previewsStartDate: '2024-11-23', closingDate: '2025-02-22', season: SEASON, decision: { promotable: false, reason: 'non-theatre genre: dance' } };
  assert.equal(effectiveDecision(c, { [SEASON]: { 'Ballet Shoes': { decision: 'approve', reason: 'NT play tagged dance' } } }).promotable, true);
  assert.equal(effectiveDecision({ ...c, closingDate: null }, { [SEASON]: { 'Ballet Shoes': { decision: 'approve' } } }).promotable, false);
  const ok = { ...c, decision: { promotable: true, reason: 'x' } };
  assert.equal(effectiveDecision(ok, { [SEASON]: { 'Ballet Shoes': { decision: 'reject', reason: 'dup' } } }).promotable, false);
});

test('planWetMerge: URL merges for a no-star outlet; stars do not (BRO-4851)', () => {
  const row = { outlet: 'The Spectator', stars: 3, critic: 'Lloyd Evans', url: 'https://www.spectator.co.uk/article/x' };
  const { patch } = planWetMerge({ outletId: 'spectator-uk' }, row, 'spectator-uk');
  assert.deepEqual(patch, { url: 'https://www.spectator.co.uk/article/x' });
});

test('planWetMerge: star outlet gets both; existing rating/URL are never overwritten', () => {
  const row = { outlet: 'The Guardian', stars: 4, critic: 'Arifa Akbar', url: 'https://g/x' };
  assert.deepEqual(planWetMerge({}, row, 'guardian').patch, { aggregatorStars: '4/5', url: 'https://g/x' });
  assert.deepEqual(planWetMerge({ originalRating: '3/5', url: 'https://g/y' }, row, 'guardian').patch, {});
});

test('matchWetRow: two critics on one outlet need the critic name to pick a row', () => {
  const rows = new Map([['times-uk', [{ critic: 'Clive Davis', url: 'a' }, { critic: 'Dominic Maxwell', url: 'b' }]]]);
  assert.equal(matchWetRow(rows, 'times-uk', 'Dominic Maxwell').row.url, 'b');
  assert.equal(matchWetRow(rows, 'times-uk', 'Someone Else').ambiguous, true);
});

test('fixAllCapsTitle and straight apostrophes in written titles', () => {
  assert.equal(fixAllCapsTitle('BRACE BRACE'), 'Brace Brace');
  assert.equal(fixAllCapsTitle('THE LEGENDS OF THEM'), 'The Legends of Them');
  assert.equal(fixAllCapsTitle('MJ the Musical'), 'MJ the Musical');
  const e = buildShowEntry({ title: 'Mrs Warren’s Profession', venue: 'Garrick Theatre', openingDate: '2025-05-22', closingDate: '2025-08-16', season: SEASON }, new Set());
  assert.equal(e.title, "Mrs Warren's Profession");
  assert.equal(e.id, 'mrs-warrens-profession-west-end-2025');
});
