/**
 * Box Office / Commercial split (BRO-5007 v3). Calls the real functions and
 * renders the real components (CLAUDE.md rule 15): the show's facts from
 * history, the facts card's sentences, the facts card itself, the Commercial
 * Scorecard's break-even section, and BizBuzzCard with and without it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { showFacts, STEADY_MIN_WEEKS, type MarketInput } from '../../src/lib/box-office-market';
import { addDays, type HistoryRow, type HistoryWeeks } from '../../src/lib/box-office-weeks';
import { factsStory, formatGross, yearAgoSentence, toFactsCard, showsBreakEven, bestLines, weekEndingText } from '../../src/lib/box-office-v2-display';
import BoxOfficeScorecard from '../../src/components/BoxOfficeScorecard';
import { BoxOfficeThisWeek } from '../../src/components/BoxOfficeStats';
import BreakEvenSection from '../../src/components/biz/BreakEvenSection';
import BizBuzzCard from '../../src/components/BizBuzzCard';

// tsx compiles JSX with the classic runtime, which needs React in scope.
(globalThis as unknown as { React: typeof React }).React = React;

const row = (gross: number): HistoryRow => ({ gross, performances: 8, seatsOffered: 8_000, capacity: 90, atp: 100 });
const input = (weeks: HistoryWeeks): MarketInput => ({ weeks, shows: new Map() });
const LATEST = '2026-10-04';

test('showFacts: rank among reporting shows, both year-ago changes, and the steady stretch', () => {
  const weeks: HistoryWeeks = {};
  for (let i = 0; i < 60; i++) {
    const w = addDays(LATEST, -7 * i);
    // The show: $700K for the last 10 weeks, $1.2M before that.
    weeks[w] = { mhe: row(i < 10 ? 700_000 : 1_200_000), big: row(2_000_000), other: row(1_000_000) };
  }
  const f = showFacts(input(weeks), 'mhe', LATEST)!;
  assert.equal(f.week, LATEST);
  assert.equal(f.current, true);
  assert.deepEqual([f.rank, f.of], [3, 3]);
  assert.equal(Math.round(f.yearAgoPct!), -42);
  assert.equal(Math.round(f.marketYearAgoPct!), -12);
  // The fixture's rows have no attendance, so the change is not split.
  assert.deepEqual([f.attendanceYoyPct, f.atpYoyPct, f.marketAttendanceYoyPct], [null, null, null]);
  assert.equal(f.series.length, 52);
  assert.deepEqual(f.steady, { low: 700_000, high: 700_000, since: addDays(LATEST, -63) });
});

test('showFacts: splits the year-ago change into attendance and average ticket, and measures Broadway\'s attendance', () => {
  const ly = addDays(LATEST, -364);
  const weeks: HistoryWeeks = {
    // Same audience, ticket $150 -> $108: a price drop.
    [ly]: { ham: { ...row(1_500_000), attendance: 10_000, atp: 150 }, other: { ...row(1_000_000), attendance: 9_000 } },
    [LATEST]: { ham: { ...row(1_080_000), attendance: 10_000, atp: 108 }, other: { ...row(1_000_000), attendance: 8_000 } },
  };
  const f = showFacts(input(weeks), 'ham', LATEST)!;
  assert.equal(Math.round(f.yearAgoPct!), -28);
  assert.equal(f.attendanceYoyPct, 0);
  assert.equal(Math.round(f.atpYoyPct!), -28);
  assert.equal(Math.round(f.marketAttendanceYoyPct!), -5);
  assert.match(factsStory(f, false)!, /almost all from lower average ticket prices \(attendance is flat\)/);
});

test('showFacts: a closed show describes its last reported week; a short or broken run has no steady range', () => {
  const weeks: HistoryWeeks = { [LATEST]: { other: row(1_000_000) } };
  for (let i = 3; i < 3 + STEADY_MIN_WEEKS - 1; i++) weeks[addDays(LATEST, -7 * i)] = { gone: row(500_000), other: row(1_000_000) };
  const f = showFacts(input(weeks), 'gone', LATEST)!;
  assert.equal(f.week, addDays(LATEST, -21));
  assert.equal(f.current, false);
  assert.equal(f.steady, null, `${STEADY_MIN_WEEKS - 1} weeks is not a stretch`);
  assert.equal(f.series[0].week, addDays(LATEST, -7 * (STEADY_MIN_WEEKS + 1)), 'the chart starts at its first reported week');
  assert.equal(showFacts(input(weeks), 'never', LATEST), null);
});

test('yearAgoSentence: in line with Broadway, or out of line without the audience/price split', () => {
  assert.equal(yearAgoSentence({ show: -9, market: -12 }), 'It is down 9% from a year ago, in line with Broadway as a whole (down 12%).');
  assert.equal(yearAgoSentence({ show: 0.2, market: 3 }), 'It is flat from a year ago, in line with Broadway as a whole (up 3%).');
  assert.equal(yearAgoSentence({ show: -42, market: -12 }), 'It is down 42% from a year ago. Broadway as a whole is down 12%.');
  assert.equal(yearAgoSentence({ show: null, market: -12 }), null);
  assert.equal(yearAgoSentence({ show: -42, market: null }), null);
});

test('yearAgoSentence: a drop that is almost all price never says the show is slipping (Hamilton, Oct 2026)', () => {
  const s = yearAgoSentence({ show: -27.7, market: -8.9, attendance: -0.6, atp: -27.3, marketAttendance: -0.3 })!;
  assert.equal(s, 'It is down 28% from a year ago, almost all from lower average ticket prices (attendance is down 1%). Broadway as a whole is down 9%.');
  assert.doesNotMatch(s, /slipping/);
  assert.equal(
    yearAgoSentence({ show: 18, market: -2, attendance: 15, atp: 2.6, marketAttendance: 1 }),
    'It is up 18% from a year ago, almost all from bigger audiences (the average ticket is up 3%). Its audience grew more than Broadway’s (up 1%), so the show is outpacing the season.',
  );
});

test('yearAgoSentence: "slipping" only when the show\'s own attendance fell further than Broadway\'s', () => {
  assert.equal(
    yearAgoSentence({ show: -23, market: -9, attendance: -17, atp: -7, marketAttendance: -0.3 }),
    'It is down 23% from a year ago: attendance is down 17% and the average ticket is down 7%. Its audience fell more than Broadway’s (flat), so the show is slipping against the season.',
  );
  assert.equal(
    yearAgoSentence({ show: -20, market: -5, attendance: -14, atp: -7, marketAttendance: -12 }),
    'It is down 20% from a year ago: attendance is down 14% and the average ticket is down 7%. Broadway as a whole is down 5%.',
    'attendance fell, but no more than Broadway\'s',
  );
  assert.equal(
    yearAgoSentence({ show: -20, market: -5, attendance: -12, atp: -9 }),
    'It is down 20% from a year ago: attendance is down 12% and the average ticket is down 9%. Broadway as a whole is down 5%.',
    'no market attendance, no verdict',
  );
});

test('factsStory: the mock’s three sentences, and the costs pointer only with a Commercial Scorecard', () => {
  const f = { week: LATEST, yearAgoPct: -42, marketYearAgoPct: -12, attendanceYoyPct: -30, atpYoyPct: -17, marketAttendanceYoyPct: -4,
    steady: { low: 633_000, high: 792_000, since: '2026-05-31' } };
  assert.equal(
    factsStory(f, true),
    'It is down 42% from a year ago: attendance is down 30% and the average ticket is down 17%. Its audience fell more than Broadway’s (down 4%), so the show is slipping against the season. ' +
      'Weekly grosses have held between about $630K and $790K since May. ' +
      'Strong sales don’t always mean profit; costs are on the Profitability Scorecard below.',
  );
  assert.ok(!/Profitability Scorecard/.test(factsStory(f, false)!));
  assert.match(factsStory({ ...f, steady: { ...f.steady, since: '2025-12-28' } }, false)!, /since December 2025\.$/);
  assert.equal(factsStory({ week: LATEST, yearAgoPct: null, marketYearAgoPct: null, steady: null }, true), null);
  assert.match(factsStory({ ...f, steady: { low: 1_500_000, high: 1_890_000, since: '2026-08-02' } }, false)!, /between about \$1\.5M and \$1\.89M since August\.$/);
});

const factsCard = (over: Record<string, unknown> = {}) =>
  toFactsCard({ week: LATEST, current: true, gross: 676_000, rank: 23, of: 28, yearAgoPct: -42, marketYearAgoPct: -12, steady: null,
    series: Array.from({ length: 40 }, (_, i) => ({ week: addDays(LATEST, -7 * (39 - i)), gross: 700_000 })), ...over } as never, true);

test('formatGross: thousands under a million, one-decimal millions above', () => {
  assert.equal(formatGross(676_000), '$676K');
  assert.equal(formatGross(999_400), '$999K');
  assert.equal(formatGross(999_600), '$1.0M');
  assert.equal(formatGross(2_705_000), '$2.7M');
});

test('BoxOfficeScorecard renders facts only: no status, no break-even, no estimates', () => {
  const html = renderToStaticMarkup(React.createElement(BoxOfficeScorecard, { card: factsCard(), grosses: null, history: null }));
  assert.match(html, /\$676K/);
  assert.match(html, /#23 of 28 shows/);
  assert.match(html, /week of 10\/4\/2026/);
  assert.match(html, /Is it covering its costs\?/);
  assert.match(html, /Show the full year/);
  for (const banned of [/break-even/i, /Below Cost|Near Cost|Above Cost/, /estimate/i, /~\$/]) assert.doesNotMatch(html, banned);
});

test('BoxOfficeScorecard: a closed show says "last reported week"; no costs link without a Commercial Scorecard', () => {
  const card = { ...factsCard({ current: false, series: [{ week: LATEST, gross: 1 }] }), hasCommercial: false };
  const html = renderToStaticMarkup(React.createElement(BoxOfficeScorecard, { card, grosses: null, history: null }));
  assert.match(html, /last reported week: 10\/4\/2026/);
  assert.match(html, /gross that week/);
  assert.doesNotMatch(html, /Is it covering its costs/);
  assert.doesNotMatch(html, /Show the full year/, 'no toggle under 26 weeks');
});

// Maybe Happy Ending, week of 10/4/2026, as the approved mock draws it.
const mhe = {
  availability: 'ok', band: 'near', closingDate: null, multiple: { lo: 0.71, mid: 0.86, hi: 1.07 }, breakEven: 820_976,
  costBasis: 'estimate', costSourceText: null, costSourceUrl: null, nonprofit: false, nonprofitOrg: null,
  streak: { side: 'below', weeks: 19, atLeast: false }, story: 'Over the last 4 weeks it grossed about 14% less than it needs to break even.',
  series: [{ week: LATEST, gross: 676_000, multiple: 0.82, market: 1.2 }], weeksReported: 40, trend: 'steady',
  cover: { avgGross: 703_074, breakEven: 820_976, shortBy: 117_902, ticketNeeded: 125.97, ticketNow: 107.9, capacityNeeded: 97.8, capacityNow: 83.7 },
} as never;

test('BreakEvenSection: share of break-even with its range, streak, Near note and what it would take', () => {
  assert.equal(showsBreakEven(mhe), true);
  assert.equal(showsBreakEven({ availability: 'nocost', multiple: null } as never), false);
  assert.equal(showsBreakEven({ availability: 'closed', multiple: null } as never), false);
  const html = renderToStaticMarkup(React.createElement(BreakEvenSection, { card: mhe }));
  assert.match(html, /Covering its weekly break-even\?/);
  assert.match(html, /Near Break-even/);
  assert.match(html, />86%</);
  assert.match(html, /of the ~\$821K a week it needs to break even/);
  assert.match(html, /could be 71% to 107%/);
  assert.match(html, /19 straight weeks below break-even/);
  assert.match(html, /rather than Below/);
  assert.match(html, /Short of break-even by/);
  assert.match(html, /\$118K/);
});

const commercial = {
  designation: 'TBD', recouped: false, capitalization: 16_000_000, weeklyRunningCost: 765_000, notes: null,
  capitalizationSource: null, weeklyRunningCostSource: null,
} as never;

test('BizBuzzCard without the v3 section is unchanged: trend chip and the one-week bar stay', () => {
  const html = renderToStaticMarkup(React.createElement(BizBuzzCard, {
    commercial, showTitle: 'MHE', trend: 'declining', weeklyGross: 676_000, showStatus: 'open',
  }));
  assert.match(html, /Grosses down/);
  assert.doesNotMatch(html, /break-even-section/);
});

test('BizBuzzCard with the v3 section drops the trend chip and the one-week bar', () => {
  const html = renderToStaticMarkup(React.createElement(BizBuzzCard, {
    commercial, showTitle: 'MHE', trend: 'declining', weeklyGross: 676_000, showStatus: 'open', breakEvenCard: mhe,
  }));
  assert.doesNotMatch(html, /Grosses down/);
  assert.doesNotMatch(html, /Latest week vs break-even/);
  assert.doesNotMatch(html, /Under est\. break-even/);
});

test('BoxOfficeThisWeek: the v3 card rounds tile changes to nearest (Hamilton\'s -0.08% attendance reads 0%); the default still rounds up', () => {
  const grosses = { thisWeek: { gross: 2_704_838, grossPrevWeek: 2_608_571, grossYoY: 3_743_602, capacity: 101.43, capacityPrevWeek: 101.14, capacityYoY: 101.51,
    atp: 251.78, atpPrevWeek: 243.5, atpYoY: 348.18, attendance: 10_743 } } as never;
  const history = { sparkline: [], rank: 1, rankedShows: 28, marketSharePct: null, attendancePrevWeek: 10_640, attendanceYoY: 10_752 } as never;
  const attendanceTile = (html: string) => html.slice(html.indexOf('Attendance'));
  const v3 = attendanceTile(renderToStaticMarkup(React.createElement(BoxOfficeThisWeek, { grosses, history, roundNearest: true })));
  assert.match(v3, />0%<\/span><span[^>]*>YoY/);
  const live = attendanceTile(renderToStaticMarkup(React.createElement(BoxOfficeThisWeek, { grosses, history })));
  assert.match(live, />1%<\/span><span[^>]*>YoY/, 'flag-off rounding is unchanged');
});

test('bestLines: record, week ending, the latest week beside it, "New best this week" when the latest week set it', () => {
  const b = {
    latestWeek: '2026-10-04',
    weeks: 30,
    rows: [
      { key: 'gross' as const, value: 2_100_000, week: '2024-12-29', latest: 1_600_000, latestIsRecord: false },
      { key: 'capacity' as const, value: 101.4, week: '2025-01-05', latest: null, latestIsRecord: false },
      { key: 'atp' as const, value: 252.4, week: '2026-10-04', latest: 252.4, latestIsRecord: true },
    ],
  };
  const lines = bestLines(b, true)!;
  assert.deepEqual(lines.map((l) => [l.label, l.value, l.when, l.latest]), [
    ['Best week', '$2.1M', 'week ending Dec 29, 2024', 'this week $1.6M'],
    ['Fullest week', '101% full', 'week ending Jan 5, 2025', null],
    ['Highest average ticket', '$252', 'week ending Oct 4, 2026', 'New best this week'],
  ]);
  assert.equal(bestLines(b, false, true)![0].latest, 'final week $1.6M', 'a closed show says final week');
  assert.equal(bestLines(b, false, true)![2].latest, 'Set in its final week');
  assert.equal(bestLines(b, false)![0].latest, 'latest week $1.6M', 'a running show that missed a week never says final');
  const tie = { ...b, rows: [{ key: 'capacity' as const, value: 100.2, week: '2003-11-30', latest: 99.6, latestIsRecord: false }] };
  assert.equal(bestLines(tie, true)![0].latest, 'this week matches it', 'a latest week that rounds to the record says so');
  assert.equal(bestLines(null, true), null);
  assert.equal(weekEndingText('2024-12-29'), 'Dec 29, 2024');
});

test('the card prints personal bests only when there are records, with the dollars-at-the-time note', () => {
  const base = { week: '2026-10-04', current: true, gross: 1_000_000, rank: 3, of: 28, series: [], yearAgoPct: null, marketYearAgoPct: null, steady: null };
  const withBests = toFactsCard({ ...base, bests: { latestWeek: '2026-10-04', weeks: 6, rows: [{ key: 'gross', value: 1_500_000, week: '2026-09-06', latest: 1_000_000, latestIsRecord: false }] } }, false);
  const html = renderToStaticMarkup(React.createElement(BoxOfficeScorecard, { card: withBests, grosses: null, history: null }));
  assert.match(html, /Personal bests · this run/);
  assert.match(html, /Dollars at the time/);
  assert.doesNotMatch(html, /break-even|multiple|grade/i);
  const without = toFactsCard({ ...base, bests: null }, false);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(BoxOfficeScorecard, { card: without, grosses: null, history: null })), /Personal bests/);
});
