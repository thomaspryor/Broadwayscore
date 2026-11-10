// BRO-7166: the search-free "usual critic has no review" alarm. Synthetic fixtures only;
// every assertion runs the real libs (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findExpectedCriticGaps, statusForCells, expectedMissingForShow, liveOutletsByShow, MIN_LIVE_OUTLETS,
} = require('../../scripts/lib/expected-critics.js');
const { gradeLine, gradeOpening } = require('../../scripts/lib/opening-grade.js');
const { standingOutletIds } = require('../../scripts/lib/standing-outlets.js');
const { evaluateStandingCoverage, isStandingIn, marketFold, MIN_PRESS_OUTLETS } = require('../../scripts/audit-standing-coverage.js');

const NOW = Date.parse('2026-11-08T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString().slice(0, 10);

const outlets = {
  nypost: { displayName: 'New York Post', standingCoverage: true, standingMarkets: ['broadway'] },
  nytimes: { displayName: 'New York Times', standingCoverage: true, standingMarkets: ['broadway'] },
  'nyt-theater': { displayName: 'New York Theater', aliases: ['newyorktheater', 'new york theater'] },
  theatermania: { displayName: 'TheaterMania', standingCoverage: true, standingMarkets: ['broadway', 'off-broadway'] },
  whatsonstage: { displayName: 'WhatsOnStage', standingCoverage: true, standingMarkets: ['west-end'] },
  'timeout-london': { displayName: 'Time Out London', standingCoverage: true, standingMarkets: ['west-end'] },
  timeout: { displayName: 'Time Out New York' },
  guardian: { displayName: 'Guardian' },
  telegraph: { displayName: 'Telegraph' },
  variety: { displayName: 'Variety' },
  skipper: { displayName: 'Skipper', standingCoverage: true, standingMarkets: ['broadway'], coverageExpectation: 'none', coverageExpectationDecidedAt: new Date(NOW - 2 * 86400000).toISOString() },
};

const shows = [
  { id: 'bway', title: 'Bway Show', category: 'broadway', openingDate: daysAgo(10) },
  { id: 'we', title: 'WE Show', category: 'west-end', openingDate: daysAgo(10) },
  { id: 'fresh', title: 'Fresh', category: 'broadway', openingDate: daysAgo(1) },
  { id: 'old', title: 'Old', category: 'broadway', openingDate: daysAgo(60) },
  { id: 'quiet', title: 'Quiet', category: 'broadway', openingDate: daysAgo(10) },
  { id: 'small', title: 'Small', category: 'broadway', openingDate: daysAgo(10) },
];
const rv = (showId, outletId) => ({ showId, outletId });
const reviews = [
  rv('bway', 'nytimes'), rv('bway', 'newyorktheater'), rv('bway', 'theatermania'), rv('bway', 'variety'), rv('bway', 'ap'),
  // West End: 'timeout' (the NY id) folds to timeout-london on a London show.
  rv('we', 'timeout'), rv('we', 'guardian'), rv('we', 'telegraph'), rv('we', 'ft'), rv('we', 'times-uk'),
  rv('fresh', 'nytimes'), rv('fresh', 'variety'), rv('fresh', 'theatermania'), rv('fresh', 'ap'), rv('fresh', 'guardian'),
  rv('old', 'nytimes'), rv('old', 'variety'), rv('old', 'theatermania'), rv('old', 'ap'), rv('old', 'guardian'),
  rv('quiet', 'nytimes'), // one outlet: no press night yet
  // 'small': four outlets, under the floor the standing sets are measured on (MIN_PRESS_OUTLETS)
  rv('small', 'nytimes'), rv('small', 'variety'), rv('small', 'theatermania'), rv('small', 'ap'),
];

const gaps = (extra = {}) => findExpectedCriticGaps({ shows, reviews, outlets, nowMs: NOW, ...extra });
const cell = (rows, showId, outletId) => rows.find((r) => r.showId === showId && r.outletId === outletId);

test('a usual critic with no review 72h+ after opening is missing; one that reviewed is live', () => {
  const rows = gaps();
  assert.equal(cell(rows, 'bway', 'nypost').status, 'missing');
  assert.equal(cell(rows, 'bway', 'nytimes').status, 'live');
  assert.equal(cell(rows, 'bway', 'theatermania').status, 'live');
});

test('aliases resolve before the live check (newyorktheater is nyt-theater, never nytimes)', () => {
  const live = liveOutletsByShow(shows, reviews, outlets).get('bway');
  assert.ok(live.has('nyt-theater'));
  assert.ok(!live.has('newyorktheater'));
});

test('West End uses its own set and folds NY ids to the -london outlet', () => {
  const rows = gaps({ market: 'west-end' });
  assert.equal(cell(rows, 'we', 'timeout-london').status, 'live');
  assert.equal(cell(rows, 'we', 'whatsonstage').status, 'missing');
  assert.equal(cell(rows, 'we', 'nypost'), undefined, 'a Broadway-only standing outlet is not expected in London');
  assert.equal(marketFold(outlets, 'broadway'), null, 'no fold on Broadway');
});

test('window: under 72h and over 42 days are not checked; since/until replaces the age window', () => {
  const rows = gaps();
  assert.ok(!rows.some((r) => r.showId === 'fresh'));
  assert.ok(!rows.some((r) => r.showId === 'old'));
  const ranged = gaps({ since: daysAgo(90) });
  assert.equal(cell(ranged, 'old', 'nypost').status, 'missing');
  assert.ok(!ranged.some((r) => r.showId === 'fresh'), 'still too early under a date range');
});

test(`press-night gate: fewer than ${MIN_LIVE_OUTLETS} live outlets means no cells`, () => {
  assert.equal(MIN_LIVE_OUTLETS, MIN_PRESS_OUTLETS, 'alarm floor must match the floor the standing sets are measured on');
  assert.ok(!gaps().some((r) => r.showId === 'quiet'));
  assert.ok(!gaps().some((r) => r.showId === 'small'), 'a 4-outlet show is below the measured floor');
});

test('age is calendar days since the opening date', () => {
  assert.equal(cell(gaps(), 'bway', 'nypost').ageDays, 10);
});

test('an ack makes the cell not-reviewed with its evidence; an active no-coverage claim makes it not-expected', () => {
  const acks = [{ key: 'bway::nypost', ackedAt: '2026-11-08T00:00:00Z', note: 'outlet listing checked, no review' }];
  const rows = gaps({ acks });
  assert.equal(cell(rows, 'bway', 'nypost').status, 'not-reviewed');
  assert.equal(cell(rows, 'bway', 'nypost').ackNote, 'outlet listing checked, no review');
  assert.equal(cell(rows, 'bway', 'skipper').status, 'not-expected');
});

test('statusForCells reports named cells outside the expected set too', () => {
  const [a, b, c] = statusForCells({ keys: ['bway::variety', 'bway::guardian', 'nope::x'], shows, reviews, outlets, nowMs: NOW });
  assert.equal(a.status, 'live');
  assert.equal(a.expected, false);
  assert.equal(b.status, 'missing');
  assert.equal(c.status, 'unknown-show');
});

test('standing membership is per market (theatermania counts on Broadway and Off-Broadway, not West End)', () => {
  assert.ok(isStandingIn(outlets.theatermania, 'off-broadway'));
  assert.ok(!isStandingIn(outlets.theatermania, 'west-end'));
  assert.ok(standingOutletIds(outlets, 'west-end').includes('whatsonstage'));
  assert.ok(!standingOutletIds(outlets, 'broadway').includes('whatsonstage'));
  const ev = evaluateStandingCoverage([], [], outlets, NOW, { category: 'west-end' });
  assert.equal(ev.category, 'west-end');
});

test('the opening grade line names missing usual critics without changing the verdict', () => {
  const missing = expectedMissingForShow('bway', gaps());
  assert.deepEqual(missing.map((m) => m.outletId), ['nypost']);
  const base = { title: 'Bway Show', category: 'broadway', openingDate: daysAgo(10), live: 5, known: 5, windowClosed: true, verdict: 'on-its-own', signals: [] };
  const plain = gradeLine(base);
  const withUsual = gradeLine({ ...base, expectedMissing: missing });
  assert.ok(!/Usual critics/.test(plain));
  assert.ok(withUsual.startsWith(plain));
  assert.match(withUsual, /Usual critics with no review yet: New York Post\.$/);
  const g = gradeOpening({ show: shows[0], files: [], commits: [], expectedMissing: missing, nowMs: NOW });
  const g0 = gradeOpening({ show: shows[0], files: [], commits: [], nowMs: NOW });
  assert.deepEqual(g.expectedMissing, missing);
  assert.equal(g.verdict, g0.verdict);
  assert.equal(g0.expectedMissing, null);
});

// ---------------------------------------------------------------------------
// BRO-7312: recover missing cells automatically; tell the owner only about dead ends.
const R = require('../../scripts/lib/expected-critics-recovery.js');
const { getTargetOutlets, publishWindowVerdict } = require('../../scripts/collect-outlet-reviews.js');

const DAY = 86400000;
const OPEN = '2026-10-01';
const OPENED = Date.parse(OPEN) + DAY; // end of opening day, as the gap finder reads it
const at = (days) => OPENED + days * DAY;
const gap = (showId, outletId, extra = {}) => ({ showId, outletId, outletName: outletId, title: showId, openingDate: OPEN, status: 'missing', ...extra });
const attempt = (days, outcome, extra = {}) => ({ at: new Date(at(days)).toISOString(), outcome, ...extra });

test('standing outlets sort ahead of the 60-outlet cap (theatermania was index 63 in tier+alpha order)', () => {
  const reg = { outlets: {} };
  for (let i = 0; i < 70; i++) reg.outlets[`a${String(i).padStart(2, '0')}`] = { domain: `a${i}.com`, tier: 1 };
  reg.outlets.theatermania = { domain: 'theatermania.com', tier: 2, standingCoverage: true, standingMarkets: ['broadway', 'off-broadway'] };
  const ids = getTargetOutlets('off-broadway', 1, 3, reg, 60).map((o) => o.id);
  assert.equal(ids.length, 60);
  assert.equal(ids[0], 'theatermania');
  // --outlets narrows before the cap, so a targeted run always contains its outlet
  assert.deepEqual(getTargetOutlets('off-broadway', 1, 3, reg, 60, new Set(['theatermania'])).map((o) => o.id), ['theatermania']);
});

test('a missing cell plans a collector run for exactly that show and outlet', () => {
  const state = R.syncState(R.emptyState(), [gap('medea', 'theatermania'), gap('other', 'nypost', { status: 'live' })], at(3));
  assert.deepEqual(Object.keys(state.cells), ['medea::theatermania']);
  const plans = R.planRecovery(state, at(3));
  assert.deepEqual(plans, [{ showId: 'medea', outletIds: ['theatermania'] }]);
  const args = R.collectorArgs(plans[0], { resultJson: '/tmp/r.json' });
  const val = (k) => args[args.indexOf(k) + 1];
  assert.equal(val('--shows'), 'medea');
  assert.equal(val('--outlets'), 'theatermania');
  assert.equal(val('--max-searches'), '1');
  assert.equal(val('--result-json'), '/tmp/r.json');
  assert.ok(args.includes('--require-publish-window'));
  assert.ok(!args.includes('--dry-run'));
  // not due before day 3, and the cap holds
  assert.deepEqual(R.planRecovery(state, at(2)), []);
  assert.deepEqual(R.planRecovery(state, at(3), { maxSearches: 0 }), []);
});

test('three empty searches, the last 14+ days after opening, auto-ack the cell with the evidence', () => {
  let state = R.syncState(R.emptyState(), [gap('medea', 'theatermania')], at(3));
  const plan = { showId: 'medea', outletIds: ['theatermania'] };
  const empty = [{ showId: 'medea', outletId: 'theatermania', outcome: 'no_evidence' }];
  for (const d of [3, 7, 14]) {
    assert.equal(R.cellPhase(state.cells['medea::theatermania'], at(d)).phase, 'recovering');
    assert.equal(R.planRecovery(state, at(d)).length, 1, `due on day ${d}`);
    state = R.applyResults(state, { plan, rows: empty, nowMs: at(d) });
  }
  const cell = state.cells['medea::theatermania'];
  assert.equal(R.cellPhase(cell, at(14)).phase, 'acked');
  assert.match(cell.autoAck.note, /3 targeted searches of theatermania for medea found no review/);
  const acks = R.mergedAcks([{ key: 'x::y', ackedAt: 't', note: 'manual' }], state);
  assert.equal(acks.length, 2);
  assert.equal(acks[1].key, 'medea::theatermania');
  // the gap finder then reads the cell as not-reviewed, and the state keeps it
  const shows = [{ id: 'medea', title: 'Medea', category: 'off-broadway', openingDate: OPEN }];
  const others = ['a', 'b', 'c', 'd', 'e', 'f'];
  const reviews = others.map((o) => ({ showId: 'medea', outletId: o }));
  const out = { theatermania: { displayName: 'TheaterMania', standingCoverage: true, standingMarkets: ['off-broadway'] }, ...Object.fromEntries(others.map((o) => [o, {}])) };
  assert.equal(findExpectedCriticGaps({ shows, reviews, outlets: out, acks: [], nowMs: at(15) }).find((r) => r.outletId === 'theatermania').status, 'missing');
  const rows = findExpectedCriticGaps({ shows, reviews, outlets: out, acks, nowMs: at(15) });
  assert.equal(rows.find((r) => r.outletId === 'theatermania').status, 'not-reviewed');
  assert.ok(R.syncState(state, rows, at(15)).cells['medea::theatermania'].autoAck);
});

test('three early empty searches (an old backlog cell) need one more after day 14 before acking', () => {
  const cell = { showId: 's', outletId: 'o', openingDate: OPEN, attempts: [attempt(3, 'no_evidence'), attempt(4, 'no_evidence'), attempt(5, 'no_evidence')] };
  const p = R.cellPhase(cell, at(6));
  assert.equal(p.phase, 'recovering');
  assert.equal(p.nextDueMs, at(14));
});

test('a failed search (SERP down, no result row) never counts toward an ack', () => {
  let state = R.syncState(R.emptyState(), [gap('s', 'o')], at(3));
  const plan = { showId: 's', outletIds: ['o'] };
  for (const d of [3, 7, 14]) state = R.applyResults(state, { plan, rows: [], nowMs: at(d) });
  const cell = state.cells['s::o'];
  assert.deepEqual(cell.attempts.map((a) => a.outcome), ['non_evidence', 'non_evidence', 'non_evidence']);
  assert.equal(R.cellPhase(cell, at(15)).phase, 'recovering');
  // ...but a search that keeps breaking ends as a dead end the owner hears about
  for (let d = 15; d < 20; d++) state = R.applyResults(state, { plan, rows: [], nowMs: at(d) });
  assert.deepEqual(R.cellPhase(state.cells['s::o'], at(20)), { phase: 'dead-end', reason: 'search-keeps-failing', nextDueMs: null });
});

test('the owner sees no expected-critics line while searches remain; dead ends and a stalled recovery surface in plain English', () => {
  const g = gap('medea', 'theatermania', { outletName: 'TheaterMania', title: 'Medea' });
  const fresh = R.syncState(R.emptyState(), [g], at(3));
  assert.equal(R.splitForOwner([g], fresh, at(3)).visible.length, 0);
  const tried = { cells: { 'medea::theatermania': { ...fresh.cells['medea::theatermania'], attempts: [attempt(3, 'no_evidence'), attempt(7, 'no_evidence')] } } };
  const s = R.splitForOwner([g], tried, at(8));
  assert.equal(s.visible.length, 0);
  assert.equal(s.recovering.length, 1);
  // the grade line stays silent for a recovering cell (grade-openings passes only visible gaps)
  assert.equal(expectedMissingForShow('medea', s.visible).length, 0);

  // dead end: the only find was not a review
  const dead = { cells: { 'medea::theatermania': { ...tried.cells['medea::theatermania'], attempts: [attempt(3, 'no_evidence'), attempt(7, 'rejected', { reason: 'non-review-url' }), attempt(14, 'no_evidence')] } } };
  const v = R.splitForOwner([g], dead, at(15)).visible;
  assert.equal(v.length, 1);
  assert.equal(R.ownerLine(v[0]), 'TheaterMania on Medea: no review on the site, and the only match was a page that is not a review.');
  assert.doesNotMatch(R.ownerLine(v[0]), /::|—|BRO-|\.js/);

  // not searchable ends at once
  const ns = { cells: { 'medea::theatermania': { ...fresh.cells['medea::theatermania'], attempts: [attempt(3, 'not_searchable', { reason: 'no-domain' })] } } };
  assert.equal(R.splitForOwner([g], ns, at(3.5)).visible[0].recovery.reason, 'not-searchable');

  // recovery never ran: quiet for 2 days after the cell became missing, then visible
  assert.equal(R.splitForOwner([g], R.emptyState(), at(3)).visible.length, 0);
  assert.equal(R.splitForOwner([g], R.emptyState(), at(6)).visible[0].recovery.reason, 'recovery-not-running');
  // recovery stalled: a due search 2+ days overdue
  assert.equal(R.splitForOwner([g], fresh, at(6)).visible[0].recovery.reason, 'recovery-overdue');
});

test('a written review waits for the rebuild, then counts as unusable if it never went live', () => {
  const c = { showId: 's', outletId: 'o', openingDate: OPEN, attempts: [attempt(3, 'written', { url: 'https://x' })] };
  assert.equal(R.cellPhase(c, at(4)).reason, 'waiting-for-rebuild');
  const c3 = { ...c, attempts: [...c.attempts, attempt(7, 'written'), attempt(14, 'written')] };
  assert.deepEqual(R.cellPhase(c3, at(18)), { phase: 'dead-end', reason: 'written-not-live', nextDueMs: null });
});

test('the collector refuses a page dated outside the production window (or undated, for West End)', () => {
  const w = { dateMin: new Date('2026-10-01'), dateMax: new Date('2026-11-30') };
  assert.equal(publishWindowVerdict('2026-10-02', w), null);
  assert.equal(publishWindowVerdict('2019-05-01', w), 'outside-publish-window');
  assert.equal(publishWindowVerdict(null, w), null);
  assert.equal(publishWindowVerdict(null, { ...w, requireDate: true }), 'no-publish-date');
  assert.equal(publishWindowVerdict('2019-05-01', null), null);
});
