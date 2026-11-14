/**
 * Tours hub redesign (BRO-6544): the city picker's agenda and date ranges,
 * the review byline's stop label, and the Status filter's default. Calls the
 * real exported functions and component (CLAUDE.md rule 15).
 *
 * Run: npx tsx --test tests/unit/tour-hub.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cityAgenda, stopDateRange } from '../../src/lib/tour-cities';
import { bylineStopLabel } from '../../src/lib/tour-schedule';

process.env.NEXT_PUBLIC_FEATURES = 'tour';
// tsx compiles the component's JSX with the classic runtime, which needs React in scope.
(globalThis as unknown as { React: typeof React }).React = React;

test('stopDateRange: one day, same month, across months', () => {
  assert.equal(stopDateRange('2026-10-30', '2026-10-30'), 'Oct 30');
  assert.equal(stopDateRange('2026-11-06', '2026-11-21'), 'Nov 6–21');
  assert.equal(stopDateRange('2027-01-19', '2027-02-07'), 'Jan 19–Feb 7');
  assert.equal(stopDateRange('2026-12-29', '2027-01-03'), 'Dec 29–Jan 3');
});

test('cityAgenda: playing now, coming grouped by month, ended dropped, limit kept', () => {
  const stops = [
    { showId: 'ended', venue: 'V', start: '2026-10-01', end: '2026-10-10' },
    { showId: 'bom', venue: 'Cadillac Palace', start: '2026-10-23', end: '2026-11-01' },
    { showId: 'jb', venue: 'CIBC', start: '2026-11-10', end: '2026-11-22' },
    { showId: 'mex', venue: 'Studebaker', start: '2026-11-06', end: '2026-11-21' },
    { showId: 'mhe', venue: 'CIBC', start: '2027-01-05', end: '2027-01-17' },
  ];
  const a = cityAgenda(stops, '2026-10-29');
  assert.deepEqual(a.now.map(s => s.showId), ['bom']);
  assert.deepEqual(a.coming.map(m => m.month), ['November 2026', 'January 2027']);
  assert.deepEqual(a.coming[0].stops.map(s => s.showId), ['mex', 'jb'], 'soonest first');
  assert.equal(a.comingCount, 3);

  const capped = cityAgenda(stops, '2026-10-29', 2);
  assert.equal(capped.comingCount, 3, 'count is the full number, for the "more" link');
  assert.deepEqual(capped.coming.flatMap(m => m.stops.map(s => s.showId)), ['mex', 'jb']);

  // The last day of a run still counts as playing now.
  assert.deepEqual(cityAgenda(stops, '2026-11-01').now.map(s => s.showId), ['bom']);
  assert.deepEqual(cityAgenda([], '2026-10-29'), { now: [], coming: [], comingCount: 0 });
});

test('bylineStopLabel: shown unless the outlet name already says the city', () => {
  assert.equal(bylineStopLabel('Behind the Curtain Cincinnati', 'Cincinnati, OH'), null);
  assert.equal(bylineStopLabel('League of Cincinnati Theatres', 'Cincinnati, OH'), null);
  assert.equal(bylineStopLabel('Newsfromme', 'Rochester, NY'), 'Rochester, NY');
  assert.equal(bylineStopLabel('Albany Times-Union', 'Schenectady, NY'), 'Schenectady, NY');
  assert.equal(bylineStopLabel('Chicago Tribune', 'Chicago, IL'), null);
  assert.equal(bylineStopLabel("Valerie's Theater Blog", 'Erie, PA'), 'Erie, PA', 'whole words only');
  assert.equal(bylineStopLabel('St. Louis Post-Dispatch', 'St. Louis, MO'), null, 'dots in the city are literal');
  assert.equal(bylineStopLabel('Variety', null), null);
  assert.equal(bylineStopLabel('Variety', undefined), null);
});

test('BrowseListClient statusFilter: defaults to On the road, other tours stay out of the first render', async () => {
  const { default: BrowseListClient } = await import('../../src/components/BrowseListClient');
  const show = (id: string, status: string, openingDate: string) => ({
    id, slug: id, title: `Title ${id}`, venue: 'Tour', openingDate, status, type: 'musical', category: 'tour',
    criticScore: { score: 80, reviewCount: 6, tier1Count: 0, tier2Count: 2 },
    audienceCombinedScore: null, audienceGrade: null,
  });
  const html = renderToStaticMarkup(React.createElement(BrowseListClient, {
    shows: [show('older', 'open', '2025-09-01'), show('newer', 'open', '2026-10-01'), show('gone', 'closed', '2024-01-01'), show('soon', 'upcoming', '2027-01-01')],
    showRanks: false, isMixedType: false, isMixedStatus: true, defaultSort: 'opening-date', hasPerformanceData: false,
    availableSorts: ['newest', 'score', 'alpha'], showTypeFilter: false, showScoreToggle: false, statusFilter: true,
  }));
  assert.match(html, /Status:/);
  for (const label of ['On the road', 'Coming soon', 'Closed']) assert.match(html, new RegExp(`>${label}<`));
  assert.ok(html.includes('Title newer') && html.includes('Title older'), 'live tours render');
  assert.ok(!html.includes('Title gone') && !html.includes('Title soon'), 'closed and upcoming tours wait behind the filter');
  assert.ok(html.indexOf('Title newer') < html.indexOf('Title older'), 'newest first by default');
});
