/**
 * "Closed Shows You Might Like" fallback (Other Desert Cities 2026 bug).
 *
 * A show with no lookup entry in data/related-shows.json (previews / <5 reviews) falls back
 * to getRelatedShowsAlgorithmic(). It used to take a global top-N and THEN filter by status,
 * so open shows (+3 boost) crowded the cut and the closed pool came back with ONE show.
 * The status filter must run before the cut, and the closed pool must favor shows critics liked.
 *
 * Run: npx tsx --test tests/unit/related-shows-fallback.test.ts
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: structural — asserts pool size, status purity and a score floor over whatever the live shows.json holds; no factual value is pinned.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getAllShows, getRelatedShowsAlgorithmic, getRelatedShowsClosed, getRelatedShowsOpen } from '../../src/lib/data-core';

const relatedShowsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/related-shows.json'), 'utf8')) as { shows?: Record<string, unknown> };
const all = getAllShows();
// Broadway shows that have NO curated lookup entry and no reviews of their own, i.e. the
// exact shape of the reported bug. Falls back to any previews/upcoming Broadway show.
const sources = all.filter(s => s.category === 'broadway' && (s.status === 'previews' || s.status === 'upcoming') && (s.criticScore?.reviewCount ?? 0) < 5).slice(0, 5);

describe('related-shows algorithmic fallback', () => {
  test('there is something to test against', () => {
    assert.ok(sources.length > 0, 'no unreviewed Broadway previews/upcoming show in live data');
  });

  for (const show of sources) {
    test(`${show.id}: closed pool is full, closed-only and not junk`, () => {
      const closed = getRelatedShowsClosed(show);
      assert.equal(closed.length, 6, `expected 6 closed recs, got ${closed.length}`);
      for (const s of closed) {
        assert.equal(s.status, 'closed');
        const sc = s.criticScore?.score;
        assert.ok(sc == null || sc >= 60, `${s.id} scored ${sc}, below the closed-pool floor`);
      }
    });

    test(`${show.id}: open pool is full and active-only`, () => {
      const open = getRelatedShowsOpen(show);
      assert.equal(open.length, 6);
      for (const s of open) assert.ok(['open', 'previews', 'upcoming'].includes(s.status), `${s.id} is ${s.status}`);
    });
  }

  // BRO-5122: curated lists (data/related-shows.json) go stale when a curated rec
  // changes status; the curated path must top up from the algorithmic pool.
  test('every Broadway show with a curated open/closed list still gets a full pool', () => {
    const curated = all.filter(s => s.category === 'broadway' && relatedShowsData.shows?.[s.id]);
    assert.ok(curated.length > 0, 'no curated Broadway entries in data/related-shows.json');
    const short: string[] = [];
    for (const show of curated) {
      const open = getRelatedShowsOpen(show);
      const closed = getRelatedShowsClosed(show);
      if (open.length !== 6) short.push(`${show.id}: open ${open.length}`);
      if (closed.length !== 6) short.push(`${show.id}: closed ${closed.length}`);
      if (new Set(open.map(s => s.id)).size !== open.length) short.push(`${show.id}: duplicate open rec`);
      if (new Set(closed.map(s => s.id)).size !== closed.length) short.push(`${show.id}: duplicate closed rec`);
    }
    assert.deepEqual(short, []);
  });

  test('statusFilter is applied before the cut (limit=1 still returns the best closed show)', () => {
    const closed = getRelatedShowsAlgorithmic(sources[0], 1, 'closed');
    assert.equal(closed.length, 1);
    assert.equal(closed[0].status, 'closed');
  });
});
