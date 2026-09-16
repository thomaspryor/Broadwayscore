// BRO-3622: /off-broadway "All" status filter rage-clicked because clicking
// it while the closed-shows archive was still fetching showed a misleading
// "No shows found" card instead of a loading state — looked broken/stuck.
// See src/lib/show-list-empty-state.ts for the shared fix (also wired into
// HomePageClient, which already had this guard; Off-Broadway never got it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getShowListEmptyState } from '../../src/lib/show-list-empty-state.ts';

test('archive still loading + All filter + zero results so far -> loading, not empty', () => {
  assert.equal(
    getShowListEmptyState({ filteredCount: 0, archiveLoaded: false, statusFilter: 'all' }),
    'loading',
  );
});

test('archive still loading + Closed filter + zero results so far -> loading', () => {
  assert.equal(
    getShowListEmptyState({ filteredCount: 0, archiveLoaded: false, statusFilter: 'closed' }),
    'loading',
  );
});

test('archive loaded + All filter + zero results -> genuinely empty', () => {
  assert.equal(
    getShowListEmptyState({ filteredCount: 0, archiveLoaded: true, statusFilter: 'all' }),
    'empty',
  );
});

test('status filter that never needs the archive -> empty, not loading', () => {
  assert.equal(
    getShowListEmptyState({ filteredCount: 0, archiveLoaded: false, statusFilter: 'open' }),
    'empty',
  );
});

test('results already present -> none, regardless of archive state', () => {
  assert.equal(
    getShowListEmptyState({ filteredCount: 3, archiveLoaded: false, statusFilter: 'all' }),
    'none',
  );
});
