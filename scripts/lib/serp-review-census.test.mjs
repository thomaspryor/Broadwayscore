import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  marketTermFor,
  buildCensusQuery,
  shouldRunSerpCensus,
  DEFAULT_COOLDOWN_HOURS,
} = require('./serp-review-census.js');

const NOW = Date.parse('2026-07-23T12:00:00Z');
const HOUR = 3600000;

test('marketTermFor picks the right phrase per market', () => {
  assert.equal(marketTermFor({ category: 'west-end' }), 'West End review');
  assert.equal(marketTermFor({ category: 'off-west-end' }), 'West End review');
  assert.equal(marketTermFor({ category: 'off-broadway' }), 'Off-Broadway review');
  assert.equal(marketTermFor({ category: 'broadway' }), 'Broadway review');
  assert.equal(marketTermFor({}), 'Broadway review');
});

test('buildCensusQuery builds an outlet-agnostic title+market+year query', () => {
  const show = { title: 'Trainspotting the Musical', category: 'west-end', openingDate: '2026-07-01' };
  assert.equal(buildCensusQuery(show), '"Trainspotting the Musical" West End review 2026');
});

test('buildCensusQuery sanitizes & and tolerates a missing openingDate', () => {
  const show = { title: 'Fun & Games', category: 'broadway' };
  assert.equal(buildCensusQuery(show), '"Fun and Games" Broadway review');
});

test('buildCensusQuery returns null without a title', () => {
  assert.equal(buildCensusQuery(null), null);
  assert.equal(buildCensusQuery({ category: 'broadway' }), null);
});

test('shouldRunSerpCensus: out-of-window show never runs regardless of cooldown', () => {
  assert.equal(shouldRunSerpCensus({ inWindow: false, lastRunAt: null, now: NOW }), false);
});

test('shouldRunSerpCensus: in-window + never run → runs', () => {
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt: null, now: NOW }), true);
});

test('shouldRunSerpCensus: in-window but within cooldown → skipped', () => {
  const lastRunAt = new Date(NOW - 2 * HOUR).toISOString();
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt, now: NOW }), false);
});

test('shouldRunSerpCensus: in-window and cooldown elapsed → runs', () => {
  const lastRunAt = new Date(NOW - (DEFAULT_COOLDOWN_HOURS + 1) * HOUR).toISOString();
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt, now: NOW }), true);
});

test('shouldRunSerpCensus: a custom cooldownHours is respected', () => {
  const lastRunAt = new Date(NOW - 3 * HOUR).toISOString();
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt, now: NOW, cooldownHours: 1 }), true);
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt, now: NOW, cooldownHours: 12 }), false);
});

test('shouldRunSerpCensus: corrupt lastRunAt stamp reads as due, not stuck forever', () => {
  assert.equal(shouldRunSerpCensus({ inWindow: true, lastRunAt: 'not-a-date', now: NOW }), true);
});

// --- buildCensusQueries (scoped variants for all shows — Sukkot 2026-07-25, trigger deleted 2026-07-26) ---
const { buildCensusQueries, venueQueryToken } = require('./serp-review-census.js');

test('buildCensusQueries: every show gets the scoped variants its metadata supports (no ambiguity trigger)', () => {
  // Second-opinion review 2026-07-26: the title-specificity trigger was
  // deleted — acceptance filtering is query-independent, so extra queries can
  // only add coverage. Multi-word titles fan out exactly like "Sukkot" did.
  const show = { title: 'Trainspotting Live in Concert', category: 'west-end', openingDate: '2026-07-01', venue: 'Arts Theatre' };
  const qs = buildCensusQueries(show, { creativeNames: ['Irvine Welsh'] });
  assert.deepEqual(qs, [
    '"Trainspotting Live in Concert" West End review 2026',
    '"Trainspotting Live in Concert" Welsh review',
  ]);
});

test('buildCensusQueries: venue + creative both usable → 3 queries', () => {
  const show = { title: 'Sukkot', category: 'off-broadway', openingDate: '2026-07-11', venue: '59E59 Theaters Theater B' };
  const qs = buildCensusQueries(show, { creativeNames: ['Matthew Leavitt', 'Joel Zwick'] });
  assert.deepEqual(qs, [
    '"Sukkot" Off-Broadway review 2026',
    '"Sukkot" review 59e59',
    '"Sukkot" Leavitt review',
  ]);
});

test('buildCensusQueries: no venue token and no creative names → primary only', () => {
  const show = { title: 'Shifters', category: 'off-broadway', openingDate: '2026-07-16' };
  const qs = buildCensusQueries(show, { creativeNames: [] });
  assert.deepEqual(qs, ['"Shifters" Off-Broadway review 2026']);
});

test('buildCensusQueries: generic venue words cannot scope a query', () => {
  assert.equal(venueQueryToken('The Royal Theatre'), null);
  assert.equal(venueQueryToken('Cherry Lane Theatre'), 'cherry');
  assert.equal(venueQueryToken('Menier Chocolate Factory'), 'menier');
  assert.equal(venueQueryToken(null), null);
});

test('buildCensusQueries: no title → empty array', () => {
  assert.deepEqual(buildCensusQueries({ category: 'broadway' }, {}), []);
});

// ---- naive arm + execution plan (task #872) ----

const {
  buildNaiveCensusQuery,
  buildCensusPlan,
  censusGeoFor,
  DEFAULT_NAIVE_PAGES,
} = require('./serp-review-census.js');

test('buildNaiveCensusQuery is the unquoted, year-free query a human types', () => {
  const show = { title: 'The Car Man', venue: "Sadler's Wells", category: 'off-west-end', openingDate: '2026-07-28' };
  assert.equal(buildNaiveCensusQuery(show), "The Car Man Sadler's Wells review");
});

test('buildNaiveCensusQuery falls back to title-only without a venue, and sanitizes &', () => {
  assert.equal(buildNaiveCensusQuery({ title: 'Fun & Games' }), 'Fun and Games review');
  assert.equal(buildNaiveCensusQuery({ title: null }), null);
});

test('censusGeoFor derives geo from the market, not from the query text', () => {
  assert.equal(censusGeoFor({ category: 'west-end' }), 'gb');
  assert.equal(censusGeoFor({ category: 'off-west-end' }), 'gb');
  assert.equal(censusGeoFor({ category: 'off-broadway' }), 'us');
  assert.equal(censusGeoFor({ category: 'broadway' }), 'us');
  assert.equal(censusGeoFor({}), 'us');
});

test('buildCensusPlan: scoped arms keep the date window, naive arm drops it and paginates', () => {
  const show = { title: 'Tao of Glass', venue: 'Soho Place', category: 'west-end', openingDate: '2026-07-30' };
  const plan = buildCensusPlan(show, { creativeNames: ['Phelim McDermott'] });

  const scoped = plan.filter(p => p.useDateRange);
  const naive = plan.filter(p => !p.useDateRange);

  assert.equal(scoped.length, 3);                    // primary + venue + creative
  assert.ok(scoped.every(p => p.page === 0));
  assert.equal(scoped[0].arm, 'primary');

  assert.equal(naive.length, DEFAULT_NAIVE_PAGES);
  assert.deepEqual(naive.map(p => p.page), [0, 1, 2]);
  assert.ok(naive.every(p => p.query === 'Tao of Glass Soho Place review'));
  assert.deepEqual(naive.map(p => p.arm), ['naive-p0', 'naive-p1', 'naive-p2']);

  // Every arm — scoped included — searches google.co.uk for a London show.
  assert.ok(plan.every(p => p.geo === 'gb'));
});

test('buildCensusPlan: naivePages 0 disables the naive arm; no title → empty plan', () => {
  const show = { title: 'Shifters', category: 'off-broadway', openingDate: '2026-07-16' };
  const plan = buildCensusPlan(show, { creativeNames: [], naivePages: 0 });
  assert.deepEqual(plan.map(p => p.arm), ['primary']);
  assert.equal(plan[0].geo, 'us');
  assert.deepEqual(buildCensusPlan({ category: 'broadway' }, {}), []);
});

const { isCensusPassComplete } = require('./serp-review-census.js');

test('isCensusPassComplete: all arms ok → complete', () => {
  assert.equal(isCensusPassComplete([
    { arm: 'primary', ok: true }, { arm: 'scoped1', ok: true },
    { arm: 'naive-p0', ok: true }, { arm: 'naive-p1', ok: true }, { arm: 'naive-p2', ok: true },
  ]), true);
});

test('isCensusPassComplete: a flaky DEEP page must not pin the cooldown off forever', () => {
  // The #872 regression risk: with 6 arms, "every arm ok" meant one chronically
  // failing page-3 fetch re-fired the whole census every cycle.
  assert.equal(isCensusPassComplete([
    { arm: 'primary', ok: true }, { arm: 'scoped1', ok: true },
    { arm: 'naive-p0', ok: true }, { arm: 'naive-p1', ok: true }, { arm: 'naive-p2', ok: false },
  ]), true);
});

test('isCensusPassComplete: a failed scoped arm is still incomplete', () => {
  assert.equal(isCensusPassComplete([
    { arm: 'primary', ok: false }, { arm: 'scoped1', ok: true },
    { arm: 'naive-p0', ok: true },
  ]), false);
});

test('isCensusPassComplete: naive arm failing on EVERY page is incomplete', () => {
  assert.equal(isCensusPassComplete([
    { arm: 'primary', ok: true },
    { arm: 'naive-p0', ok: false }, { arm: 'naive-p1', ok: false }, { arm: 'naive-p2', ok: false },
  ]), false);
});

test('isCensusPassComplete: scoped-only plan (naive disabled) keeps the old all-must-pass rule', () => {
  assert.equal(isCensusPassComplete([{ arm: 'primary', ok: true }]), true);
  assert.equal(isCensusPassComplete([{ arm: 'primary', ok: false }]), false);
  assert.equal(isCensusPassComplete([]), false);
});
