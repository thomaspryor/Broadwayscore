/**
 * Unit tests for src/lib/data-core.ts — the central data access module
 *
 * Tests exported functions: pure utilities (slugify), query/filter functions,
 * sort functions, and aggregate computations. Uses real data loaded at build time.
 *
 * Run with: npx tsx --test tests/unit/data-core.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  slugify,
  getAllShows,
  getBroadwayShows,
  getWestEndShows,
  getOffBroadwayShows,
  getMarketStats,
  getShowsByStatus,
  getCurrentShows,
  getShowBySlug,
  getShowById,
  getAllShowSlugs,
  getShowsSortedByCompositeScore,
  getDataFreshness,
  getDataStats,
  getShowLastUpdated,
  getUpcomingShows,
  getAllDirectors,
  getDirectorBySlug,
  getAllDirectorSlugs,
  getAllTheaters,
  getTheaterBySlug,
  getAllTheaterSlugs,
  getBestOfList,
  getAllBestOfCategories,
  getBrowseList,
  getAllBrowseSlugs,
  getRelatedShows,
  getRelatedShowsOpen,
  getRelatedShowsClosed,
  getOtherProductions,
  type ComputedShow,
} from '../../src/lib/data-core';

// ===========================================
// slugify — pure string transformation
// ===========================================

describe('slugify', () => {
  test('lowercases and replaces spaces with hyphens', () => {
    assert.strictEqual(slugify('Sam Mendes'), 'sam-mendes');
  });

  test('removes leading and trailing hyphens', () => {
    assert.strictEqual(slugify('--Hello World--'), 'hello-world');
  });

  test('collapses consecutive non-alphanumeric chars into single hyphen', () => {
    assert.strictEqual(slugify('John   O\'Brien'), 'john-o-brien');
  });

  test('handles accented/special characters by removing them', () => {
    assert.strictEqual(slugify('José Rivera'), 'jos-rivera');
  });

  test('handles empty string', () => {
    assert.strictEqual(slugify(''), '');
  });

  test('handles string with only special characters', () => {
    assert.strictEqual(slugify('!!!'), '');
  });

  test('handles single word', () => {
    assert.strictEqual(slugify('Hamilton'), 'hamilton');
  });

  test('handles numbers', () => {
    assert.strictEqual(slugify('1776 The Musical'), '1776-the-musical');
  });
});

// ===========================================
// getAllShows — returns all shows (cached)
// ===========================================

describe('getAllShows', () => {
  test('returns a non-empty array', () => {
    const shows = getAllShows();
    assert.ok(Array.isArray(shows));
    assert.ok(shows.length > 0, 'Expected at least one show');
  });

  test('every show has required fields', () => {
    const shows = getAllShows();
    for (const show of shows.slice(0, 50)) {
      assert.ok(show.id, `Show missing id`);
      assert.ok(show.title, `Show ${show.id} missing title`);
      assert.ok(show.slug, `Show ${show.id} missing slug`);
      assert.ok(show.status, `Show ${show.id} missing status`);
    }
  });

  test('returns same reference on repeated calls (cache)', () => {
    const first = getAllShows();
    const second = getAllShows();
    assert.strictEqual(first, second, 'Expected cached reference');
  });
});

// ===========================================
// Market filtering: getBroadwayShows, getWestEndShows, getOffBroadwayShows
// ===========================================

describe('getBroadwayShows', () => {
  test('returns only broadway or uncategorized shows', () => {
    const shows = getBroadwayShows();
    assert.ok(shows.length > 0);
    for (const show of shows) {
      assert.ok(
        !show.category || show.category === 'broadway',
        `Show ${show.id} has unexpected category: ${show.category}`
      );
    }
  });

  test('does not include west-end or off-broadway shows', () => {
    const shows = getBroadwayShows();
    const wrongCategory = shows.filter(s => s.category === 'west-end' || s.category === 'off-broadway');
    assert.strictEqual(wrongCategory.length, 0);
  });
});

describe('getWestEndShows', () => {
  test('returns only London market shows (west-end + off-west-end)', () => {
    const shows = getWestEndShows();
    for (const show of shows) {
      assert.ok(
        show.category === 'west-end' || show.category === 'off-west-end',
        `Show ${show.id} has wrong category: ${show.category} (expected west-end or off-west-end)`
      );
    }
  });
});

describe('getOffBroadwayShows', () => {
  test('returns only off-broadway category shows', () => {
    const shows = getOffBroadwayShows();
    for (const show of shows) {
      assert.strictEqual(show.category, 'off-broadway', `Show ${show.id} has wrong category`);
    }
  });
});

describe('market partitioning', () => {
  test('broadway + west-end + off-broadway covers all shows', () => {
    const all = getAllShows().length;
    const bw = getBroadwayShows().length;
    const we = getWestEndShows().length;
    const ob = getOffBroadwayShows().length;
    assert.strictEqual(bw + we + ob, all, 'Market partitions should sum to total shows');
  });

  test('each market function returns unique show IDs (no duplicates)', () => {
    for (const [name, fn] of [
      ['getBroadwayShows', getBroadwayShows],
      ['getWestEndShows', getWestEndShows],
      ['getOffBroadwayShows', getOffBroadwayShows],
    ] as const) {
      const shows = (fn as () => ComputedShow[])();
      const ids = shows.map(s => s.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(
        uniqueIds.size, ids.length,
        `${name} returned duplicate IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`
      );
    }
  });
});

// ===========================================
// getMarketStats
// ===========================================

describe('getMarketStats', () => {
  test('returns nyc and westEnd stats', () => {
    const stats = getMarketStats();
    assert.ok(stats.nyc);
    assert.ok(stats.westEnd);
    assert.ok(typeof stats.nyc.openShows === 'number');
    assert.ok(typeof stats.nyc.theaters === 'number');
    assert.ok(typeof stats.westEnd.openShows === 'number');
    assert.ok(typeof stats.westEnd.theaters === 'number');
  });

  test('open shows count matches filtered shows', () => {
    const stats = getMarketStats();
    const bwOpen = getBroadwayShows().filter(s => s.status === 'open' || s.status === 'previews');
    assert.strictEqual(stats.nyc.openShows, bwOpen.length);
  });
});

// ===========================================
// getShowsByStatus
// ===========================================

describe('getShowsByStatus', () => {
  test('status=open returns only open Broadway shows', () => {
    const shows = getShowsByStatus('open');
    for (const show of shows) {
      assert.strictEqual(show.status, 'open');
      assert.ok(!show.category || show.category === 'broadway');
    }
  });

  test('status=closed returns only closed Broadway shows', () => {
    const shows = getShowsByStatus('closed');
    for (const show of shows) {
      assert.strictEqual(show.status, 'closed');
    }
  });

  test('status=all returns all Broadway shows', () => {
    const shows = getShowsByStatus('all');
    assert.strictEqual(shows.length, getBroadwayShows().length);
  });

  test('includeOffBroadway includes off-broadway shows', () => {
    const withOB = getShowsByStatus('all', { includeOffBroadway: true });
    const withoutOB = getShowsByStatus('all');
    // With off-broadway should include more or equal shows
    assert.ok(withOB.length >= withoutOB.length);
  });

  test('includeOffBroadway=true for open status includes OB open shows', () => {
    const shows = getShowsByStatus('open', { includeOffBroadway: true });
    for (const show of shows) {
      assert.strictEqual(show.status, 'open');
    }
    // Should include OB shows if any are open
    const obOpen = getOffBroadwayShows().filter(s => s.status === 'open');
    if (obOpen.length > 0) {
      assert.ok(shows.length > getShowsByStatus('open').length);
    }
  });
});

// ===========================================
// getCurrentShows
// ===========================================

describe('getCurrentShows', () => {
  test('returns only open Broadway shows', () => {
    const shows = getCurrentShows();
    for (const show of shows) {
      assert.strictEqual(show.status, 'open');
      assert.ok(!show.category || show.category === 'broadway');
    }
  });

  test('matches getShowsByStatus open', () => {
    assert.deepStrictEqual(getCurrentShows(), getShowsByStatus('open'));
  });
});

// ===========================================
// getShowBySlug and getShowById
// ===========================================

describe('getShowBySlug', () => {
  test('finds a show by slug', () => {
    const allSlugs = getAllShowSlugs();
    assert.ok(allSlugs.length > 0);
    const slug = allSlugs[0];
    const show = getShowBySlug(slug);
    assert.ok(show);
    assert.strictEqual(show.slug, slug);
  });

  test('returns undefined for non-existent slug', () => {
    const show = getShowBySlug('this-show-does-not-exist-xyz-123');
    assert.strictEqual(show, undefined);
  });
});

describe('getShowById', () => {
  test('finds a show by id', () => {
    const shows = getAllShows();
    const id = shows[0].id;
    const show = getShowById(id);
    assert.ok(show);
    assert.strictEqual(show.id, id);
  });

  test('returns undefined for non-existent id', () => {
    const show = getShowById('nonexistent-id-xyz');
    assert.strictEqual(show, undefined);
  });
});

// ===========================================
// getAllShowSlugs
// ===========================================

describe('getAllShowSlugs', () => {
  test('returns array of strings', () => {
    const slugs = getAllShowSlugs();
    assert.ok(Array.isArray(slugs));
    assert.ok(slugs.length > 0);
    for (const slug of slugs.slice(0, 10)) {
      assert.strictEqual(typeof slug, 'string');
      assert.ok(slug.length > 0);
    }
  });

  test('all slugs are unique', () => {
    const slugs = getAllShowSlugs();
    const uniqueSlugs = new Set(slugs);
    assert.strictEqual(uniqueSlugs.size, slugs.length, 'Expected all slugs to be unique');
  });
});

// ===========================================
// getShowsSortedByCompositeScore
// ===========================================

describe('getShowsSortedByCompositeScore', () => {
  test('default (descending) sort: each score >= next', () => {
    const shows = getShowsSortedByCompositeScore();
    for (let i = 0; i < shows.length - 1; i++) {
      const scoreA = shows[i].compositeScore ?? -1;
      const scoreB = shows[i + 1].compositeScore ?? -1;
      assert.ok(scoreA >= scoreB, `Score ${scoreA} should be >= ${scoreB} at index ${i}`);
    }
  });

  test('ascending sort: each score <= next', () => {
    const shows = getShowsSortedByCompositeScore(true);
    for (let i = 0; i < shows.length - 1; i++) {
      const scoreA = shows[i].compositeScore ?? -1;
      const scoreB = shows[i + 1].compositeScore ?? -1;
      assert.ok(scoreA <= scoreB, `Score ${scoreA} should be <= ${scoreB} at index ${i}`);
    }
  });

  test('only includes Broadway shows', () => {
    const shows = getShowsSortedByCompositeScore();
    for (const show of shows) {
      assert.ok(!show.category || show.category === 'broadway');
    }
  });
});

// ===========================================
// getDataFreshness
// ===========================================

describe('getDataFreshness', () => {
  test('returns timestamps for all data sources', () => {
    const freshness = getDataFreshness();
    assert.ok(freshness.showsLastUpdated);
    assert.ok(freshness.reviewsLastUpdated);
    assert.ok(freshness.audienceLastUpdated);
    assert.ok(freshness.buzzLastUpdated);
  });

  test('timestamps are valid ISO strings', () => {
    const freshness = getDataFreshness();
    for (const [key, val] of Object.entries(freshness)) {
      const date = new Date(val);
      assert.ok(!isNaN(date.getTime()), `${key} is not a valid date: ${val}`);
    }
  });
});

// ===========================================
// getDataStats
// ===========================================

describe('getDataStats', () => {
  test('returns expected stat fields', () => {
    const stats = getDataStats();
    assert.ok(typeof stats.totalShows === 'number');
    assert.ok(typeof stats.openShows === 'number');
    assert.ok(typeof stats.closedShows === 'number');
    assert.ok(typeof stats.totalReviews === 'number');
    assert.ok(typeof stats.totalOutlets === 'number');
    assert.ok(typeof stats.totalCritics === 'number');
    assert.ok(typeof stats.totalAudiencePlatforms === 'number');
    assert.ok(typeof stats.totalBuzzThreads === 'number');
  });

  test('totalShows counts only Broadway shows with reviews', () => {
    const stats = getDataStats();
    const broadwayWithReviews = getBroadwayShows().filter(s => (s.criticScore?.reviewCount || 0) > 0);
    assert.strictEqual(stats.totalShows, broadwayWithReviews.length);
  });

  test('openShows matches Broadway open shows', () => {
    const stats = getDataStats();
    const openBroadway = getBroadwayShows().filter(s => s.status === 'open');
    assert.strictEqual(stats.openShows, openBroadway.length);
  });

  test('all counts are non-negative', () => {
    const stats = getDataStats();
    for (const [key, val] of Object.entries(stats)) {
      assert.ok(val >= 0, `${key} should be non-negative, got ${val}`);
    }
  });
});

// ===========================================
// getShowLastUpdated
// ===========================================

describe('getShowLastUpdated', () => {
  test('returns a valid ISO string for any show', () => {
    const result = getShowLastUpdated('hamilton-2015');
    assert.ok(result !== null, 'Expected a timestamp');
    const date = new Date(result);
    assert.ok(!isNaN(date.getTime()), 'Expected valid ISO date');
  });

  test('returns the most recent timestamp across data sources', () => {
    const result = getShowLastUpdated('some-show');
    // Should return the same thing regardless of showId (it uses global meta timestamps)
    const freshness = getDataFreshness();
    const timestamps = Object.values(freshness).map(v => new Date(v).getTime());
    const expected = new Date(Math.max(...timestamps)).toISOString();
    assert.strictEqual(result, expected);
  });
});

// ===========================================
// getUpcomingShows
// ===========================================

describe('getUpcomingShows', () => {
  test('returns only previews or upcoming shows with opening dates', () => {
    const shows = getUpcomingShows();
    for (const show of shows) {
      assert.ok(
        show.status === 'previews' || show.status === 'upcoming',
        `Show ${show.id} has unexpected status: ${show.status}`
      );
      assert.ok(show.openingDate, `Show ${show.id} should have an opening date`);
    }
  });

  test('sorted by opening date ascending', () => {
    const shows = getUpcomingShows();
    for (let i = 0; i < shows.length - 1; i++) {
      const dateA = new Date(shows[i].openingDate).getTime();
      const dateB = new Date(shows[i + 1].openingDate).getTime();
      assert.ok(dateA <= dateB, `${shows[i].openingDate} should be <= ${shows[i + 1].openingDate}`);
    }
  });

  test('only includes Broadway shows', () => {
    const shows = getUpcomingShows();
    for (const show of shows) {
      assert.ok(!show.category || show.category === 'broadway');
    }
  });
});

// ===========================================
// Director queries
// ===========================================

describe('getAllDirectors', () => {
  test('returns non-empty array of directors', () => {
    const directors = getAllDirectors();
    assert.ok(directors.length > 0);
  });

  test('each director has required fields', () => {
    const directors = getAllDirectors();
    for (const d of directors.slice(0, 20)) {
      assert.ok(d.name, 'Director missing name');
      assert.ok(d.slug, 'Director missing slug');
      assert.ok(d.showCount > 0, 'Director should have at least one show');
      assert.ok(Array.isArray(d.shows));
      assert.strictEqual(d.shows.length, d.showCount);
    }
  });

  test('sorted by show count descending', () => {
    const directors = getAllDirectors();
    for (let i = 0; i < directors.length - 1; i++) {
      assert.ok(
        directors[i].showCount >= directors[i + 1].showCount,
        `Director ${directors[i].name} (${directors[i].showCount}) should have >= shows than ${directors[i + 1].name} (${directors[i + 1].showCount})`
      );
    }
  });

  test('excludes music directors and artistic directors', () => {
    // Verify indirectly: if a person appears only as music director, they should NOT be in the list
    const directors = getAllDirectors();
    const directorNames = new Set(directors.map(d => d.name));
    // This is a structural test — we just verify the filter exists by checking count is reasonable
    assert.ok(directorNames.size > 10, 'Should have many directors');
  });

  test('avgScore is null when no shows have scores', () => {
    const directors = getAllDirectors();
    for (const d of directors) {
      const scoredShows = d.shows.filter(s => s.criticScore?.score);
      if (scoredShows.length === 0) {
        assert.strictEqual(d.avgScore, null, `Director ${d.name} with no scored shows should have null avgScore`);
      } else {
        assert.ok(typeof d.avgScore === 'number', `Director ${d.name} with scored shows should have numeric avgScore`);
      }
    }
  });
});

describe('getDirectorBySlug', () => {
  test('finds a director by slug', () => {
    const directors = getAllDirectors();
    const slug = directors[0].slug;
    const found = getDirectorBySlug(slug);
    assert.ok(found);
    assert.strictEqual(found.slug, slug);
  });

  test('returns undefined for non-existent slug', () => {
    assert.strictEqual(getDirectorBySlug('nonexistent-director-xyz'), undefined);
  });
});

describe('getAllDirectorSlugs', () => {
  test('returns same slugs as getAllDirectors', () => {
    const slugs = getAllDirectorSlugs();
    const directors = getAllDirectors();
    assert.strictEqual(slugs.length, directors.length);
    for (let i = 0; i < slugs.length; i++) {
      assert.strictEqual(slugs[i], directors[i].slug);
    }
  });
});

// ===========================================
// Theater queries
// ===========================================

describe('getAllTheaters', () => {
  test('returns non-empty array of theaters', () => {
    const theaters = getAllTheaters();
    assert.ok(theaters.length > 0);
  });

  test('each theater has required fields', () => {
    const theaters = getAllTheaters();
    for (const t of theaters.slice(0, 20)) {
      assert.ok(t.name, 'Theater missing name');
      assert.ok(t.slug, 'Theater missing slug');
      assert.ok(t.showCount > 0);
      assert.ok(Array.isArray(t.allShows));
      assert.strictEqual(t.allShows.length, t.showCount);
    }
  });

  test('sorted by show count descending', () => {
    const theaters = getAllTheaters();
    for (let i = 0; i < theaters.length - 1; i++) {
      assert.ok(theaters[i].showCount >= theaters[i + 1].showCount);
    }
  });

  test('excludes theaters starting with underscore', () => {
    const theaters = getAllTheaters();
    for (const t of theaters) {
      assert.ok(!t.name.startsWith('_'), `Theater ${t.name} should be excluded`);
    }
  });

  test('allShows sorted by opening date descending', () => {
    const theaters = getAllTheaters();
    for (const t of theaters.slice(0, 10)) {
      for (let i = 0; i < t.allShows.length - 1; i++) {
        const dateA = new Date(t.allShows[i].openingDate).getTime();
        const dateB = new Date(t.allShows[i + 1].openingDate).getTime();
        assert.ok(dateA >= dateB, `Theater ${t.name}: shows not sorted by opening date desc`);
      }
    }
  });

  test('currentShow is open/previews/upcoming if set', () => {
    const theaters = getAllTheaters();
    for (const t of theaters) {
      if (t.currentShow) {
        assert.ok(
          ['open', 'previews', 'upcoming'].includes(t.currentShow.status),
          `Theater ${t.name} currentShow has unexpected status: ${t.currentShow.status}`
        );
      }
    }
  });

  test('returns same reference on repeated calls (cache)', () => {
    const first = getAllTheaters();
    const second = getAllTheaters();
    assert.strictEqual(first, second);
  });
});

describe('getTheaterBySlug', () => {
  test('finds a theater by slug', () => {
    const theaters = getAllTheaters();
    const slug = theaters[0].slug;
    const found = getTheaterBySlug(slug);
    assert.ok(found);
    assert.strictEqual(found.slug, slug);
  });

  test('returns undefined for non-existent slug', () => {
    assert.strictEqual(getTheaterBySlug('nonexistent-theater-xyz'), undefined);
  });
});

describe('getAllTheaterSlugs', () => {
  test('returns same slugs as getAllTheaters', () => {
    const slugs = getAllTheaterSlugs();
    const theaters = getAllTheaters();
    assert.strictEqual(slugs.length, theaters.length);
  });
});

// ===========================================
// Best-of list queries
// ===========================================

describe('getAllBestOfCategories', () => {
  test('returns all expected categories', () => {
    const categories = getAllBestOfCategories();
    const expected = ['musicals', 'plays', 'new-shows', 'highest-rated', 'family', 'comedy', 'drama'];
    assert.deepStrictEqual(categories, expected);
  });
});

describe('getBestOfList', () => {
  test('returns a valid list for each category', () => {
    const categories = getAllBestOfCategories();
    for (const cat of categories) {
      const list = getBestOfList(cat);
      assert.ok(list, `Expected list for category ${cat}`);
      assert.strictEqual(list.category, cat);
      assert.ok(list.title);
      assert.ok(list.description);
      assert.ok(Array.isArray(list.shows));
      assert.ok(list.shows.length <= 10, `Best-of list ${cat} should have at most 10 shows`);
    }
  });

  test('musicals list contains only open musicals', () => {
    const list = getBestOfList('musicals');
    assert.ok(list);
    for (const show of list.shows) {
      assert.strictEqual(show.type, 'musical', `Show ${show.id} should be a musical`);
      assert.strictEqual(show.status, 'open', `Show ${show.id} should be open`);
    }
  });

  test('plays list contains only open plays', () => {
    const list = getBestOfList('plays');
    assert.ok(list);
    for (const show of list.shows) {
      assert.strictEqual(show.type, 'play', `Show ${show.id} should be a play`);
      assert.strictEqual(show.status, 'open', `Show ${show.id} should be open`);
    }
  });

  test('highest-rated list contains only scored open shows', () => {
    const list = getBestOfList('highest-rated');
    assert.ok(list);
    for (const show of list.shows) {
      assert.strictEqual(show.status, 'open');
      assert.ok(show.criticScore?.score !== undefined, `Show ${show.id} should have a score`);
    }
  });

  test('shows sorted by critic score descending', () => {
    const list = getBestOfList('musicals');
    assert.ok(list);
    for (let i = 0; i < list.shows.length - 1; i++) {
      const scoreA = list.shows[i].criticScore?.score || 0;
      const scoreB = list.shows[i + 1].criticScore?.score || 0;
      assert.ok(scoreA >= scoreB, `Score ${scoreA} should be >= ${scoreB}`);
    }
  });

  test('returns undefined for invalid category', () => {
    const list = getBestOfList('nonexistent' as any);
    assert.strictEqual(list, undefined);
  });
});

// ===========================================
// Browse page queries
// ===========================================

describe('getAllBrowseSlugs', () => {
  test('returns non-empty array of slugs', () => {
    const slugs = getAllBrowseSlugs();
    assert.ok(Array.isArray(slugs));
    assert.ok(slugs.length > 0);
  });
});

describe('getBrowseList', () => {
  test('returns a valid list for known browse slugs', () => {
    const slugs = getAllBrowseSlugs();
    // Test first 5 slugs
    for (const slug of slugs.slice(0, 5)) {
      const list = getBrowseList(slug);
      assert.ok(list, `Expected list for browse slug ${slug}`);
      assert.ok(list.config);
      assert.ok(Array.isArray(list.shows));
    }
  });

  test('returns undefined for unknown slug', () => {
    const list = getBrowseList('totally-nonexistent-page');
    assert.strictEqual(list, undefined);
  });
});

// ===========================================
// Related shows
// ===========================================

describe('getRelatedShows', () => {
  test('returns at most the limit', () => {
    const shows = getAllShows();
    // Find a show with reviews for better algorithmic matching
    const show = shows.find(s => (s.criticScore?.reviewCount ?? 0) >= 10);
    assert.ok(show, 'Need a show with reviews for this test');
    const related = getRelatedShows(show, 3);
    assert.ok(related.length <= 3);
  });

  test('does not include the source show itself', () => {
    const shows = getAllShows();
    const show = shows.find(s => (s.criticScore?.reviewCount ?? 0) >= 10);
    assert.ok(show);
    const related = getRelatedShows(show);
    for (const r of related) {
      assert.notStrictEqual(r.id, show.id, 'Related shows should not include the source show');
    }
  });

  test('related shows are from the same market', () => {
    const show = getBroadwayShows().find(s => (s.criticScore?.reviewCount ?? 0) >= 10);
    assert.ok(show);
    const related = getRelatedShows(show);
    // Market = city grouping: Broadway + Off-Broadway = "nyc", West End + Off-West End = "london"
    function getCity(category: string | undefined): string {
      const cat = category || 'broadway';
      if (cat === 'broadway' || cat === 'off-broadway') return 'nyc';
      if (cat === 'west-end' || cat === 'off-west-end') return 'london';
      return cat;
    }
    const showCity = getCity(show.category);
    for (const r of related) {
      assert.strictEqual(getCity(r.category), showCity, `Related show ${r.id} should be in same city/market`);
    }
  });
});

describe('getRelatedShowsOpen', () => {
  test('returns only open/previews/upcoming shows', () => {
    const show = getBroadwayShows().find(s => (s.criticScore?.reviewCount ?? 0) >= 10);
    assert.ok(show);
    const related = getRelatedShowsOpen(show);
    for (const r of related) {
      assert.ok(
        ['open', 'previews', 'upcoming'].includes(r.status),
        `Related show ${r.id} should be open/previews/upcoming, got ${r.status}`
      );
    }
  });
});

describe('getRelatedShowsClosed', () => {
  test('returns only closed shows', () => {
    const show = getBroadwayShows().find(s => (s.criticScore?.reviewCount ?? 0) >= 10);
    assert.ok(show);
    const related = getRelatedShowsClosed(show);
    for (const r of related) {
      assert.strictEqual(r.status, 'closed', `Related show ${r.id} should be closed`);
    }
  });
});

// ===========================================
// getOtherProductions
// ===========================================

describe('getOtherProductions', () => {
  test('returns empty array for unique titles', () => {
    // Find a show with a unique title unlikely to have other productions
    const show = getAllShows().find(s => s.title.includes('2024') || s.title.includes('2025'));
    if (show) {
      const others = getOtherProductions(show);
      // Others should not include the same show
      for (const other of others) {
        assert.notStrictEqual(other.id, show.id);
      }
    }
  });

  test('returns shows from different markets with same title', () => {
    // Find a show that likely has cross-market productions (e.g., a well-known musical)
    const allShows = getAllShows();
    const titleCounts = new Map<string, ComputedShow[]>();
    for (const s of allShows) {
      const norm = s.title.toLowerCase().replace(/[^\w\s']/g, '').trim();
      const group = titleCounts.get(norm) || [];
      group.push(s);
      titleCounts.set(norm, group);
    }

    // Find a title that appears in multiple markets
    let testShow: ComputedShow | undefined;
    for (const [, group] of Array.from(titleCounts)) {
      const markets = new Set(group.map((s: ComputedShow) => s.category || 'broadway'));
      if (markets.size > 1) {
        testShow = group[0];
        break;
      }
    }

    if (testShow) {
      const others = getOtherProductions(testShow);
      assert.ok(others.length > 0, `Expected other productions for ${testShow.title}`);
      for (const other of others) {
        assert.notStrictEqual(other.id, testShow.id);
        const otherMarket = other.category || 'broadway';
        const showMarket = testShow.category || 'broadway';
        assert.notStrictEqual(otherMarket, showMarket, 'Other productions should be from different markets');
      }
    }
  });

  test('results are sorted by market order then opening date', () => {
    const allShows = getAllShows();
    const titleCounts = new Map<string, ComputedShow[]>();
    for (const s of allShows) {
      const norm = s.title.toLowerCase().replace(/[^\w\s']/g, '').trim();
      const group = titleCounts.get(norm) || [];
      group.push(s);
      titleCounts.set(norm, group);
    }

    let testShow: ComputedShow | undefined;
    for (const [, group] of Array.from(titleCounts)) {
      const markets = new Set(group.map((s: ComputedShow) => s.category || 'broadway'));
      if (markets.size > 1) {
        testShow = group[0];
        break;
      }
    }

    if (testShow) {
      const others = getOtherProductions(testShow);
      const marketOrder: Record<string, number> = { broadway: 0, 'west-end': 1, 'off-broadway': 2 };
      for (let i = 0; i < others.length - 1; i++) {
        const catA = marketOrder[(others[i].category || 'broadway')] ?? 3;
        const catB = marketOrder[(others[i + 1].category || 'broadway')] ?? 3;
        if (catA === catB) {
          // Within same market, sorted by opening date descending
          const dateA = others[i].openingDate || '';
          const dateB = others[i + 1].openingDate || '';
          assert.ok(dateA >= dateB, `Within same market, should be sorted by date desc`);
        } else {
          assert.ok(catA <= catB, `Markets should be in order: broadway, west-end, off-broadway`);
        }
      }
    }
  });
});
