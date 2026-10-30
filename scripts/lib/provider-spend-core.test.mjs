import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeDayRecord, budgetBreaches, computeStreak, renderSnapshot, utcYesterday, isNextUtcDay,
  aggregateLedgerByDay, bbCost,
  ledgerFreshnessHours, lastLedgerDay,
} = require('./provider-spend-core.js');

const THRESHOLDS = {
  browserbaseDailyUsd: 4, brightdataDailyUsd: 2.5,
  scrapingbeeDailyCredits: 35000, scrapingdogDailyCredits: 45000,
};

const okReadings = {
  day: '2026-07-30',
  bb: { sessions: 25, minutes: 30 },
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

test('computeDayRecord: deltas vs adjacent previous day, BB priced per browser-minute (amortized base + measured overage)', () => {
  const rec = computeDayRecord({ ...okReadings, prev: prevRecord });
  assert.equal(rec.providers.browserbase.cost, 0.73); // 0.67 base + (30/60)*0.12 overage
  assert.equal(rec.providers.browserbase.sessions, 25);
  assert.equal(rec.providers.browserbase.minutes, 30);
  assert.equal(rec.providers.brightdata.cost, 1.4);
  assert.equal(rec.providers.scrapingbee.dayCredits, 500);
  assert.equal(rec.providers.scrapingdog.dayCredits, 10000);
});

test('bbCost: a heavy-session, low-duration day stays near the amortized baseline, not driven by session count', () => {
  // Real-world shape (BRO-3240): 92 sessions in 19.2 minutes — session COUNT
  // is high but real browser-time is tiny. The old per-session model would
  // have priced this at 92 * $0.10 = $9.20; the fix must not reproduce that.
  const { cost, costBase, costOverage } = bbCost({ sessions: 92, minutes: 19.2 });
  assert.equal(costBase, 0.67);
  assert.ok(costOverage < 0.05, `overage should be near-zero for 19.2 real minutes, got ${costOverage}`);
  assert.ok(cost < 1, `total cost should stay near the flat baseline, got ${cost}`);
});

test('bbCost: a genuine multi-hour burst still crosses a real dollar figure (alarm stays reachable)', () => {
  const { cost } = bbCost({ sessions: 80, minutes: 2000 }); // 33.3 browser-hours in one day
  assert.equal(cost, 4.67);
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
  const rec = computeDayRecord({ ...okReadings, bb: { sessions: 80, minutes: 2000 }, bd: null, prev: prevRecord });
  const { overspend, unmeasured } = budgetBreaches(rec, THRESHOLDS);
  assert.equal(overspend.length, 1);
  assert.match(overspend[0], /browserbase \$4\.67 > \$4 \(80 sessions, 2000min\)/);
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
  assert.match(snap.items[0].title, /2026-07-30 · Browserbase: \$0\.73/);
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

// ---------- aggregateLedgerByDay host/category split (BRO-3097) ----------

test('aggregateLedgerByDay: browserbase rows with the same script/fn but different host stay separate rows', () => {
  const records = [
    { ts: '2026-09-01T01:00:00Z', provider: 'browserbase', workflow: null, script: 'collect-review-texts.js', fn: 'session', host: 'nytimes.com', category: 'review-text', credits: 0 },
    { ts: '2026-09-01T02:00:00Z', provider: 'browserbase', workflow: null, script: 'collect-review-texts.js', fn: 'session', host: 'wsj.com', category: 'review-text', credits: 0 },
  ];
  const rows = aggregateLedgerByDay(records, '2026-09-01');
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.host === 'nytimes.com' && r.calls === 1));
  assert.ok(rows.some((r) => r.host === 'wsj.com' && r.calls === 1));
});

test('aggregateLedgerByDay: browserbase rows with the same host/category merge and sum calls', () => {
  const records = [
    { ts: '2026-09-01T01:00:00Z', provider: 'browserbase', workflow: null, script: 'bww-rr-discover.js', fn: 'session', host: 'broadwayworld.com', category: 'discovery', credits: 0 },
    { ts: '2026-09-01T02:00:00Z', provider: 'browserbase', workflow: null, script: 'bww-rr-discover.js', fn: 'session', host: 'broadwayworld.com', category: 'discovery', credits: 0 },
  ];
  const rows = aggregateLedgerByDay(records, '2026-09-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].host, 'broadwayworld.com');
  assert.equal(rows[0].category, 'discovery');
});

test('aggregateLedgerByDay: non-browserbase rows ignore `host` in the grouping key — different hosts still merge, output host is null', () => {
  const records = [
    { ts: '2026-09-01T01:00:00Z', provider: 'scrapingbee', workflow: null, script: 'gather-reviews.js', fn: 'page', host: 'nytimes.com', credits: 1 },
    { ts: '2026-09-01T02:00:00Z', provider: 'scrapingbee', workflow: null, script: 'gather-reviews.js', fn: 'page', host: 'vulture.com', credits: 1 },
  ];
  const rows = aggregateLedgerByDay(records, '2026-09-01');
  assert.equal(rows.length, 1, 'host must not fragment the aggregate for non-HOST_DIMENSION_PROVIDERS');
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].host, null);
});

test('aggregateLedgerByDay: category is null for providers that never set it', () => {
  const records = [
    { ts: '2026-09-01T01:00:00Z', provider: 'brightdata', workflow: null, script: 'x.js', fn: 'web-unlocker', credits: 1 },
  ];
  const rows = aggregateLedgerByDay(records, '2026-09-01');
  assert.equal(rows[0].category, null);
});

// --- BRO-3349: freshness helpers moved here from check-provider-spend.js ---

test('ledgerFreshnessHours: a shape-valid but UNREAL day is dropped, never propagated as NaN', () => {
  // "2026-99-99" matches /^\d{4}-\d{2}-\d{2}$/ but is Invalid Date. The old
  // lexical-max-then-convert order let it outrank every real day and return
  // NaN, which callers read as "no usable data" (WARN) instead of staleness —
  // one garbage row silenced the dead-man permanently (ship-check/Codex P1).
  const now = new Date('2026-09-25T00:00:00Z');
  const hours = ledgerFreshnessHours([{ day: '2026-09-19' }, { day: '2026-99-99' }], now);
  assert.ok(Number.isFinite(hours), `expected a finite age, got ${hours}`);
  assert.ok(Math.abs(hours - 120) < 0.01, `expected ~120h from 2026-09-19's end-of-day, got ${hours}`);
});

test('ledgerFreshnessHours: an entirely unreal ledger is Infinity (maximally stale), not NaN', () => {
  const hours = ledgerFreshnessHours([{ day: '2026-99-99' }, { day: 'zzz' }, { day: null }], new Date());
  assert.equal(hours, Infinity);
});

test('lastLedgerDay: reports the newest REAL day, ignoring unreal and malformed ones', () => {
  assert.equal(lastLedgerDay([{ day: '2026-09-17' }, { day: '2026-99-99' }, { day: '2026-09-19' }]), '2026-09-19');
  assert.equal(lastLedgerDay([{ day: '2026-99-99' }]), null);
  assert.equal(lastLedgerDay([]), null);
  assert.equal(lastLedgerDay(null), null);
});

test('lastLedgerDay agrees with ledgerFreshnessHours about which day is newest', () => {
  const records = [{ day: '2026-09-17' }, { day: '2026-99-99' }, { day: '2026-09-19' }];
  const now = new Date('2026-09-21T13:25:11.107Z');
  const day = lastLedgerDay(records);
  assert.equal(ledgerFreshnessHours(records, now), ledgerFreshnessHours([{ day }], now));
});

test('attributionGaps (BRO-4215): flags a provider under min on every one of the last N consecutive days', () => {
  const { attributionGaps } = require('./provider-spend-core.js');
  const opts = { min: 0.8, days: 2, providers: ['scrapingbee', 'scrapingdog', 'brightdata'] };
  const series = [
    { day: '2026-09-25', attributedPct: { scrapingbee: 0.19, scrapingdog: 0.9, brightdata: 0.5 } },
    { day: '2026-09-26', attributedPct: { scrapingbee: 0.13, scrapingdog: 0.95, brightdata: 0.85 } },
    { day: '2026-09-27', attributedPct: { scrapingbee: 0.17, scrapingdog: 0.4, brightdata: 0.6 } },
  ];
  assert.deepEqual(attributionGaps(series, opts), [{ provider: 'scrapingbee', pcts: [0.13, 0.17] }],
    'scrapingdog/brightdata dipped for only one of the two days');
  // A null (unmeasured) day breaks the run.
  const withNull = [series[0], { ...series[1], attributedPct: { scrapingbee: null } }, series[2]];
  assert.deepEqual(attributionGaps(withNull, opts), []);
  // A calendar gap between the last two records breaks the run.
  assert.deepEqual(attributionGaps([series[0], series[2]], opts), []);
  // Not enough history.
  assert.deepEqual(attributionGaps([series[2]], opts), []);
  // Providers not listed are never flagged.
  assert.deepEqual(attributionGaps(series, { ...opts, providers: ['browserbase'] }), []);
});

test('attributionWindowVerdict (BRO-4215): the whole alert window must be clear; shared by resolve + VERIFY', () => {
  const { attributionWindowVerdict } = require('./provider-spend-core.js');
  const rec = (day, p) => ({ day, attributedPct: { scrapingdog: p } });
  const two = { min: 0.8, days: 2 };
  assert.equal(attributionWindowVerdict([rec('2026-09-27', 0.43), rec('2026-09-28', 0.91)], 'scrapingdog', two).verdict, 'open', 'one good day does not close it');
  assert.equal(attributionWindowVerdict([rec('2026-09-27', 0.85), rec('2026-09-28', 0.91)], 'scrapingdog', two).verdict, 'clear');
  assert.equal(attributionWindowVerdict([rec('2026-09-27', 0.8), rec('2026-09-28', 0.8)], 'scrapingdog', two).verdict, 'clear', 'exactly min counts as clear');
  assert.equal(attributionWindowVerdict([rec('2026-09-26', 0.85), rec('2026-09-28', 0.91)], 'scrapingdog', two).verdict, 'unverifiable', 'non-consecutive');
  assert.equal(attributionWindowVerdict([rec('2026-09-26', 0.40), rec('2026-09-28', 0.91)], 'scrapingdog', two).verdict, 'unverifiable', 'gap checked before under-min');
  assert.equal(attributionWindowVerdict([rec('2026-09-28', 0.91)], 'scrapingdog', two).verdict, 'unverifiable', 'too little history');
  assert.equal(attributionWindowVerdict([rec('2026-09-27', null), rec('2026-09-28', 0.91)], 'scrapingdog', two).verdict, 'unverifiable', 'unmeasured day');
  assert.equal(attributionWindowVerdict([rec('2026-09-28', 0.91), rec('2026-09-27', 0.85)], 'scrapingdog', two).verdict, 'clear', 'order irrelevant');
  const three = { min: 0.8, days: 3 };
  assert.equal(attributionWindowVerdict([rec('2026-09-26', 0.5), rec('2026-09-27', 0.9), rec('2026-09-28', 0.9)], 'scrapingdog', three).verdict, 'open', 'days=3 window');
  assert.equal(attributionWindowVerdict([rec('2026-09-26', 0.9), rec('2026-09-27', 0.9), rec('2026-09-28', 0.9)], 'scrapingdog', three).verdict, 'clear');
});

test('renderSnapshot: a boosted day names the bulk ceiling and the Tier-1 boost (BRO-5261)', () => {
  const base = computeDayRecord({ ...okReadings, prev: prevRecord });
  const at = (day, sessions) => {
    const record = { ...base, day, providers: { ...base.providers, browserbase: { ...base.providers.browserbase, status: 'ok', sessions } } };
    const snap = renderSnapshot({ record, streak: 0, breaches: budgetBreaches(record, THRESHOLDS), generatedAt: `${day}T06:45:00Z`, maxSessionsPerDay: 250 });
    return (snap.items.find((i) => /CAP EXHAUSTED/.test(i.title)) || {}).title || '';
  };
  assert.match(at('2026-10-20', 260), /260\/250 sessions \(bulk ceiling; Tier-1 boost to 350 active\)/);
  assert.match(at('2026-10-20', 350), /also exhausted/);
  assert.doesNotMatch(at('2026-11-02', 260), /boost/, 'no note once the boost has expired');
  assert.match(at('2026-11-02', 260), /CAP EXHAUSTED: 260\/250 sessions —/);
});

test('BRO-3023: cycleDelta only attributes a day when the two samples are ~24h apart', () => {
  const prev = { ...prevRecord, providers: { ...prevRecord.providers,
    scrapingbee: { status: 'ok', cycleUsed: 100000, readAt: '2026-07-30T06:45:00Z' },
    scrapingdog: { status: 'ok', cycleUsed: 200000, readAt: '2026-07-30T06:45:00Z' } } };
  const onTime = computeDayRecord({ ...okReadings, prev, readAt: '2026-07-31T06:50:00Z' });
  assert.equal(onTime.providers.scrapingbee.dayCredits, 500);
  const retimed = computeDayRecord({ ...okReadings, prev, readAt: '2026-07-31T00:10:00Z' }); // 17h25m gap
  assert.equal(retimed.providers.scrapingbee.status, 'ok'); // not hidden: no skipped breach, streak intact
  assert.equal(retimed.providers.scrapingbee.retimed, true);
  assert.equal(retimed.providers.scrapingbee.dayCredits, Math.round(500 * 24 / (17 + 25 / 60)));
  assert.equal(onTime.providers.scrapingbee.retimed, undefined);
});

test('BRO-3023: records without readAt keep the legacy calendar-day behaviour', () => {
  const rec = computeDayRecord({ ...okReadings, prev: prevRecord, readAt: '2026-07-31T00:10:00Z' });
  assert.equal(rec.providers.scrapingbee.dayCredits, 500);
  const legacy = computeDayRecord({ ...okReadings, prev: prevRecord });
  assert.equal(legacy.providers.scrapingbee.readAt, undefined);
});

// BRO-6646: prepaid packs alarm on exhaustion pace, not on one busy day.
{
  const TH = { browserbaseDailyUsd: 4, brightdataDailyUsd: 6, scrapingbeeDailyCredits: 35000, scrapingdogDailyCredits: 100000 };
  const okOthers = { browserbase: { status: 'ok', cost: 0.8, sessions: 1, minutes: 1 }, brightdata: { status: 'ok', cost: 4, serpReqs: 1, unlockerReqs: 1 } };
  const rec = (day, sb, sd) => ({ day, providers: { ...okOthers, scrapingbee: { status: 'ok', ...sb }, scrapingdog: { status: 'ok', ...sd } } });
  const sbFine = { dayCredits: 20000, cycleUsed: 500000, cap: 1000000, renewalDate: '2026-11-04', readAt: '2026-10-30T08:43:00Z' };

  test('ScrapingDog backfill days (2026-10-27..29 ledger) do not breach: the pack has 2.2M left', () => {
    const hist = [['2026-10-23', 73728], ['2026-10-24', 189274], ['2026-10-25', 14980], ['2026-10-26', 129750], ['2026-10-27', 205072], ['2026-10-28', 186988]]
      .map(([d, c]) => rec(d, sbFine, { dayCredits: c, cycleUsed: 2000000, cap: 4577555 }));
    const today = rec('2026-10-29', sbFine, { dayCredits: 152554, cycleUsed: 2342694, cap: 4577555, renewalDate: '2026-11-01', readAt: '2026-10-30T08:43:00Z' });
    assert.deepStrictEqual(budgetBreaches(today, TH, hist).overspend, []);
    // Without the pace inputs the old 100K line still applies.
    const legacy = rec('2026-10-29', sbFine, { dayCredits: 152554, cycleUsed: 2342694, cap: 4577555 });
    assert.match(budgetBreaches(legacy, TH, hist).overspend.join(), /scrapingdog 152554 credits > 100000/);
  });

  test('ScrapingBee run-out (2026-09-29..10-01 ledger) breaches on pace', () => {
    const hist = [['2026-09-29', 41581], ['2026-09-30', 39824]].map(([d, c]) => rec(d, { dayCredits: c, cycleUsed: 800000, cap: 1000000 }, { dayCredits: 1, cycleUsed: 1, cap: 10 }));
    const today = rec('2026-10-01', { dayCredits: 80595, cycleUsed: 903990, cap: 1000000, renewalDate: '2026-10-05', readAt: '2026-10-02T08:00:00Z' }, { dayCredits: 1, cycleUsed: 1, cap: 10 });
    assert.match(budgetBreaches(today, TH, hist).overspend.join(), /scrapingbee on pace to run out before renewal/);
  });

  test('one spike under a quiet 7-day average does not breach', () => {
    const hist = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
      .map((d) => rec(d, { dayCredits: 15000, cycleUsed: 100000, cap: 1000000 }, { dayCredits: 1, cycleUsed: 1, cap: 10 }));
    const today = rec('2026-10-09', { dayCredits: 60000, cycleUsed: 200000, cap: 1000000, renewalDate: '2026-11-04', readAt: '2026-10-10T08:00:00Z' }, { dayCredits: 1, cycleUsed: 1, cap: 10 });
    assert.deepStrictEqual(budgetBreaches(today, TH, hist).overspend, []);
  });

  test('an empty pack breaches even on a zero-credit day', () => {
    const today = rec('2026-10-04', { dayCredits: 0, cycleUsed: 1000000, cap: 1000000, renewalDate: '2026-10-05' }, { dayCredits: 1, cycleUsed: 1, cap: 10 });
    assert.match(budgetBreaches(today, TH, []).overspend.join(), /scrapingbee pack exhausted/);
  });

  test('an expired or far-off renewal falls back to the daily line', () => {
    for (const renewalDate of ['2026-10-01', '2027-06-01', null]) {
      const today = rec('2026-10-09', { dayCredits: 60000, cycleUsed: 200000, cap: 1000000, renewalDate, readAt: '2026-10-10T08:00:00Z' }, { dayCredits: 1, cycleUsed: 1, cap: 10 });
      assert.match(budgetBreaches(today, TH, []).overspend.join(), /scrapingbee 60000 credits > 35000/);
    }
  });

  test('Bright Data: one busy day under a normal week does not breach; a sustained rise does', () => {
    const sd = { dayCredits: 1, cycleUsed: 1, cap: 10 };
    const week = (cost) => ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'].map((d) => ({ ...rec(d, sbFine, sd), providers: { ...rec(d, sbFine, sd).providers, brightdata: { status: 'ok', cost, serpReqs: 1, unlockerReqs: 1 } } }));
    const today = { ...rec('2026-10-28', sbFine, sd), providers: { ...rec('2026-10-28', sbFine, sd).providers, brightdata: { status: 'ok', cost: 7.64, serpReqs: 2046, unlockerReqs: 3047 } } };
    assert.deepStrictEqual(budgetBreaches(today, TH, week(4.1)).overspend, []);
    assert.match(budgetBreaches(today, TH, week(6.5)).overspend.join(), /brightdata averaging \$6\.66\/day over 7 days > \$6/);
  });

  test('the pace average stops at a cycle reset', () => {
    const old = ['2026-10-01', '2026-10-02', '2026-10-03'].map((d) => rec(d, { dayCredits: 80000, cycleUsed: 990000, cap: 1000000 }, { dayCredits: 1, cycleUsed: 1, cap: 10 }));
    const fresh = rec('2026-10-04', { dayCredits: 20000, cycleUsed: 20000, cap: 1000000, renewalDate: '2026-11-04', readAt: '2026-10-05T08:00:00Z' }, { dayCredits: 1, cycleUsed: 1, cap: 10 });
    assert.deepStrictEqual(budgetBreaches(fresh, TH, old).overspend, []);
  });

  test('ScrapingDog renewal is counted from the read date', () => {
    const r = computeDayRecord({ day: '2026-10-29', bb: null, bd: null, sb: null, sd: { cycleUsed: 10, limit: 100, daysToRenewal: 3 }, prev: null, readAt: '2026-10-30T08:43:00Z' });
    assert.equal(r.providers.scrapingdog.renewalDate, '2026-11-02');
    const expired = computeDayRecord({ day: '2026-10-29', bb: null, bd: null, sb: null, sd: { cycleUsed: 10, limit: 100, daysToRenewal: -2 }, prev: null, readAt: '2026-10-30T08:43:00Z' });
    assert.equal(expired.providers.scrapingdog.renewalDate, null);
  });
}
