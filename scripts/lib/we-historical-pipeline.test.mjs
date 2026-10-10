// End-to-end logic tests for the WE historical backfill (BRO-4851):
// discover-historical-shows-we.js buildCandidates() and
// promote-historical-we.js planPromotions(). Root-level scripts/*.test.mjs
// are not globbed by test.yml, so these live here and require the scripts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCandidates, collapseDuplicateListings, plausibleOpeningDate } = require('../discover-historical-shows-we.js');
const { planPromotions, effectiveDecision, fixAllCapsTitle, buildShowEntry, inferShowType } = require('../promote-historical-we.js');
const { planWetMerge, matchWetRow, roundupWindow } = require('../merge-wet-stars-urls.js');
const { discoverWetRoundupRows } = require('./wet-roundup-discover.js');
const { auditSeason } = require('../audit-we-historical-season.js');

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
  const shows = [{ id: 'burlesque-west-end-2026', title: 'Kyoto', venue: 'The Arts at Marble Arch', market: 'west-end', previewsStartDate: '2025-01-10' }];
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

test('planWetMerge: a lone WET row by a DIFFERENT critic does not give its URL to this review', () => {
  const row = { outlet: 'The Spectator', critic: 'Someone Else', url: 'https://spec/other' };
  assert.deepEqual(planWetMerge({ criticName: 'Lloyd Evans' }, row, 'spectator-uk').patch, {});
  // An unnamed (table-format) row still merges.
  assert.deepEqual(planWetMerge({ criticName: 'Lloyd Evans' }, { ...row, critic: 'Unknown' }, 'spectator-uk').patch, { url: 'https://spec/other' });
});

test('buildCandidates: WOS opening date equal to the first preview is treated as unknown', () => {
  const { candidates } = buildCandidates({
    season: SEASON, reviews: [], oliviers: [], shows: [], today: TODAY,
    listings: [listing({ title: 'Clueless', venue: 'Trafalgar Theatre', previewsStartDate: '2025-02-15', openingDate: '2025-02-15', closingDate: '2025-08-23' })],
  });
  assert.equal(candidates[0].openingDate, null);
  assert.equal(candidates[0].previewsStartDate, '2025-02-15');
});

test('plausibleOpeningDate: rejects placeholder and implausibly late press nights', () => {
  assert.equal(plausibleOpeningDate({ previewsStartDate: '2024-10-01', openingDate: '2024-12-08' }), null);
  assert.equal(plausibleOpeningDate({ previewsStartDate: '2025-02-15', openingDate: '2025-02-15' }), null);
  assert.equal(plausibleOpeningDate({ previewsStartDate: '2024-10-04', openingDate: '2024-10-15' }), '2024-10-15');
  assert.equal(plausibleOpeningDate({ previewsStartDate: null, openingDate: '2024-10-15' }), '2024-10-15');
});

test('buildCandidates: a same-title BROADWAY show starting the same week is not a West End duplicate', () => {
  const shows = [{ id: 'kyoto-2025', title: 'Kyoto', venue: 'Some Broadway Theatre', market: 'broadway', previewsStartDate: '2025-01-10' }];
  const { candidates } = buildCandidates({ season: SEASON, listings: LISTINGS, reviews: REVIEWS, oliviers: OLIVIERS, shows, today: TODAY });
  assert.equal(candidates.find(c => c.title === 'Kyoto').inShowsJson, null);
});

test('planPromotions writes the venue spelling already used on the site', () => {
  const shows = [
    ...SHOWS,
    { id: 'a-west-end-2026', title: 'A', venue: 'The Old Vic', market: 'west-end' },
    { id: 'b-west-end-2026', title: 'B', venue: 'The Old Vic', market: 'west-end' },
  ];
  const { toPromote } = planPromotions({ candidates: run().candidates, shows, approvals: {} });
  assert.equal(toPromote.find(e => e.id === 'oedipus-west-end-2025').venue, 'The Old Vic');
});

test('effectiveDecision: an approval cannot mark a show that has not closed as closed', () => {
  const c = { title: 'X', venue: 'Gielgud Theatre', previewsStartDate: '2026-01-01', closingDate: '2027-01-01', season: '2025-2026', decision: { promotable: false, reason: 'not closed yet' } };
  assert.equal(effectiveDecision(c, { '2025-2026': { X: { decision: 'approve' } } }, TODAY).promotable, false);
});

test('auditSeason: flags a review of the OTHER same-title production and duplicate critics', () => {
  const show = (id, venue, previews, close) => ({ id, title: 'Oedipus', venue, previewsStartDate: previews, closingDate: close, status: 'closed', category: 'west-end', market: 'west-end', season: SEASON, discoverySource: 'we-historical:wos' });
  const shows = [show('oedipus-west-end-2024', "Wyndham's Theatre", '2024-10-04', '2025-01-04'), show('oedipus-west-end-2025', 'The Old Vic', '2025-01-21', '2025-03-29')];
  const rev = (showId, outletId, critic, date, score = 60) => ({ showId, outletId, outlet: outletId, criticName: critic, publishDate: date, assignedScore: score, url: 'https://x' });
  const reviews = [
    ...['guardian', 'telegraph', 'times-uk', 'standard', 'financialtimes'].map(o => rev('oedipus-west-end-2024', o, `${o} critic`, '2024-10-16')),
    rev('oedipus-west-end-2025', 'guardian', 'A', '2025-02-05'),
    rev('oedipus-west-end-2025', 'guardian', 'A', '2025-02-06'),
    // Wyndham's review (Oct 2024) attached to the Old Vic production:
    rev('oedipus-west-end-2025', 'telegraph', 'B', '2024-10-16'),
  ];
  const r = auditSeason({ shows, reviews, season: SEASON });
  assert.equal(r.checks.inWindow.value, 1);
  assert.equal(r.checks.inWindow.rows[0].showId, 'oedipus-west-end-2025');
  assert.equal(r.checks.duplicates.value, 1);
  assert.equal(r.checks.displayable.value, 0.5);
  assert.equal(r.pass, false);
});

test('auditSeason: a clean season passes; --ids limits the audit to a batch', () => {
  const s = { id: 'kyoto-west-end-2025', title: 'Kyoto', venue: '@sohoplace', previewsStartDate: '2025-01-09', closingDate: '2025-05-03', status: 'closed', category: 'west-end', market: 'west-end', season: SEASON, discoverySource: 'we-historical:wos' };
  const other = { ...s, id: 'unscored-west-end-2025' };
  const reviews = ['guardian', 'telegraph', 'times-uk', 'standard', 'thestage'].map(o => ({ showId: s.id, outletId: o, outlet: o, criticName: o, publishDate: '2025-01-20', assignedScore: 70 }));
  assert.equal(auditSeason({ shows: [s, other], reviews, season: SEASON }).pass, false);
  assert.equal(auditSeason({ shows: [s, other], reviews, season: SEASON, ids: new Set([s.id]) }).pass, true);
});

test('roundupWindow + discoverWetRoundupRows: historical merge searches only the run\'s own window', async () => {
  const show = { id: 'just-for-one-day-the-live-aid-musical-west-end-2025', title: 'Just For One Day', previewsStartDate: '2025-05-15', closingDate: '2026-02-07' };
  const w = roundupWindow(show);
  assert.deepEqual(w, { after: '2025-04-15', before: '2025-07-14' });
  let url = '';
  await discoverWetRoundupRows(show, { ...w, fetchJSON: async (u) => { url = u; return []; }, fetchPage: async () => null, log: () => {} });
  assert.match(url, /&after=2025-04-15T00:00:00&before=2025-07-14T00:00:00$/);
  // Live callers pass no window: URL unchanged.
  await discoverWetRoundupRows(show, { fetchJSON: async (u) => { url = u; return []; }, fetchPage: async () => null, log: () => {} });
  assert.doesNotMatch(url, /after=/);
  assert.deepEqual(roundupWindow({ title: 'X' }), {});
});

test('WET roundup window excludes a same-title successor and an earlier run, even if the API ignores the dates', async () => {
  // Pilot run 37722682420: the 2024 Wyndham's Oedipus picked the Feb 2025 Old Vic roundup.
  const wyndhams = { id: 'oedipus-west-end-2024', title: 'Oedipus', previewsStartDate: '2024-10-04', openingDate: '2024-10-15', closingDate: '2025-01-04' };
  const w = roundupWindow(wyndhams);
  assert.deepEqual(w, { after: '2024-09-04', before: '2024-12-14' });
  const html = '<table><tr><td>The Guardian</td><td>★★★★</td></tr></table>';
  const posts = [
    { id: 273849, date: '2025-02-05T10:00:00', link: 'https://wet/oldvic', title: { rendered: 'Oedipus reviews round-up at the Old Vic' }, content: { rendered: html } },
    { id: 260001, date: '2024-10-16T10:00:00', link: 'https://wet/wyndhams', title: { rendered: 'Oedipus reviews round-up at Wyndham’s' }, content: { rendered: html } },
  ];
  const r = await discoverWetRoundupRows(wyndhams, { ...w, fetchJSON: async () => posts, fetchPage: async () => null, log: () => {} });
  assert.equal(r.post.link, 'https://wet/wyndhams');
  const jfod = { title: 'Just For One Day', previewsStartDate: '2025-05-15', closingDate: '2026-02-07' };
  const none = await discoverWetRoundupRows(jfod, { ...roundupWindow(jfod), fetchJSON: async () => [{ ...posts[0], date: '2023-02-10T10:00:00', title: { rendered: 'Just For One Day reviews round-up' } }], fetchPage: async () => null, log: () => {} });
  assert.equal(none, null);
});

test('fixAllCapsTitle and straight apostrophes in written titles', () => {
  assert.equal(fixAllCapsTitle('BRACE BRACE'), 'Brace Brace');
  assert.equal(fixAllCapsTitle('THE LEGENDS OF THEM'), 'The Legends of Them');
  assert.equal(fixAllCapsTitle('MJ the Musical'), 'MJ the Musical');
  const e = buildShowEntry({ title: 'Mrs Warren’s Profession', venue: 'Garrick Theatre', openingDate: '2025-05-22', closingDate: '2025-08-16', season: SEASON }, new Set());
  assert.equal(e.title, "Mrs Warren's Profession");
  assert.equal(e.id, 'mrs-warrens-profession-west-end-2025');
});

// BRO-4851: WOS lists Porn Play as "P*rn Play"; promoted as-is, gather found 0 reviews.
test('planPromotions: a censored title is held until approvals supply the real one', () => {
  const c = { title: 'P*rn Play', venue: 'Royal Court Theatre', season: '2025-2026', previewsStartDate: '2025-11-06', closingDate: '2025-12-13',
    genres: ['play'], signals: ['wos-review'], decision: { promotable: true, persistent: true, reason: 'signals: wos-review' } };
  const held = planPromotions({ candidates: [c], shows: [], approvals: {}, today: '2026-10-08' });
  assert.equal(held.toPromote.length, 0);
  assert.match(held.skipped[0].reason, /censored title/);
  const fixed = planPromotions({ candidates: [c], shows: [], approvals: { '2025-2026': { 'P*rn Play': { title: 'Porn Play' } } }, today: '2026-10-08' });
  assert.equal(fixed.toPromote.length, 1);
  assert.equal(fixed.toPromote[0].title, 'Porn Play');
});

// Phase B found these by eye; the season audit now flags them (BRO-4851).
test('season audit: wrong-production posters, censored titles and synopses to look at', () => {
  const { auditSeason, posterProblem, synopsisNeedsLook } = require('../audit-we-historical-season.js');
  const othello = { id: 'othello-west-end-2025', title: 'Othello', category: 'west-end', season: '2025-2026', discoverySource: 'we-historical:wos', images: { poster: '/p.jpg', hero: null } };
  assert.equal(posterProblem(othello, { poster: 'https://d2rawotm8xdpob.cloudfront.net/v0/b/theatr-app.appspot.com/o/imgs/x.jpeg' }), 'London row with NYC-only (Theatr) art');
  assert.equal(posterProblem({ ...othello, rejectedImageUrls: ['https://x/a.jpg'] }, { poster: 'https://x/a.jpg?w=1' }), 'art from a rejected URL');
  assert.equal(posterProblem(othello, { poster: 'https://www.theaterdiary.com/parse/files/othello haymarket.jpg' }), null);
  assert.equal(synopsisNeedsLook('Don’t miss Emmy-nominated actor Joe Locke making his West End debut in this tender drama. Clarkston follows two young men who meet in a small town.'), true);
  assert.equal(synopsisNeedsLook('The Shitheads is a play that is set thousands of years ago among some of the earliest inhabitants of Britain. The harmony of their cave life is shattered when strangers arrive.'), false);
  const porn = { ...othello, id: 'p-rn-play-west-end-2025', title: 'P*rn Play', images: {} };
  const r = auditSeason({ shows: [othello, porn], reviews: [], season: '2025-2026', imageSources: { [othello.id]: { poster: 'https://x/theatr-app.appspot.com/y.jpg' } } });
  assert.equal(r.checks.poster.pass, false);
  assert.deepEqual(r.checks.poster.missing, ['p-rn-play-west-end-2025']);
  assert.equal(r.checks.titles.pass, false);
  assert.equal(r.checks.synopsis.pass, null);
  assert.equal(r.pass, false);
});

test('season audit poster check ignores a cleared field whose old source is still on file', () => {
  const { posterProblem } = require('../audit-we-historical-season.js');
  const godot = { id: 'waiting-for-godot-west-end-2024', category: 'west-end', images: { poster: '/p.jpg', thumbnail: '/t.jpg', hero: null }, rejectedImageUrls: ['https://x/banner.jpg'] };
  assert.equal(posterProblem(godot, { poster: 'https://www.theaterdiary.com/godot haymarket.jpg', hero: 'https://x/banner.jpg' }), null);
});

// BRO-4884: WOS gave no genre for Sunset Boulevard, Next to Normal, The
// Witches and others, and an empty list used to mean 'play'.
test('inferShowType: no WOS genre inherits a same-titled musical, else play flagged as guessed', () => {
  const musicals = new Set(['sunset boulevard']);
  assert.deepEqual(inferShowType({ title: 'Sunset Boulevard', genres: [] }, musicals), { type: 'musical', guessed: false });
  assert.deepEqual(inferShowType({ title: 'The Witches', genres: [] }, musicals), { type: 'play', guessed: true });
  assert.deepEqual(inferShowType({ title: 'King Lear', genres: ['play'] }, musicals), { type: 'play', guessed: false });
  // An explicit WOS 'play' beats a same-titled musical (1996 "The Three Sisters" vs the 2019 Lyttelton play).
  assert.deepEqual(inferShowType({ title: 'Three Sisters', genres: ['play'] }, new Set(['three sisters'])), { type: 'play', guessed: false });
  assert.deepEqual(inferShowType({ title: 'Mean Girls', genres: ['musical'] }), { type: 'musical', guessed: false });
  assert.deepEqual(inferShowType({ title: 'The Witches', genres: [], type: 'musical' }), { type: 'musical', guessed: false });
});

test('planPromotions: approvals type override wins, and unguessable rows are listed', () => {
  const c = (title) => ({ title, venue: 'Olivier Theatre', previewsStartDate: '2024-01-10', openingDate: '2024-01-20', closingDate: '2024-03-01', genres: [], season: SEASON, signals: ['wos-review'], sourceUrls: {}, inShowsJson: null, decision: { promotable: true } });
  const shows = [...SHOWS, { id: 'sunset-boulevard-2024', title: 'Sunset Boulevard', venue: 'St. James Theatre', type: 'musical' }];
  const approvals = { [SEASON]: { 'The Witches': { type: 'musical' } } };
  const { toPromote, typeGuessed } = planPromotions({ candidates: [c('Sunset Boulevard'), c('The Witches'), c('Nye')], shows, approvals, today: TODAY });
  const type = Object.fromEntries(toPromote.map(e => [e.title, e.type]));
  assert.deepEqual(type, { 'Sunset Boulevard': 'musical', 'The Witches': 'musical', Nye: 'play' });
  assert.deepEqual(typeGuessed, ['nye-west-end-2024']);
});
