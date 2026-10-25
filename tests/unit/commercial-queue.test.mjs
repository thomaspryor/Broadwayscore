// Unit tests for scripts/lib/commercial-queue.js.
// Per feedback_test_extraction_pattern.md — require() the real lib.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  filterNewBroadwayShows,
  filterPreOpeningShows,
  filterClosingTbdShows,
  addToQueue,
} = require('../../scripts/lib/commercial-queue');

describe('filterNewBroadwayShows (category-race fix)', () => {
  it('excludes a newly-discovered show whose category is not yet set', () => {
    // The exact regression: a show discovered this run, category still
    // undefined because the classification step hasn't landed yet.
    const shows = [{ slug: 'race-show', id: 'race-show', category: undefined }];
    const result = filterNewBroadwayShows(['race-show'], shows);
    assert.deepEqual(result, []);
  });

  it('includes the same show once category is explicitly broadway', () => {
    const shows = [{ slug: 'race-show', id: 'race-show', category: 'broadway' }];
    const result = filterNewBroadwayShows(['race-show'], shows);
    assert.deepEqual(result, ['race-show']);
  });

  it('excludes an off-broadway show', () => {
    const shows = [{ slug: 'ob-show', id: 'ob-show', category: 'off-broadway' }];
    const result = filterNewBroadwayShows(['ob-show'], shows);
    assert.deepEqual(result, []);
  });

  it('excludes a slug that does not resolve to any show', () => {
    const result = filterNewBroadwayShows(['ghost-slug'], []);
    assert.deepEqual(result, []);
  });

  it('matches by id when slug is absent', () => {
    const shows = [{ id: 'by-id-show', category: 'broadway' }];
    const result = filterNewBroadwayShows(['by-id-show'], shows);
    assert.deepEqual(result, ['by-id-show']);
  });

  it('resolves to the slug-owning show when another show\'s id collides with that slug (ship-check finding)', () => {
    // Show A's slug and Show B's id are the same string. A single map keyed
    // by both slug and id would let whichever show inserts last silently
    // overwrite the other's entry. Slug lookup must take deterministic
    // priority regardless of shows[] iteration order.
    const shows = [
      { slug: 'collision', id: 'collision-2026', category: 'off-broadway' },
      { slug: 'other-show', id: 'collision', category: 'broadway' },
    ];
    const result = filterNewBroadwayShows(['collision'], shows);
    assert.deepEqual(result, [], 'must resolve to the off-broadway show that owns the slug, not the show whose id happens to match');
  });
});

describe('filterPreOpeningShows (unchanged isCommercialScope behavior)', () => {
  it('includes a broadway show opening tomorrow with no commercial entry', () => {
    const shows = [{ slug: 'opens-tmrw', openingDate: '2026-08-01', category: 'broadway' }];
    const result = filterPreOpeningShows(shows, { shows: {} }, '2026-08-01');
    assert.deepEqual(result, ['opens-tmrw']);
  });

  it('still includes a pre-existing show with unset category (not a same-run race)', () => {
    // Pre-opening shows are NOT filtered from this-run discovery — a show
    // with legitimately-unset category (long-standing convention) must
    // still pass, proving this filter's isCommercialScope() call is
    // intentionally unchanged from before the category-race fix.
    const shows = [{ slug: 'long-standing', openingDate: '2026-08-01', category: undefined }];
    const result = filterPreOpeningShows(shows, { shows: {} }, '2026-08-01');
    assert.deepEqual(result, ['long-standing']);
  });

  it('excludes a show that already has a non-TBD commercial designation', () => {
    const shows = [{ slug: 'already-covered', openingDate: '2026-08-01', category: 'broadway' }];
    const commercial = { shows: { 'already-covered': { designation: 'Flop' } } };
    const result = filterPreOpeningShows(shows, commercial, '2026-08-01');
    assert.deepEqual(result, []);
  });

  it('excludes off-broadway/west-end shows', () => {
    const shows = [{ slug: 'we-show', openingDate: '2026-08-01', category: 'west-end' }];
    const result = filterPreOpeningShows(shows, { shows: {} }, '2026-08-01');
    assert.deepEqual(result, []);
  });

  it('finds commercial coverage keyed by id even though the show has a different slug (ship-check finding)', () => {
    const shows = [{ slug: 'the-lost-boys', id: 'the-lost-boys-2026', openingDate: '2026-08-01', category: 'broadway' }];
    const commercial = { shows: { 'the-lost-boys-2026': { designation: 'Flop' } } };
    const result = filterPreOpeningShows(shows, commercial, '2026-08-01');
    assert.deepEqual(result, [], 'commercial.json keyed by id must still be recognized as coverage');
  });
});

describe('filterClosingTbdShows (unchanged isCommercialScope behavior)', () => {
  it('includes a closed broadway show with no commercial entry', () => {
    const shows = [{ slug: 'just-closed', status: 'closed', closingDate: '2026-07-15', category: 'broadway' }];
    const result = filterClosingTbdShows(shows, { shows: {} }, '2026-07-10', '2026-07-19');
    assert.deepEqual(result, ['just-closed']);
  });

  it('excludes a closed show outside the date window', () => {
    const shows = [{ slug: 'old-close', status: 'closed', closingDate: '2026-01-01', category: 'broadway' }];
    const result = filterClosingTbdShows(shows, { shows: {} }, '2026-07-10', '2026-07-19');
    assert.deepEqual(result, []);
  });

  it('excludes a closed show already designated', () => {
    const shows = [{ slug: 'closed-and-done', status: 'closed', closingDate: '2026-07-15', category: 'broadway' }];
    const commercial = { shows: { 'closed-and-done': { designation: 'Windfall' } } };
    const result = filterClosingTbdShows(shows, commercial, '2026-07-10', '2026-07-19');
    assert.deepEqual(result, []);
  });

  it('includes a closed show still marked TBD', () => {
    const shows = [{ slug: 'still-tbd', status: 'closed', closingDate: '2026-07-15', category: 'broadway' }];
    const commercial = { shows: { 'still-tbd': { designation: 'TBD' } } };
    const result = filterClosingTbdShows(shows, commercial, '2026-07-10', '2026-07-19');
    assert.deepEqual(result, ['still-tbd']);
  });

  it('finds commercial coverage keyed by id even though the show has a different slug (ship-check finding)', () => {
    const shows = [{ slug: 'joe-turners-come-and-gone', id: 'joe-turners-come-and-gone-2026', status: 'closed', closingDate: '2026-07-15', category: 'broadway' }];
    const commercial = { shows: { 'joe-turners-come-and-gone-2026': { designation: 'Windfall' } } };
    const result = filterClosingTbdShows(shows, commercial, '2026-07-10', '2026-07-19');
    assert.deepEqual(result, [], 'commercial.json keyed by id must still be recognized as coverage');
  });
});

describe('addToQueue', () => {
  it('dedupes shows and tags triggers for every slug passed in', () => {
    const queue = { shows: ['existing'], triggers: { existing: 'closing' } };
    const next = addToQueue(queue, ['existing', 'new-one'], 'pre-opening');
    assert.deepEqual(next.shows, ['existing', 'new-one']);
    assert.equal(next.triggers['new-one'], 'pre-opening');
    assert.equal(next.triggers.existing, 'pre-opening', 'matches original heredoc: trigger overwritten for every input slug, not just new ones');
  });

  it('leaves an unrelated pre-existing trigger untouched', () => {
    const queue = { shows: ['unrelated', 'existing'], triggers: { unrelated: 'closing', existing: 'closing' } };
    const next = addToQueue(queue, ['existing'], 'pre-opening');
    assert.equal(next.triggers.unrelated, 'closing', 'a slug not in this call\'s input list keeps its trigger');
    assert.equal(next.triggers.existing, 'pre-opening');
  });

  it('handles an empty starting queue', () => {
    const next = addToQueue({}, ['a'], 'new-show');
    assert.deepEqual(next.shows, ['a']);
    assert.equal(next.triggers.a, 'new-show');
  });
});

// BRO-4990: self-healing sweep + weekly coverage report.
const {
  COMMERCIAL_RESEARCH_FLOOR,
  weeksRun,
  filterUncoveredClosedShows,
  computeCoverageBySeason,
} = require('../../scripts/lib/commercial-queue');

const bw = (o) => ({ category: 'broadway', status: 'closed', ...o });

describe('filterUncoveredClosedShows (BRO-4990 sweep)', () => {
  const TODAY = '2026-10-10';

  it('selects a closed 2021 show with no record that ran 8+ weeks', () => {
    const shows = [bw({ slug: 'company-2021', id: 'company-2021', openingDate: '2021-12-09', closingDate: '2022-07-31' })];
    assert.deepEqual(filterUncoveredClosedShows(shows, { shows: {} }, TODAY), ['company-2021']);
  });

  it('never selects a show that opened before the owner-approved 2020 floor', () => {
    assert.equal(COMMERCIAL_RESEARCH_FLOOR, '2020-01-01');
    const shows = [bw({ slug: 'old', openingDate: '2019-12-31', closingDate: '2021-01-01' })];
    assert.deepEqual(filterUncoveredClosedShows(shows, { shows: {} }, TODAY), []);
  });

  it('skips runs under 8 weeks, shows with any record (slug or id key), non-Broadway, and running shows', () => {
    const shows = [
      bw({ slug: 'short', openingDate: '2022-01-01', closingDate: '2022-02-01' }),
      bw({ slug: 'has-slug', openingDate: '2022-01-01', closingDate: '2022-12-01' }),
      bw({ slug: 'slug-x', id: 'has-id-2022', openingDate: '2022-01-01', closingDate: '2022-12-01' }),
      bw({ slug: 'ob', category: 'off-broadway', openingDate: '2022-01-01', closingDate: '2022-12-01' }),
      bw({ slug: 'running', status: 'open', openingDate: '2022-01-01' }),
    ];
    const commercial = { shows: { 'has-slug': { designation: 'TBD' }, 'has-id-2022': { designation: 'Flop' } } };
    assert.deepEqual(filterUncoveredClosedShows(shows, commercial, TODAY), []);
  });
});

describe('weeksRun', () => {
  it('measures opening to closing, or to today while running; null before opening', () => {
    assert.equal(weeksRun({ openingDate: '2022-01-01', closingDate: '2022-01-15' }, '2026-01-01'), 2);
    assert.equal(weeksRun({ openingDate: '2026-01-01' }, '2026-01-29'), 4);
    assert.equal(weeksRun({ openingDate: '2026-02-01' }, '2026-01-29'), null);
  });
});

describe('computeCoverageBySeason (BRO-4990 weekly health)', () => {
  it('buckets by opening-date season and counts eligible / covered / resolved', () => {
    const shows = [
      bw({ slug: 'a', openingDate: '2021-10-01', closingDate: '2022-06-01' }), // 2021-2022, uncovered
      bw({ slug: 'b', openingDate: '2021-11-01', closingDate: '2022-06-01' }), // covered, TBD
      bw({ slug: 'c', openingDate: '2022-08-01', closingDate: '2023-06-01' }), // 2022-2023, resolved
      bw({ slug: 'd', openingDate: '2022-08-01', closingDate: '2022-08-20' }), // too short: in scope, not eligible
    ];
    const commercial = { shows: { b: { designation: 'TBD' }, c: { designation: 'Flop' } } };
    const rows = computeCoverageBySeason(shows, commercial, '2026-10-10');
    assert.deepEqual(rows.map(r => [r.season, r.inScope, r.eligible, r.covered, r.resolved, r.uncovered]), [
      ['2021-2022', 2, 2, 1, 0, ['a']],
      ['2022-2023', 2, 1, 1, 1, []],
    ]);
  });

  it('counts a researched show waiting in pending review separately from uncovered', () => {
    const shows = [bw({ slug: 'a', openingDate: '2021-10-01', closingDate: '2022-06-01' })];
    const [row] = computeCoverageBySeason(shows, { shows: {} }, '2026-10-10', { pendingShows: { a: { requiresHumanReview: true } } });
    assert.deepEqual([row.covered, row.pendingReview, row.uncovered], [0, ['a'], []]);
  });

  it('counts a noData pass as still uncovered', () => {
    const shows = [bw({ slug: 'a', openingDate: '2021-10-01', closingDate: '2022-06-01' })];
    const [row] = computeCoverageBySeason(shows, { shows: {} }, '2026-10-10', { pendingShows: { a: { requiresHumanReview: true, noData: true } } });
    assert.deepEqual([row.pendingReview, row.uncovered], [[], ['a']]);
  });
});
