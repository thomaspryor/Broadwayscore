/**
 * BRO-712 — section groupings for 5 more browse pages.
 *
 * Covers the acceptance criteria directly: each target page defines a
 * sectionGroup, real (filtered) data never produces an empty/undefined
 * label, and pages outside the target set are unaffected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSE_PAGES } from '../../src/config/browse-pages';
import { getBrowseList, getShowById } from '../../src/lib/data-core';
import { getShowGrosses } from '../../src/lib/data-grosses';

const TARGET_SLUGS = [
  'broadway-shows-closing-soon',
  'broadway-ticket-prices',
  'longest-running-broadway-shows',
  'new-broadway-shows-2026',
  'best-broadway-shows-all-time',
];

test('all 5 target browse pages define a sectionGroup function', () => {
  for (const slug of TARGET_SLUGS) {
    const config = BROWSE_PAGES[slug];
    assert.ok(config, `missing browse page config for ${slug}`);
    assert.equal(typeof config.sectionGroup, 'function', `${slug} is missing sectionGroup`);
  }
});

test('target pages render no empty section labels against real data', () => {
  for (const slug of TARGET_SLUGS) {
    const browseList = getBrowseList(slug);
    assert.ok(browseList, `getBrowseList(${slug}) returned nothing`);
    const { config, shows } = browseList;
    assert.ok(shows.length > 0, `${slug} has no shows to group`);

    for (const show of shows) {
      const label = config.sectionGroup(show, getShowById, getShowGrosses);
      assert.equal(typeof label, 'string', `${slug}: sectionGroup returned non-string for ${show.slug}`);
      assert.ok(label.trim().length > 0, `${slug}: sectionGroup returned an empty label for ${show.slug}`);
    }
  }
});

test('broadway-shows-closing-soon groups by closing month', () => {
  const { sectionGroup } = BROWSE_PAGES['broadway-shows-closing-soon'];
  // Mid-month dates avoid local-timezone boundary flakiness in Date parsing.
  assert.equal(sectionGroup({ closingDate: '2026-09-15' }), 'September 2026');
  assert.equal(sectionGroup({ closingDate: '2026-04-15' }), 'April 2026');
  assert.equal(sectionGroup({ closingDate: null }), 'Closing Date TBD');
  assert.equal(sectionGroup({}), 'Closing Date TBD');
});

test('broadway-ticket-prices groups by average ticket price band', () => {
  const { sectionGroup } = BROWSE_PAGES['broadway-ticket-prices'];
  const grossesFor = (atp) => () => ({ thisWeek: { atp } });
  assert.equal(sectionGroup({ slug: 'cheap-show' }, undefined, grossesFor(75)), 'Under $100');
  assert.equal(sectionGroup({ slug: 'mid-show' }, undefined, grossesFor(100)), '$100-150');
  assert.equal(sectionGroup({ slug: 'mid-show-2' }, undefined, grossesFor(149.99)), '$100-150');
  assert.equal(sectionGroup({ slug: 'premium-show' }, undefined, grossesFor(150)), '$150+');
  assert.equal(sectionGroup({ slug: 'premium-show-2' }, undefined, grossesFor(240)), '$150+');
  // No grosses data at all should still return a valid (non-empty) label, not throw.
  assert.equal(sectionGroup({ slug: 'no-data-show' }, undefined, () => undefined), 'Under $100');
});

test('longest-running-broadway-shows groups by decade opened', () => {
  const { sectionGroup } = BROWSE_PAGES['longest-running-broadway-shows'];
  assert.equal(sectionGroup({ openingDate: '1985-01-01' }), 'Opened Before 2000');
  assert.equal(sectionGroup({ openingDate: '2003-01-01' }), 'Opened in the 2000s');
  assert.equal(sectionGroup({ openingDate: '2015-01-01' }), 'Opened in the 2010s');
  assert.equal(sectionGroup({ openingDate: '2023-01-01' }), 'Opened in the 2020s');
});

test('new-broadway-shows-2026 groups by opening month', () => {
  const { sectionGroup } = BROWSE_PAGES['new-broadway-shows-2026'];
  assert.equal(sectionGroup({ openingDate: '2026-03-10' }), 'Opened in March');
  assert.equal(sectionGroup({ openingDate: '2026-11-05' }), 'Opened in November');
});

test('best-broadway-shows-all-time groups by CriticScore tier', () => {
  const { sectionGroup } = BROWSE_PAGES['best-broadway-shows-all-time'];
  assert.equal(sectionGroup({ criticScore: { score: 95 } }), 'Legendary (90+)');
  assert.equal(sectionGroup({ criticScore: { score: 85 } }), 'Must-See (80-89)');
  assert.equal(sectionGroup({ criticScore: { score: 72 } }), 'Highly Rated (70-79)');
  assert.equal(sectionGroup({ criticScore: { score: 40 } }), 'Worth Seeing (Under 70)');
  assert.equal(sectionGroup({}), 'Worth Seeing (Under 70)');
});

test('previously grouped pages (runtimes, age guide) are unaffected', () => {
  const runtimes = BROWSE_PAGES['broadway-show-runtimes'];
  assert.equal(typeof runtimes.sectionGroup, 'function');
  assert.equal(runtimes.sectionGroup({ runtime: '1h 20m' }), 'Under 1.5 Hours');
  assert.equal(runtimes.sectionGroup({ runtime: '2h 45m' }), 'Over 2.5 Hours');

  const ageGuide = BROWSE_PAGES['broadway-age-guide'];
  assert.equal(typeof ageGuide.sectionGroup, 'function');
  assert.equal(ageGuide.sectionGroup({ ageRecommendation: 'Ages 5+' }), 'Young Children (Ages 4-6)');
  assert.equal(ageGuide.sectionGroup({ ageRecommendation: 'Ages 16+' }), 'Mature Audiences (Ages 14+)');
});

test('pages outside the target set still render correctly and stay ungrouped', () => {
  const untouchedSlugs = ['best-broadway-musicals', 'best-broadway-plays', 'broadway-lottery-shows'];
  for (const slug of untouchedSlugs) {
    const browseList = getBrowseList(slug);
    assert.ok(browseList, `getBrowseList(${slug}) returned nothing`);
    assert.equal(browseList.config.sectionGroup, undefined, `${slug} unexpectedly gained a sectionGroup`);
  }
});
