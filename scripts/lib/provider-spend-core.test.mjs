import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeDayRecord, budgetBreaches, computeStreak, renderSnapshot } = require('./provider-spend-core.js');

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

test('computeDayRecord: deltas vs previous day, BB priced per session', () => {
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

test('computeStreak counts trailing proven-green days only', () => {
  const green = (day) => computeDayRecord({ ...okReadings, day, prev: prevRecord });
  const unknownDay = computeDayRecord({ ...okReadings, day: 'x', bb: null, prev: prevRecord });
  const baselineDay = computeDayRecord({ ...okReadings, day: 'b', prev: undefined });

  assert.equal(computeStreak([green('1'), green('2'), green('3')], THRESHOLDS), 3);
  assert.equal(computeStreak([green('1'), unknownDay, green('3')], THRESHOLDS), 1);
  assert.equal(computeStreak([green('1'), green('2'), unknownDay], THRESHOLDS), 0);
  assert.equal(computeStreak([baselineDay, green('2')], THRESHOLDS), 1);
});

test('renderSnapshot: unmeasured day never reads as green', () => {
  const rec = computeDayRecord({ ...okReadings, bd: null, prev: prevRecord });
  const snap = renderSnapshot({
    record: rec, streak: 0,
    breaches: budgetBreaches(rec, THRESHOLDS),
    generatedAt: '2026-07-30T12:00:00Z',
  });
  assert.match(snap.bannerText, /Could not measure: brightdata/);
  assert.equal(snap.items.length, 4);
});

test('renderSnapshot: green day shows streak progress', () => {
  const rec = computeDayRecord({ ...okReadings, prev: prevRecord });
  const snap = renderSnapshot({
    record: rec, streak: 4,
    breaches: budgetBreaches(rec, THRESHOLDS),
    generatedAt: '2026-07-30T12:00:00Z',
  });
  assert.match(snap.bannerText, /streak 4 of 7/);
});
