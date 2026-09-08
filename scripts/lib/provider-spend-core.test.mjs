import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeDayRecord, budgetBreaches, computeStreak, renderSnapshot, utcYesterday, isNextUtcDay,
  aggregateLedgerByDay,
} = require('./provider-spend-core.js');

const THRESHOLDS = {
  browserbaseDailyUsd: 4, brightdataDailyUsd: 2.5,
  scrapingbeeDailyCredits: 35000, scrapingdogDailyCredits: 45000,
};

const okReadings = {
  day: '2026-07-30',
  bb: 25,
  bd: { serp: { cost: 0.8, reqs: 500 }, unlocker: { cost: 0.6, reqs: 400 } },
  sb: { cycleUsed: 100500, cap: 1000000 },
  sd: { cycleUsed: 210000, limit: 1000000 },
};

const prevRecord = {
  day: '2026-07-29',
  providers: {
    browserbase: { status: 'ok', sessions: 30, cost: 3 },
    brightdata: { status: 'ok', cost: 1.1, serpReqs: 300, unlockerReqs: 200 },
    scrapingbee: { status: 'ok', cycleUsed: 100000 },
    scrapingdog: { status: 'ok', cycleUsed: 200000 },
  },
};

test('utcYesterday and isNextUtcDay', () => {
  assert.equal(utcYesterday(new Date('2026-07-31T06:45:00Z')), '2026-07-30');
  assert.equal(utcYesterday(new Date('2026-08-01T00:10:00Z')), '2026-07-31');
  assert.equal(isNextUtcDay('2026-07-30', '2026-07-31'), true);
  assert.equal(isNextUtcDay('2026-07-31', '2026-08-01'), true);
  assert.equal(isNextUtcDay('2026-07-28', '2026-07-30'), false);
  assert.equal(isNextUtcDay(null, '2026-07-30'), false);
});

test('computeDayRecord: deltas vs adjacent previous day, BB priced per session', () => {
  const rec = computeDayRecord({ ...okReadings, prev: prevRecord });
  assert.equal(rec.providers.browserbase.cost, 2.5);
  assert.equal(rec.providers.brightdata.cost, 1.4);
  assert.equal(rec.providers.scrapingbee.dayCredits, 500);
  assert.equal(rec.providers.scrapingdog.dayCredits, 10000);
});

test('computeDayRecord: counter reset = cycle renewal, day usage is the new counter', () => {
  const rec = computeDayRecord({ ...okReadings, sb: { cycleUsed: 1200, cap: 1000000 }, prev: prevRecord });
  assert.equal(rec.providers.scrapingbee.dayCredits, 1200);
});

test('computeDayRecord: NON-adjacent prev (cron outage gap) degrades deltas to baseline, never multi-day false breach', () => {
  const gapPrev = { ...prevRecord, day: '2026-07-27' };
  const rec = computeDayRecord({ ...okReadings, prev: gapPrev });
  assert.equal(rec.providers.scrapingbee.status, 'baseline');
  assert.equal(rec.providers.scrapingbee.dayCredits, undefined);
  assert.equal(rec.providers.browserbase.status, 'ok'); // BB/BD are per-day API reads, unaffected by gaps
});

test('computeDayRecord: null reading is unknown, missing prev is baseline', () => {
  const rec = computeDayRecord({ ...okReadings, bb: null, prev: undefined });
  assert.equal(rec.providers.browserbase.status, 'unknown');
  assert.equal(rec.providers.scrapingbee.status, 'baseline');
});

test('budgetBreaches separates overspend from unmeasured', () => {
  const rec = computeDayRecord({ ...okReadings, bb: 80, bd: null, prev: prevRecord });
  const { overspend, unmeasured } = budgetBreaches(rec, THRESHOLDS);
  assert.equal(overspend.length, 1);
  assert.match(overspend[0], /browserbase \$8 > \$4/);
  assert.deepEqual(unmeasured, ['brightdata']);
});

test('budgetBreaches: baseline day is neither overspend nor unmeasured', () => {
  const rec = computeDayRecord({ ...okReadings, prev: undefined });
  const { overspend, unmeasured } = budgetBreaches(rec, THRESHOLDS);
  assert.equal(overspend.length, 0);
  assert.equal(unmeasured.length, 0);
});

// Real consecutive UTC dates — computeStreak now requires calendar adjacency.
function greenOn(day, prevDay) {
  const prev = { ...prevRecord, day: prevDay };
  return computeDayRecord({ ...okReadings, day, prev });
}

test('computeStreak counts trailing consecutive proven-green calendar days', () => {
  const r28 = greenOn('2026-07-28', '2026-07-27');
  const r29 = greenOn('2026-07-29', '2026-07-28');
  const r30 = greenOn('2026-07-30', '2026-07-29');
  assert.equal(computeStreak([r28, r29, r30], THRESHOLDS), 3);
});

test('computeStreak: a missing calendar day (cron outage) breaks the streak', () => {
  const r27 = greenOn('2026-07-27', '2026-07-26');
  const r30 = greenOn('2026-07-30', '2026-07-29'); // 28th+29th never recorded
  assert.equal(computeStreak([r27, r30], THRESHOLDS), 1);
});

test('computeStreak: unknown or baseline day resets/blocks the streak', () => {
  const r28 = greenOn('2026-07-28', '2026-07-27');
  const unknown29 = computeDayRecord({ ...okReadings, day: '2026-07-29', bb: null, prev: { ...prevRecord, day: '2026-07-28' } });
  const r30 = greenOn('2026-07-30', '2026-07-29');
  assert.equal(computeStreak([r28, unknown29, r30], THRESHOLDS), 1);
  assert.equal(computeStreak([r28, r30.day ? { ...r30, day: '2026-07-29' } : r30, unknown29], THRESHOLDS), 0);
  const baseline = computeDayRecord({ ...okReadings, day: '2026-07-30', prev: undefined });
  assert.equal(computeStreak([baseline], THRESHOLDS), 0);
});

test('renderSnapshot: items are {title} objects (renderer drops bare strings)', () => {
  const rec = computeDayRecord({ ...okReadings, prev: prevRecord });
  const snap = renderSnapshot({
    record: rec, streak: 4,
    breaches: budgetBreaches(rec, THRESHOLDS),
    generatedAt: '2026-07-31T06:45:00Z',
  });
  assert.equal(snap.items.length, 4);
  for (const item of snap.items) {
    assert.equal(typeof item.title, 'string');
    assert.ok(item.title.length > 0);
  }
  assert.match(snap.items[0].title, /2026-07-30 · Browserbase: \$2\.5/);
  assert.match(snap.bannerText, /streak 4 of 7/);
});

test('renderSnapshot: unmeasured day never reads as green', () => {
  const rec = computeDayRecord({ ...okReadings, bd: null, prev: prevRecord });
  const snap = renderSnapshot({
    record: rec, streak: 0,
    breaches: budgetBreaches(rec, THRESHOLDS),
    generatedAt: '2026-07-31T06:45:00Z',
  });
  assert.match(snap.bannerText, /Could not measure: brightdata/);
});

// ---------- renderSnapshot: attribution coverage degrades, never suppresses (S0-T7) ----------

test('renderSnapshot: attribution line names "top callers (covers N% of billed credits)" for a credit-based provider', () => {
  const rec = computeDayRecord({ ...okReadings, prev: prevRecord });
  const snap = renderSnapshot({
    record: rec, streak: 4,
    breaches: budgetBreaches(rec, THRESHOLDS),
    generatedAt: '2026-07-31T06:45:00Z',
    attribution: {
      scrapingbee: {
        pct: 0.92, unit: 'credits', topCoveragePct: 0.6,
        top: [{ script: 'a.js', amount: 300 }, { script: 'b.js', amount: 150 }],
      },
    },
    attributionCoverageMin: 0.8,
  });
  const line = snap.items.find((i) => i.title.startsWith('ScrapingBee attribution'));
  assert.ok(line, 'expected a ScrapingBee attribution line');
  assert.match(line.title, /top callers \(covers 60% of billed credits\): a\.js 300cr, b\.js 150cr/);
});

test('renderSnapshot: below attributionCoverageMin adds a warning naming BRO-2961, does not suppress the line', () => {
  const rec = computeDayRecord({ ...okReadings, prev: prevRecord });
  const snap = renderSnapshot({
    record: rec, streak: 4,
    breaches: budgetBreaches(rec, THRESHOLDS),
    generatedAt: '2026-07-31T06:45:00Z',
    attribution: {
      scrapingbee: { pct: 0.92, unit: 'credits', topCoveragePct: 0.5, top: [{ script: 'a.js', amount: 500 }] },
    },
    attributionCoverageMin: 0.8,
  });
  assert.ok(snap.items.some((i) => i.title.startsWith('ScrapingBee attribution')), 'attribution line must still be present');
  assert.ok(snap.items.some((i) => i.title.includes('BRO-2961') && i.title.includes('coverage low')), 'warning must name BRO-2961');
});

test('renderSnapshot: at/above attributionCoverageMin adds no warning', () => {
  const rec = computeDayRecord({ ...okReadings, prev: prevRecord });
  const snap = renderSnapshot({
    record: rec, streak: 4,
    breaches: budgetBreaches(rec, THRESHOLDS),
    generatedAt: '2026-07-31T06:45:00Z',
    attribution: {
      scrapingbee: { pct: 0.92, unit: 'credits', topCoveragePct: 0.85, top: [{ script: 'a.js', amount: 850 }] },
    },
    attributionCoverageMin: 0.8,
  });
  assert.ok(!snap.items.some((i) => i.title.includes('BRO-2961')), 'no warning when coverage is healthy');
});

// ---------- aggregateLedgerByDay (S0-T6: daily aggregation for a 7-day window) ----------

test('aggregateLedgerByDay: only picks up rows for the requested day, two-day fixture', () => {
  const records = [
    { ts: '2026-09-01T01:00:00Z', provider: 'scrapingbee', workflow: 'Gather Review Data', script: 'gather-reviews.js', fn: 'page', credits: 1 },
    { ts: '2026-09-02T01:00:00Z', provider: 'scrapingbee', workflow: 'Gather Review Data', script: 'gather-reviews.js', fn: 'page', credits: 999 },
  ];
  const rows = aggregateLedgerByDay(records, '2026-09-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, '2026-09-01');
  assert.equal(rows[0].credits, 1);
});

test('aggregateLedgerByDay: same (provider,workflow,script,fn) sums credits and counts calls', () => {
  const records = [
    { ts: '2026-09-01T01:00:00Z', provider: 'scrapingbee', workflow: 'Gather Review Data', script: 'gather-reviews.js', fn: 'page', credits: 1 },
    { ts: '2026-09-01T02:00:00Z', provider: 'scrapingbee', workflow: 'Gather Review Data', script: 'gather-reviews.js', fn: 'page', credits: 1 },
  ];
  const rows = aggregateLedgerByDay(records, '2026-09-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].credits, 2);
});

test('aggregateLedgerByDay: rows differing only in fn produce separate groups', () => {
  const records = [
    { ts: '2026-09-01T01:00:00Z', provider: 'scrapingbee', workflow: null, script: 'sweep-we-aggregators.js', fn: 'render', credits: 5 },
    { ts: '2026-09-01T02:00:00Z', provider: 'scrapingbee', workflow: null, script: 'sweep-we-aggregators.js', fn: 'json', credits: 1 },
  ];
  const rows = aggregateLedgerByDay(records, '2026-09-01');
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.fn === 'render' && r.credits === 5));
  assert.ok(rows.some((r) => r.fn === 'json' && r.credits === 1));
});

test('aggregateLedgerByDay: missing/non-numeric credits count as 0, never NaN', () => {
  const records = [
    { ts: '2026-09-01T01:00:00Z', provider: 'brightdata', workflow: null, script: 'x.js', fn: 'web-unlocker', credits: null },
    { ts: '2026-09-01T02:00:00Z', provider: 'brightdata', workflow: null, script: 'x.js', fn: 'web-unlocker' },
  ];
  const rows = aggregateLedgerByDay(records, '2026-09-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].credits, 0);
  assert.ok(!Number.isNaN(rows[0].credits));
});

test('aggregateLedgerByDay: sorted by credits descending, most expensive grouping first', () => {
  const records = [
    { ts: '2026-09-01T01:00:00Z', provider: 'scrapingbee', workflow: null, script: 'cheap.js', fn: 'page', credits: 1 },
    { ts: '2026-09-01T02:00:00Z', provider: 'scrapingbee', workflow: null, script: 'expensive.js', fn: 'stealth', credits: 75 },
  ];
  const rows = aggregateLedgerByDay(records, '2026-09-01');
  assert.equal(rows[0].script, 'expensive.js');
  assert.equal(rows[1].script, 'cheap.js');
});
