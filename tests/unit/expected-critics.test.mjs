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
