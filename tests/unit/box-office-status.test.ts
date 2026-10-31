/**
 * BRO-5007: Box Office Scorecard v2 status logic, tested against the real
 * functions (CLAUDE.md §15). Runs in the tsx batch
 * (tests/unit-test-manifest-tsx.txt).
 *
 *  - classifyMultiple: one precedence order, boundaries at 0.95/1.0/1.15/2.0.
 *  - cost range width walks every costMethodology value in commercial.json.
 *  - partial preview weeks and 0-performance weeks leave the 4-week window.
 *  - the 2020-21 shutdown is a gap: never zero, never breaks a streak.
 *  - closed runs: weekly under 104 weeks, seasons (totals only) at 104+.
 *  - closing in the final weeks, too early, and no cost get no status.
 *  - the story sentence is descriptive only.
 *  - real data: a /biz At Risk show never reads Above.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  classifyMultiple,
  multipleFor,
  costHalfWidth,
  qualityForHalfWidth,
  meetsCostQualityFloor,
  makeStaticCostProvider,
  v2CostBasis,
  costSourceDate,
  statusWindowGrosses,
  buildMultipleSeries,
  currentStreak,
  computeMarketMedianByWeek,
  summarizeClosedRun,
  computeShowStatus,
  buildStory,
  multiplePhrase,
  reconcileWithAtRisk,
  countStatuses,
  COST_METHOD_HALF_WIDTH,
  DEFAULT_COST_HALF_WIDTH,
  MIN_ESTIMATE_HALF_WIDTH,
  staleInputReasons,
  MAX_GROSSES_AGE_DAYS,
  SEASON_VIEW_MIN_WEEKS,
  type CostProvider,
  type WeekRow,
  type MultiplePoint,
} from '../../src/lib/box-office-status';
import { ESTIMATED_COST_METHODS } from '../../src/lib/commercial-display';
import { getShowsAtRisk, getRunningBoxOfficeV2, getShowBoxOfficeV2, getV2CostBasis } from '../../src/lib/data-commercial';
import { pinBoxOfficeClockToData } from '../helpers/box-office-data-clock';

// Real-data tests check status shape, not wall-clock freshness (BRO-5202).
pinBoxOfficeClockToData();

const ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------- bands

/** A tight range around mid (±1%) so only the mid boundary decides. */
const tight = (mid: number) => classifyMultiple(mid * 0.99, mid, mid * 1.01);

test('classifyMultiple: boundaries at 0.95 / 1.0 / 1.15 / 2.0', () => {
  assert.equal(tight(0.94), 'below');
  assert.equal(classifyMultiple(0.94, 0.95, 0.96), 'near', '0.95 is Near');
  assert.equal(tight(1.0), 'near');
  assert.equal(classifyMultiple(1.13, 1.14, 1.15), 'near', 'just under 1.15 is Near');
  assert.equal(classifyMultiple(1.14, 1.15, 1.16), 'above', '1.15 with the range clear of 1 is Above');
  assert.equal(classifyMultiple(1.98, 1.99, 2.0), 'above');
  assert.equal(classifyMultiple(1.9, 2.0, 2.1), 'well-above', '2.0 is Well Above');
});

test('classifyMultiple: a range that includes 1.0 is Near whatever the mid', () => {
  assert.equal(classifyMultiple(0.8, 0.9, 1.0), 'near', 'hi touching 1 is not Below');
  assert.equal(classifyMultiple(1.0, 1.3, 1.6), 'near', 'lo touching 1 is not Above');
  assert.equal(classifyMultiple(0.7, 0.9, 1.1), 'near');
});

test('classifyMultiple: Below only when the whole range is under 1', () => {
  assert.equal(classifyMultiple(0.7, 0.85, 0.99), 'below');
  assert.equal(classifyMultiple(0.5, 0.6, 0.7), 'below');
});

test('multipleFor: range comes from the cost range applied to break-even', () => {
  const m = multipleFor(900_000, { cost: 800_000, breakEven: 1_000_000, low: 720_000, high: 880_000, quality: 'medium' });
  assert.ok(m);
  assert.equal(m.mid, 0.9);
  assert.ok(Math.abs(m.lo - 900_000 / 1_100_000) < 1e-9);
  assert.ok(Math.abs(m.hi - 900_000 / 900_000) < 1e-9);
  assert.equal(multipleFor(900_000, null), null);
  assert.equal(multipleFor(900_000, { cost: 0, breakEven: 0, low: 0, high: 0, quality: 'high' }), null);
});

// ---------------------------------------------------------------- cost provider

test('every costMethodology value in commercial.json maps to a range width', () => {
  const data = JSON.parse(readFileSync(path.join(ROOT, 'data/commercial.json'), 'utf8'));
  const values = new Set<string | null | undefined>(Object.values(data.shows).map((s: any) => s.costMethodology));
  assert.ok(values.size >= 3, 'expected several costMethodology values; update this test');
  for (const v of Array.from(values)) {
    if (v == null) {
      assert.equal(costHalfWidth(v, false), DEFAULT_COST_HALF_WIDTH, 'missing methodology gets the widest range');
      continue;
    }
    assert.ok(v in COST_METHOD_HALF_WIDTH, `costMethodology "${v}" has no range width in COST_METHOD_HALF_WIDTH`);
  }
  assert.equal(costHalfWidth('trade-reported', false), 0.05);
  assert.equal(costHalfWidth('sec-filing', false), 0.05);
  assert.equal(costHalfWidth('producer-confirmed', false), 0.05);
  assert.equal(costHalfWidth('reddit-standard', false), 0.15);
  assert.equal(costHalfWidth('industry-estimate', false), 0.2);
  assert.equal(costHalfWidth('deep-research', false), 0.2);
});

test('estimated cost methods never get the reported (narrowest) width', () => {
  for (const m of Array.from(ESTIMATED_COST_METHODS)) assert.ok(costHalfWidth(m, true) >= MIN_ESTIMATE_HALF_WIDTH, m);
  // An uncited or flagged "trade-reported" figure reads Estimate, so it cannot keep the 5% width.
  assert.equal(costHalfWidth('trade-reported', true), DEFAULT_COST_HALF_WIDTH);
  assert.equal(costHalfWidth('producer-confirmed', true), DEFAULT_COST_HALF_WIDTH);
});

test('v2CostBasis: floor quotes read Estimate, old sources keep Reported with estimate width', () => {
  const asOf = '2026-10-04';
  const base = { costMethodology: 'trade-reported', estimated: false, asOf };
  // Wicked: a lower bound is not a reported figure.
  const wicked = v2CostBasis({ ...base, sourceText: 'Broadway Journal (Nov 6, 2023): weekly expenses "well over $1 million"' });
  assert.deepEqual(wicked, { estimated: true, halfWidth: MIN_ESTIMATE_HALF_WIDTH, floorQuote: true, aged: true });
  for (const q of ['more than $900,000', 'over $1.2 million', 'at least $700K', 'north of $1 million', 'upwards of $800,000', 'in excess of $1M']) {
    assert.equal(v2CostBasis({ ...base, sourceText: `Variety (Jan 5, 2026): costs ${q}` }).floorQuote, true, q);
  }
  // "over" not followed by a figure is not a floor.
  assert.equal(v2CostBasis({ ...base, sourceText: 'Variety (Jan 5, 2026): averaged $643,000 a week over the year' }).floorQuote, false);
  // Hamilton: reported, 2018, so estimate width but still labeled reported.
  const ham = v2CostBasis({ ...base, sourceText: 'Broadway Journal (Apr 25, 2018): fixed expenses averaged $643,000 a week' });
  assert.deepEqual(ham, { estimated: false, halfWidth: MIN_ESTIMATE_HALF_WIDTH, floorQuote: false, aged: true });
  // A recent exact figure keeps the method's width; 24 months exactly is not yet aged.
  assert.equal(v2CostBasis({ ...base, sourceText: 'Forbes (Nov 17, 2025): $480,577 a week' }).halfWidth, 0.05);
  assert.equal(v2CostBasis({ ...base, sourceText: 'Forbes (Oct 4, 2024): $480,577 a week' }).aged, false);
  assert.equal(v2CostBasis({ ...base, sourceText: 'Forbes (Oct 3, 2024): $480,577 a week' }).aged, true);
  // No source or an estimate flag: estimate rules unchanged.
  assert.deepEqual(v2CostBasis({ ...base, sourceText: null }), { estimated: true, halfWidth: DEFAULT_COST_HALF_WIDTH, floorQuote: false, aged: false });
  assert.equal(costSourceDate('Gordon Cox interview with producer (June 4, 2024): more than $900,000'), '2024-06-04');
  assert.equal(costSourceDate('Variety: no date'), null);
  assert.equal(costSourceDate('Reddit r/Broadway (2026-06-30): ~$700K'), '2026-06-30', 'ISO dates age too');
  // Harry Potter: exceeding is a floor too.
  assert.equal(v2CostBasis({ ...base, sourceText: 'Broadway Journal (Dec 16, 2025): weekly operating expenses exceeding $1 million' }).estimated, true);
  assert.equal(v2CostBasis({ ...base, sourceText: 'Variety (Jan 5, 2026): it turned over $2 million in sales' }).floorQuote, false);
});

test('static provider: no break-even means no cost; quality follows width', () => {
  const p = makeStaticCostProvider((id) =>
    ({ a: { breakEven: 500_000, halfWidth: 0.05 }, b: { breakEven: null, halfWidth: 0.2 }, c: { breakEven: 400_000, halfWidth: 0.15 } } as Record<string, any>)[id]);
  assert.equal(p('b', '2026-01-04'), null);
  assert.equal(p('zzz', '2026-01-04'), null);
  const a = p('a', '2026-01-04');
  assert.equal(a?.quality, 'high');
  assert.equal(a?.low, 475_000);
  assert.equal(p('c', '2026-01-04')?.quality, 'medium');
  assert.equal(qualityForHalfWidth(0.2), 'low');
  assert.equal(meetsCostQualityFloor('low'), true);
  assert.equal(meetsCostQualityFloor('estimated'), false, 'a category guess is below the floor');
  assert.equal(meetsCostQualityFloor(null), false);
});

// ---------------------------------------------------------------- weeks

/** Sunday week endings, newest first, ending at `latest`. */
function weekKeys(latest: string, n: number): string[] {
  const t = Date.parse(latest);
  return Array.from({ length: n }, (_, i) => new Date(t - i * 7 * 86_400_000).toISOString().slice(0, 10));
}
function rows(latest: string, grosses: Array<number | null>, perfs?: Array<number | null>): WeekRow[] {
  return weekKeys(latest, grosses.length).map((week, i) => ({
    week,
    gross: grosses[i],
    performances: perfs ? perfs[i] : grosses[i] == null ? null : 8,
    attendance: grosses[i] == null ? null : 7000,
    seatsOffered: grosses[i] == null ? null : 8000,
  }));
}
const flatCost = (be: number, hw = 0.05): CostProvider => () => ({ cost: be, breakEven: be, low: be * (1 - hw), high: be * (1 + hw), quality: qualityForHalfWidth(hw) });

test('statusWindowGrosses: partial preview weeks and dark weeks leave the window', () => {
  // newest first: wk4 (8 perfs), wk3 (8), wk2 (8), wk1 preview with 5 perfs
  const r = rows('2026-09-27', [800, 810, 820, 300], [8, 8, 8, 5]);
  assert.deepEqual(statusWindowGrosses(r), [800, 810, 820, null]);
  // a later 7-show week (a play's schedule) counts
  const later = rows('2026-09-27', [700, 800, 800, 800, 800, 800], [7, 8, 8, 8, 8, 8]);
  assert.deepEqual(statusWindowGrosses(later), [700, 800, 800, 800]);
  // a 0-gross week is dark and leaves the window
  const dark = rows('2026-09-27', [800, 0, 800, 800, 800], [8, 0, 8, 8, 8]);
  assert.deepEqual(statusWindowGrosses(dark), [800, null, 800, 800]);
  // BRO-5057: a gross listed with 0 performances is a played week (the count was lost);
  // among the run's first 4 weeks it is a partial preview week, later it counts
  const preview = rows('2026-09-27', [800, 810, 820, 600], [8, 8, 8, 0]);
  assert.deepEqual(statusWindowGrosses(preview), [800, 810, 820, null]);
  // a 0 count past the first 4 weeks (a long preview period) is still unknown, so it leaves the window
  const longPreviews = rows('2026-09-27', [800, 790, 700, 650, 600, 550], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(statusWindowGrosses(longPreviews), [null, null, null, null]);
  const lostCount = rows('2026-09-27', [800, 790, 800, 800, 800, 800, 800, 800], [8, 0, 8, 8, 8, 8, 8, 8]);
  assert.deepEqual(statusWindowGrosses(lostCount), [800, null, 800, 800]);
});

test('shutdown weeks are a gap: never zero, never break a streak', () => {
  const series: MultiplePoint[] = [
    { week: '2021-10-10', gross: 1, multiple: 1.2, market: null },
    { week: '2021-10-03', gross: 1, multiple: 1.3, market: null },
    { week: '2020-12-06', gross: null, multiple: null, market: null }, // shutdown
    { week: '2020-03-08', gross: 1, multiple: 1.1, market: null },
    { week: '2020-03-01', gross: 1, multiple: 0.9, market: null },
  ];
  assert.deepEqual(currentStreak(series), { side: 'above', weeks: 3, atLeast: false });
  const built = buildMultipleSeries('x', [{ week: '2020-12-06', gross: 50_000, performances: 8 }], flatCost(100_000), null);
  assert.equal(built[0].gross, null, 'a shutdown week is drawn as a gap');
  assert.equal(built[0].multiple, null);
});

test('currentStreak: capped look-back reports "at least"', () => {
  const series: MultiplePoint[] = weekKeys('2026-09-27', 60).map((week) => ({ week, gross: 1, multiple: 1.5, market: 1.1 }));
  assert.deepEqual(currentStreak(series, 52), { side: 'above', weeks: 52, atLeast: true });
  const short = series.slice(0, 30);
  assert.deepEqual(currentStreak(short, 52), { side: 'above', weeks: 30, atLeast: false });
  const flip = series.map((p, i) => (i === 3 ? { ...p, multiple: 0.8 } : p));
  assert.deepEqual(currentStreak(flip, 52), { side: 'above', weeks: 3, atLeast: false });
});

test('market median excludes nonprofits and shows below the cost floor', () => {
  const latest = '2026-09-27';
  const cost: CostProvider = (id) => (id === 'guess' ? { cost: 1, breakEven: 1, low: 1, high: 1, quality: 'estimated' } : flatCost(100)(id, latest));
  const med = computeMarketMedianByWeek([
    { showId: 'a', nonprofit: false, weeks: rows(latest, [100]) },
    { showId: 'b', nonprofit: false, weeks: rows(latest, [300]) },
    { showId: 'np', nonprofit: true, weeks: rows(latest, [5000]) },
    { showId: 'guess', nonprofit: false, weeks: rows(latest, [9999]) },
  ], cost);
  assert.equal(med.get(latest), 2);
});

// ---------------------------------------------------------------- closed runs

test('summarizeClosedRun: weekly under 104 weeks, seasons with totals only at 104+', () => {
  const short = buildMultipleSeries('x', rows('2026-09-20', [1200, 900, 900, 900]), flatCost(1000), null);
  const s = summarizeClosedRun(short);
  assert.equal(s.granularity, 'weekly');
  assert.equal(s.weeksBelow, 3);
  assert.equal(s.weeksAbove, 1);
  assert.equal(s.series[0].week < s.series[3].week, true, 'oldest first');

  const long = buildMultipleSeries('x', rows('2026-09-20', Array(SEASON_VIEW_MIN_WEEKS).fill(1000)), flatCost(500), null);
  const l = summarizeClosedRun(long);
  assert.equal(l.granularity, 'season');
  assert.equal(l.weeksWithCost, 0, 'no multiples until era costs exist');
  assert.equal(l.series.length, 0);
  assert.equal(l.seasons.reduce((a, x) => a + x.weeks, 0), SEASON_VIEW_MIN_WEEKS);
  assert.ok(l.seasons.every((x) => /^\d{4}-\d{4}$/.test(x.season)), 'July-June seasons');
});

test('summarizeClosedRun: shutdown weeks are not counted as zero-gross weeks', () => {
  const r: WeekRow[] = [
    { week: '2021-10-10', gross: 900, performances: 8 },
    { week: '2020-12-06', gross: 0, performances: 0 },
    { week: '2020-03-08', gross: 1100, performances: 8 },
  ];
  const s = summarizeClosedRun(buildMultipleSeries('x', r, flatCost(1000), null));
  assert.equal(s.weeksReported, 2);
  assert.equal(s.totalGross, 2000);
});

// ---------------------------------------------------------------- one show

const base = {
  showId: 'x', nonprofit: false, cost: flatCost(1_000_000), marketMedianByWeek: null, latestWeek: '2026-09-27',
};

test('computeShowStatus: ok with band, cover costs and a story', () => {
  const s = computeShowStatus({ ...base, status: 'open', weeks: rows('2026-09-27', Array(10).fill(800_000)) });
  assert.equal(s.availability, 'ok');
  assert.equal(s.band, 'below');
  assert.equal(s.cover?.shortBy, 200_000);
  assert.ok(s.cover?.ticketNeeded && Math.abs(s.cover.ticketNeeded - 1_000_000 / 7000) < 1e-6);
  assert.ok(s.cover?.capacityNeeded && s.cover.capacityNeeded > 100, 'needs more than full at today\'s prices');
  assert.match(s.story ?? '', /about 20% less than it needs to break even\./);
  assert.equal(s.series.length, 10);
});

test('computeShowStatus: closed, closing, early, nocost get no status chip', () => {
  const w = rows('2026-09-27', Array(10).fill(1_500_000));
  assert.equal(computeShowStatus({ ...base, status: 'closed', weeks: w }).availability, 'closed');
  const closing = computeShowStatus({ ...base, status: 'open', closingDate: '2026-10-18', weeks: w });
  assert.equal(closing.availability, 'closing');
  assert.equal(closing.band, null);
  assert.equal(closing.story, null);
  assert.equal(computeShowStatus({ ...base, status: 'open', closingDate: '2027-01-03', weeks: w }).availability, 'ok',
    'a closing months away is not the final weeks');
  assert.equal(computeShowStatus({ ...base, status: 'previews', weeks: rows('2026-09-27', [1, 1, 1]) }).availability, 'early');
  const nocost = computeShowStatus({ ...base, status: 'open', cost: () => null, weeks: w });
  assert.equal(nocost.availability, 'nocost');
  assert.equal(nocost.story, null);
  assert.equal(nocost.breakEven, null);
  assert.deepEqual(countStatuses([nocost, closing, { availability: 'ok', band: 'near' }]), { nocost: 1, closing: 1, 'ok:near': 1 });
});

test('story is descriptive: no causal claims', () => {
  const market = new Map(weekKeys('2026-09-27', 30).map((w) => [w, 1.2]));
  const s = computeShowStatus({ ...base, status: 'open', marketMedianByWeek: market, weeks: rows('2026-09-27', Array(30).fill(700_000)) });
  assert.match(s.story ?? '', /The typical Broadway show was at or above break-even in 30 of those 30 weeks\./);
  assert.doesNotMatch(s.story ?? '', /\bbecause\b|\bslump\b|\bthe season's\b|\bthis show's\b|\bdue to\b/i);
  assert.equal(buildStory({ availability: 'early', band: null, multiple: null, streak: null, series: [] }), null);
});

test('story wording follows the multiple, not the band', () => {
  assert.equal(multiplePhrase(0.86), 'about 14% less than it needs to break even', 'MHE: Near band, but the number is under cost');
  assert.equal(multiplePhrase(0.95), 'close to what it needs to break even');
  assert.equal(multiplePhrase(1.05), 'close to what it needs to break even');
  assert.equal(multiplePhrase(1.32), 'about 32% more than it needs to break even');
  assert.equal(multiplePhrase(2.4), 'more than double what it needs to break even');
  assert.equal(multiplePhrase(1.99), 'about double what it needs to break even', 'not about 99% more');
  assert.equal(multiplePhrase(2.0), 'about double what it needs to break even', 'exactly 2x is not more than double');
  // Real data: a story never says close to cost while the midpoint is outside 0.95-1.05.
  for (const r of getRunningBoxOfficeV2()) {
    if (!r.story || !r.multiple) continue;
    const close = /close to what it needs to break even/.test(r.story);
    assert.equal(close, r.multiple.mid >= 0.95 && r.multiple.mid <= 1.05, `${r.slug}: ${r.multiple.mid.toFixed(2)} "${r.story}"`);
  }
});

test('reconcileWithAtRisk caps an At Risk show at Near', () => {
  assert.equal(reconcileWithAtRisk('above', true), 'near');
  assert.equal(reconcileWithAtRisk('well-above', true), 'near');
  assert.equal(reconcileWithAtRisk('below', true), 'below');
  assert.equal(reconcileWithAtRisk('above', false), 'above');
});

// ---------------------------------------------------------------- real data

test('real data: every /biz At Risk show reads Below or Near', () => {
  const byslug = new Map(getRunningBoxOfficeV2().map((s) => [s.slug, s]));
  for (const r of getShowsAtRisk()) {
    const s = byslug.get(r.slug);
    if (!s || s.availability !== 'ok') continue;
    assert.ok(s.band === 'below' || s.band === 'near', `${r.slug} is At Risk on /biz but ${s.band} here`);
  }
});

test('real data: running shows get a status or a stated reason, never a reason-less blank', () => {
  const all = getRunningBoxOfficeV2();
  assert.ok(all.length >= 10, `expected 10+ running Broadway shows, got ${all.length}`);
  for (const s of all) {
    if (s.availability === 'ok') {
      assert.ok(s.band && s.multiple && s.breakEven, `${s.slug} ok without band/multiple/break-even`);
      assert.ok(s.costBasis, `${s.slug} has no cost basis`);
    } else {
      assert.equal(s.band, null, `${s.slug} ${s.availability} still has a band`);
      assert.equal(s.story, null, `${s.slug} ${s.availability} still has a story`);
    }
    // the source line must never print internal research language
    assert.doesNotMatch(s.costSourceText ?? '', /reddit|industry[\s-]*estimate|deep[\s-]*research|gpt/i, s.slug);
  }
});

test('real data: a closed show with a short run gets a weekly whole-run summary', () => {
  const t = getShowBoxOfficeV2('titanique');
  if (!t) return; // record removed: nothing to check
  assert.equal(t.availability, 'closed');
  assert.equal(t.closedRun?.granularity, 'weekly');
  assert.ok((t.closedRun?.weeksWithCost ?? 0) > 0);
});

// ---------------------------------------------------------------- label and width agree

test('real data: the Reported/Estimate label and the range width come from one flag', () => {
  const rows = getRunningBoxOfficeV2().filter((r) => r.multiple && r.costBasis);
  assert.ok(rows.length >= 10, 'expected statuses for most running shows');
  const shows = JSON.parse(readFileSync(path.join(ROOT, 'data/commercial.json'), 'utf8')).shows;
  const asOf = rows.flatMap((r) => r.series.map((p) => p.week)).sort().at(-1)!;
  for (const r of rows) {
    const hw = r.multiple!.mid / r.multiple!.lo - 1;
    const basis = getV2CostBasis(shows[r.slug], asOf);
    // Aging needs a date: an unparseable source date would keep an old figure narrow forever.
    if (r.costBasis === 'reported') assert.ok(costSourceDate(r.costSourceText ?? ''), `${r.slug}: reported source has no parseable date: "${r.costSourceText}"`);
    assert.equal(r.costBasis === 'estimate', basis.estimated, `${r.slug}: label and helper disagree`);
    assert.ok(Math.abs(hw - basis.halfWidth) < 1e-6, `${r.slug}: range ±${hw.toFixed(3)} but helper says ±${basis.halfWidth}`);
    // A source older than 24 months keeps Reported but never the narrow width.
    if (r.costBasis === 'reported') assert.ok(hw <= (basis.aged ? MIN_ESTIMATE_HALF_WIDTH : 0.05) + 1e-6, `${r.slug}: Reported but range ±${hw.toFixed(3)}`);
    else assert.ok(hw >= MIN_ESTIMATE_HALF_WIDTH - 1e-6, `${r.slug}: Estimate but range only ±${hw.toFixed(3)}`);
  }
});

// ---------------------------------------------------------------- stale inputs

const fresh = { historyNewestWeek: '2026-10-04', grossesWeekEnding: '10/4/2026', commercialUpdated: '2026-10-10T19:15:08Z', today: '2026-10-10' };

test('staleInputReasons: current inputs are fresh', () => {
  assert.deepEqual(staleInputReasons(fresh), []);
  assert.deepEqual(staleInputReasons({ ...fresh, today: '2026-10-14' }), [], 'Wednesday before the retry is still fresh');
});

test('staleInputReasons: the Phase 1 inputs (newest week 2026-09-27 on 10-10) are stale', () => {
  const r = staleInputReasons({ historyNewestWeek: '2026-09-27', grossesWeekEnding: '9/27/2026', commercialUpdated: '2026-10-05T00:00:00Z', today: '2026-10-10' });
  assert.equal(r.length, 1);
  assert.match(r[0], /13 days old/);
  assert.equal(staleInputReasons({ ...fresh, today: '2026-10-15' }).length, 1, `${MAX_GROSSES_AGE_DAYS + 1} days is stale`);
});

test('staleInputReasons: mismatched grosses files and old commercial data are stale', () => {
  assert.match(staleInputReasons({ ...fresh, grossesWeekEnding: '9/27/2026' })[0], /does not match/);
  assert.match(staleInputReasons({ ...fresh, commercialUpdated: '2026-09-01T00:00:00Z' })[0], /commercial\.json updated 2026-09-01/);
  assert.match(staleInputReasons({ ...fresh, commercialUpdated: null })[0], /no _meta\.lastUpdated/);
  assert.deepEqual(staleInputReasons({ ...fresh, historyNewestWeek: null }), ['grosses-history.json has no weeks']);
});
