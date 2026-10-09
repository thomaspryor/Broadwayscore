/**
 * National-tour listing, indexing and copy (BRO-4931). Calls the real exported
 * functions (CLAUDE.md rule 15). The tours page used to hide every tour below
 * the score threshold (19 of 44 live tours), noindexed those pages and kept
 * them out of the sitemap and search.
 *
 * The tour flag is read when the module loads, so it is set before the import.
 *
 * Run: npx tsx --test tests/unit/tour-listing.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  isTourScored, isTourBrowsable, isTourIndexable, isLiveTour, getTourSection, tourSectionRank, TOUR_SECTIONS,
} from '../../src/lib/tour-listing';

process.env.NEXT_PUBLIC_FEATURES = 'tour';
// tsx compiles the component's JSX with the classic runtime, which needs React in scope.
(globalThis as unknown as { React: typeof React }).React = React;

const require = createRequire(import.meta.url);
const { isTourIndexableSlim } = require('../../scripts/lib/search-shows-scores.js');

const tour = (over: Record<string, unknown> = {}): any => ({
  id: 't', category: 'tour', status: 'open', title: 'T',
  criticScore: { score: 80, reviewCount: 5, tier1Count: 0, tier2Count: 2 }, ...over,
});
const unscored = (over: Record<string, unknown> = {}) =>
  tour({ criticScore: { score: 0, reviewCount: 1, tier1Count: 0, tier2Count: 0 }, ...over });

test('isTourScored: 3 reviews with a T1/T2, 5 without; non-tours always pass', () => {
  assert.equal(isTourScored(tour({ criticScore: { reviewCount: 3, tier1Count: 0, tier2Count: 1 } })), true);
  assert.equal(isTourScored(tour({ criticScore: { reviewCount: 4, tier1Count: 0, tier2Count: 0 } })), false);
  assert.equal(isTourScored(tour({ criticScore: { reviewCount: 5, tier1Count: 0, tier2Count: 0 } })), true);
  assert.equal(isTourScored(tour({ criticScore: undefined })), false);
  assert.equal(isTourScored({ category: 'broadway', criticScore: undefined } as any), true);
});

test('isLiveTour: only open or previews tours say "Reviews coming in"; upcoming and closed do not', () => {
  assert.equal(isLiveTour(tour()), true);
  assert.equal(isLiveTour(tour({ status: 'previews' })), true);
  assert.equal(isLiveTour(tour({ status: 'upcoming' })), false);
  assert.equal(isLiveTour(tour({ status: 'closed' })), false);
  assert.equal(isLiveTour({ category: 'broadway', status: 'open' } as any), false);
});

test('sections: running scored, running unscored, upcoming, closed; ranks follow TOUR_SECTIONS', () => {
  assert.equal(getTourSection(tour()), 'On the road now');
  assert.equal(getTourSection(unscored()), 'Reviews coming in');
  assert.equal(getTourSection(unscored({ status: 'upcoming' })), 'Coming soon');
  assert.equal(getTourSection(tour({ status: 'upcoming' })), 'Coming soon');
  assert.equal(getTourSection(tour({ status: 'closed' })), 'Closed tours');
  assert.deepEqual(
    [tour(), unscored(), unscored({ status: 'upcoming' }), tour({ status: 'closed' })].map(tourSectionRank),
    [0, 1, 2, 3],
  );
  assert.deepEqual([...TOUR_SECTIONS], ['On the road now', 'Reviews coming in', 'Coming soon', 'Closed tours']);
});

test('browsable: scored, or not closed with stops ahead; never a closed unscored tour', () => {
  assert.equal(isTourBrowsable(tour({ status: 'closed' }), false), true, 'scored closed tours stay listed');
  assert.equal(isTourBrowsable(unscored(), true), true);
  assert.equal(isTourBrowsable(unscored({ status: 'upcoming' }), true), true);
  assert.equal(isTourBrowsable(unscored(), false), false, 'no stops ahead');
  assert.equal(isTourBrowsable(unscored({ status: 'closed' }), true), false);
  assert.equal(isTourBrowsable({ category: 'broadway', status: 'open' } as any, true), false);
});

test('indexable: unscored tours need a stop ahead and must not be closed', () => {
  assert.equal(isTourIndexable(tour({ status: 'closed' }), false), true);
  assert.equal(isTourIndexable(unscored(), true), true);
  assert.equal(isTourIndexable(unscored({ status: 'upcoming' }), true), true);
  assert.equal(isTourIndexable(unscored(), false), false);
  assert.equal(isTourIndexable(unscored({ status: 'closed' }), true), false);
  assert.equal(isTourIndexable({ category: 'broadway', status: 'closed' } as any, false), true);
});

test('indexable and browsable agree for every tour state (a listed tour is never noindex)', () => {
  for (const scored of [true, false]) {
    for (const status of ['open', 'previews', 'upcoming', 'closed'] as const) {
      for (const ahead of [true, false]) {
        const t = scored ? tour({ status }) : unscored({ status });
        assert.equal(isTourIndexable(t, ahead), isTourBrowsable(t, ahead), `scored=${scored} status=${status} ahead=${ahead}`);
      }
    }
  }
  // The regression: an open unscored tour whose stops have all ended.
  assert.equal(isTourIndexable(unscored(), false), false);
  assert.equal(isTourBrowsable(unscored(), false), false);
});

test('search index mirrors indexable (isTourIndexableSlim)', () => {
  const scored = { rc: 3, rv: [{ t: 2 }, { t: 3 }, { t: 3 }] };
  const none = { rc: 0, rv: [] };
  assert.equal(isTourIndexableSlim(scored, 'closed', false), true);
  assert.equal(isTourIndexableSlim(none, 'open', true), true);
  assert.equal(isTourIndexableSlim(none, 'upcoming', true), true);
  assert.equal(isTourIndexableSlim(none, 'open', false), false);
  assert.equal(isTourIndexableSlim(none, 'closed', true), false);
  assert.equal(isTourIndexableSlim(null, 'open', true), true, 'no slim file yet but live with a stop ahead');
  assert.equal(isTourIndexableSlim(none, 'open', false), false, 'every stop already ended');
});

test('tours page config: neutral heading, unchanged URL, sections in one run each', async () => {
  const { BROWSE_PAGES } = await import('../../src/config/browse-pages');
  const cfg = (BROWSE_PAGES as Record<string, any>)['broadway-national-tours'];
  assert.ok(cfg, 'URL slug broadway-national-tours is unchanged');
  assert.equal(cfg.slug, 'broadway-national-tours');
  assert.equal(cfg.title, 'National Tours');
  for (const k of ['title', 'h1', 'metaTitle', 'metaDescription', 'intro']) {
    assert.doesNotMatch(cfg[k], /Broadway/, `${k} must not assume Broadway`);
  }
  const shows = [tour({ id: 'a', title: 'A', criticScore: { score: 70, reviewCount: 6, tier1Count: 0, tier2Count: 1 } }),
    tour({ id: 'b', title: 'B', status: 'closed', criticScore: { score: 90, reviewCount: 6, tier1Count: 0, tier2Count: 1 } }),
    unscored({ id: 'c', title: 'C' }), unscored({ id: 'd', title: 'D', status: 'upcoming' }),
    tour({ id: 'e', title: 'E', criticScore: { score: 95, reviewCount: 9, tier1Count: 1, tier2Count: 1 } }),
    unscored({ id: 'f', title: 'Aa' })];
  const sorted = cfg.customSort(shows, {});
  assert.deepEqual(sorted.map((s: any) => s.id), ['e', 'a', 'f', 'c', 'd', 'b']);
  assert.deepEqual(sorted.map((s: any) => cfg.sectionGroup(s)),
    ['On the road now', 'On the road now', 'Reviews coming in', 'Reviews coming in', 'Coming soon', 'Closed tours']);
});

test('real data: every running tour with stops ahead is browsable, scored tours keep their place', async () => {
  const dc = await import('../../src/lib/data-core');
  const { getTourSchedule } = await import('../../src/lib/data-tour-schedule');
  const today = new Date().toISOString().slice(0, 10);
  const browse = dc.getTourBrowseShows(today);
  const ids = new Set(browse.map(s => s.id));
  const tours = dc.getAllShows().filter(s => s.category === 'tour');
  assert.ok(tours.length > 0);
  for (const s of dc.getTourShows()) assert.ok(ids.has(s.id), `scored tour ${s.id} is listed`);
  for (const s of tours) {
    const ahead = getTourSchedule(s.id).some(x => x.end >= today);
    if (s.status !== 'closed' && ahead) assert.ok(ids.has(s.id), `${s.id} (${s.status}, stops ahead) is listed`);
    if (s.status === 'closed' && !dc.isTourListed(s)) assert.ok(!ids.has(s.id), `${s.id} closed and unscored stays off`);
  }
  // Everything the page lists is also indexable, so it is never a listed noindex page.
  for (const s of browse) {
    if (!dc.isTourListed(s)) assert.ok(dc.isTourIndexableShow(s), `${s.id} listed but noindex`);
  }
  // The page's own sections come out contiguous from the real config.
  const list = dc.getBrowseList('broadway-national-tours');
  assert.ok(list, 'tours page exists');
  const labels = list!.shows.map(s => list!.config.sectionGroup!(s, dc.getShowById));
  const runs = labels.filter((l, i) => i === 0 || l !== labels[i - 1]);
  assert.equal(new Set(runs).size, runs.length, `a heading repeats: ${runs.join(' | ')}`);
  assert.deepEqual(runs, TOUR_SECTIONS.filter(t => runs.includes(t)), 'sections are in display order');
});

test('real data: an unscored running tour with a schedule is indexable; a closed unscored one is not', async () => {
  const dc = await import('../../src/lib/data-core');
  const { getTourSchedule } = await import('../../src/lib/data-tour-schedule');
  const today = new Date().toISOString().slice(0, 10);
  // "Running" means engagements still ahead, as isTourIndexableShow decides:
  // a tour whose whole schedule is past is not indexable even if never closed.
  for (const s of dc.getAllShows().filter(x => x.category === 'tour')) {
    const scheduled = getTourSchedule(s.id).some(e => e.end >= today);
    const expected = dc.isTourListed(s) || (s.status !== 'closed' && scheduled);
    assert.equal(dc.isTourIndexableShow(s), expected, s.id);
  }
});

test('getToursOf: any non-tour market links its tour; unscored scheduled tours are included', async () => {
  const { getToursOf, getAllShows, getShowById, isTourListed, isTourIndexableShow } = await import('../../src/lib/data-core');
  // The tour names its parent by id, so a parent in any market is found.
  const withParent = getAllShows().find(s => s.category === 'tour' && s.tourOf && getShowById(s.tourOf));
  assert.ok(withParent);
  const parent = getShowById(withParent!.tourOf!)!;
  for (const category of ['broadway', 'off-broadway', 'regional', 'west-end'] as const) {
    const ids = getToursOf({ id: parent.id, title: parent.title, category }).map(t => t.id);
    if (isTourIndexableShow(withParent!)) assert.ok(ids.includes(withParent!.id), `${category}: ${withParent!.id}`);
  }
  // A same-title production in ANOTHER market does not inherit the link.
  assert.deepEqual(getToursOf({ id: 'someone-elses-id', title: parent.title, category: 'off-broadway' })
    .filter(t => getShowById(t.tourOf!)?.category !== 'off-broadway'), []);
  // A tour never lists tours.
  assert.deepEqual(getToursOf({ id: withParent!.id, title: withParent!.title, category: 'tour' }), []);
  // An unscored tour is linked from its parent (this is the 19-tour gap).
  const unscored = getAllShows().find(s => s.category === 'tour' && s.tourOf && !isTourListed(s) && isTourIndexableShow(s));
  if (unscored) {
    const p = getShowById(unscored.tourOf!)!;
    assert.ok(getToursOf(p).some(t => t.id === unscored.id), `${p.id} links ${unscored.id}`);
  }
  // Nothing noindex is ever linked.
  for (const t of getToursOf(parent)) assert.ok(isTourIndexableShow(t), t.id);
});

test('ShowTrustLines: copy follows the parent market; a standalone tour has no parent line', async () => {
  const dc = await import('../../src/lib/data-core');
  const { default: ShowTrustLines } = await import('../../src/components/show-page/ShowTrustLines');
  const base: any = dc.getAllShows().find(s => s.category === 'tour' && s.tourOf && dc.getShowById(s.tourOf));
  assert.ok(base);
  const html = (show: any) => renderToStaticMarkup(React.createElement(ShowTrustLines, { show }));

  const broadway = html(base);
  assert.match(broadway, /scored separately from the Broadway run/);
  assert.match(broadway, /See the Broadway production/);

  const ob = dc.getAllShows().find(s => s.category === 'off-broadway');
  assert.ok(ob);
  const offBroadway = html({ ...base, tourOf: ob!.id });
  assert.match(offBroadway, /scored separately from the Off-Broadway run/);
  assert.match(offBroadway, /See the Off-Broadway production/);
  assert.doesNotMatch(offBroadway, /(?<!Off-)Broadway (production|run)/);

  const standalone = html({ ...base, tourOf: undefined });
  assert.match(standalone, /Reviewed by critics in each city on the tour\./);
  assert.doesNotMatch(standalone, /Broadway|separately|tour-of-link/);
});

test('ShowTrustLines: a parent whose tours have no score yet says reviews are coming in', async () => {
  const dc = await import('../../src/lib/data-core');
  const { default: ShowTrustLines } = await import('../../src/components/show-page/ShowTrustLines');
  const t = dc.getAllShows().find(s => s.category === 'tour' && s.tourOf && !dc.isTourListed(s) && dc.isTourIndexableShow(s));
  if (!t) return; // every live tour has a score: nothing to show
  const parent = dc.getShowById(t.tourOf!)!;
  const siblings = dc.getToursOf(parent);
  if (siblings.some(x => dc.isTourListed(x))) return; // another tour of the title has a score
  const markup = renderToStaticMarkup(React.createElement(ShowTrustLines, { show: parent }));
  assert.match(markup, /reviews coming in/);
  assert.doesNotMatch(markup, /has its own critic score/);
});
