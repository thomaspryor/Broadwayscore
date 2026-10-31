import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// BRO-3539: a dateless incomplete:true event must be upgraded in place once a
// later scrape finds the real date, not duplicated. Uses the REAL mergeEvents.
const require = createRequire(import.meta.url);
const { mergeEvents, validateEvent } = require('../../scripts/scrape-cast-changes.js');
const { findDatelessIncompleteDupe } = require('../../scripts/lib/cast-changes-filters.js');

const mk = (over) => ({ type: 'arrival', name: 'Jane Doe', role: 'Elphaba', sourceType: 'article', addedDate: '2026-10-01', ...over });
const store = (upcoming) => ({ shows: { 'test-show': { currentCast: [], upcoming, history: [] } } });

test('dated arrival upgrades the dateless incomplete row in place', () => {
  const dateless = mk({});
  assert.equal(validateEvent(dateless), true);
  assert.equal(dateless.incomplete, true);
  const existing = store([dateless]);
  const dated = mk({ date: '2026-11-03', addedDate: '2026-10-13' });
  validateEvent(dated);
  const changes = mergeEvents(existing, { 'test-show': [dated] }, 'articles');
  const up = existing.shows['test-show'].upcoming;
  assert.equal(up.length, 1);
  assert.equal(up[0].date, '2026-11-03');
  assert.equal(up[0].incomplete, undefined);
  assert.equal(up[0].addedDate, '2026-10-01', 'first-seen addedDate stays pinned');
  assert.equal(changes[0].type, 'upgraded-dated');
});

test('incoming dateless incomplete row is dropped when a dated twin exists', () => {
  const existing = store([mk({ date: '2026-11-03' })]);
  const dateless = mk({});
  validateEvent(dateless);
  const changes = mergeEvents(existing, { 'test-show': [dateless] }, 'articles');
  assert.equal(existing.shows['test-show'].upcoming.length, 1);
  assert.equal(changes.length, 0);
});

test('different role or person is not matched', () => {
  const up = [mk({ incomplete: true })];
  assert.equal(findDatelessIncompleteDupe(up, mk({ date: '2026-11-03', role: 'Glinda' })), null);
  assert.equal(findDatelessIncompleteDupe(up, mk({ date: '2026-11-03', name: 'Other' })), null);
  assert.equal(findDatelessIncompleteDupe(up, mk({ date: '2026-11-03', type: 'departure' })), null);
});
