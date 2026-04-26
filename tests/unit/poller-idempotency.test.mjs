import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findInFlightPollerForShow,
  buildTitleSuffix,
  isActiveStatus,
} from '../../scripts/lib/poller-idempotency.js';

const fixture = [
  {
    databaseId: 1,
    status: 'in_progress',
    displayTitle: 'Opening Night Poller — joe-turners-come-and-gone-2026',
    createdAt: '2026-04-25T22:30:00Z',
  },
  {
    databaseId: 2,
    status: 'in_progress',
    displayTitle: 'Opening Night Poller — auto',
    createdAt: '2026-04-25T22:31:00Z',
  },
  {
    databaseId: 3,
    status: 'queued',
    displayTitle: 'Opening Night Poller — joe-turners-come-and-gone-2026',
    createdAt: '2026-04-25T22:32:00Z',
  },
  {
    databaseId: 4,
    status: 'completed',
    displayTitle: 'Opening Night Poller — joe-turners-come-and-gone-2026',
    createdAt: '2026-04-25T22:00:00Z',
  },
  {
    databaseId: 5,
    status: 'in_progress',
    displayTitle: 'Opening Night Poller', // pre-run-name format
    createdAt: '2026-04-25T22:33:00Z',
  },
  {
    databaseId: 6,
    status: 'in_progress',
    displayTitle: 'Opening Night Poller — beaches-2026',
    createdAt: '2026-04-25T22:34:00Z',
  },
];

test('finds in_progress poller for target show', () => {
  const m = findInFlightPollerForShow(fixture, 'joe-turners-come-and-gone-2026');
  assert.equal(m && m.databaseId, 1);
});

test('returns the FIRST active match when multiple exist (in_progress before queued)', () => {
  const m = findInFlightPollerForShow(fixture, 'joe-turners-come-and-gone-2026');
  assert.equal(m && m.status, 'in_progress');
});

test('queued status counts as active', () => {
  const onlyQueued = fixture.filter(r => r.status !== 'in_progress');
  const m = findInFlightPollerForShow(onlyQueued, 'joe-turners-come-and-gone-2026');
  assert.equal(m && m.databaseId, 3);
});

test('completed runs are ignored', () => {
  const onlyCompleted = [fixture[3]];
  assert.equal(findInFlightPollerForShow(onlyCompleted, 'joe-turners-come-and-gone-2026'), null);
});

test('different show does not false-match', () => {
  assert.equal(findInFlightPollerForShow(fixture, 'no-such-show-2026'), null);
});

test('finds run for a different show in the same fixture', () => {
  const m = findInFlightPollerForShow(fixture, 'beaches-2026');
  assert.equal(m && m.databaseId, 6);
});

test('pre-run-name displayTitle ("Opening Night Poller") never matches', () => {
  const onlyBare = [fixture[4]];
  assert.equal(findInFlightPollerForShow(onlyBare, 'joe-turners-come-and-gone-2026'), null);
});

test('suffix match prevents prefix collisions (the-bear-2025 vs the-bear-bites-back-2025)', () => {
  // CRITICAL: a substring match would have falsely flagged the longer slug.
  // Suffix match anchors to the em dash + space + slug.
  const sample = [
    {
      databaseId: 100,
      status: 'in_progress',
      displayTitle: 'Opening Night Poller — the-bear-bites-back-2025',
      createdAt: '2026-04-25T22:00:00Z',
    },
  ];
  assert.equal(findInFlightPollerForShow(sample, 'the-bear-2025'), null);
  const found = findInFlightPollerForShow(sample, 'the-bear-bites-back-2025');
  assert.equal(found && found.databaseId, 100);
});

test('non-array runs returns null (defensive)', () => {
  assert.equal(findInFlightPollerForShow(null, 'x'), null);
  assert.equal(findInFlightPollerForShow(undefined, 'x'), null);
});

test('empty showId returns null (defensive — would otherwise match every run)', () => {
  assert.equal(findInFlightPollerForShow(fixture, ''), null);
  assert.equal(findInFlightPollerForShow(fixture, null), null);
});

test('runs with non-string displayTitle are skipped', () => {
  const weird = [
    { databaseId: 1, status: 'in_progress', displayTitle: null },
    { databaseId: 2, status: 'in_progress', displayTitle: undefined },
    { databaseId: 3, status: 'in_progress' },
  ];
  assert.equal(findInFlightPollerForShow(weird, 'whatever-2026'), null);
});

test('buildTitleSuffix uses em dash + space separator', () => {
  assert.equal(buildTitleSuffix('joe-turners-come-and-gone-2026'), '— joe-turners-come-and-gone-2026');
});

test('isActiveStatus only matches in_progress and queued', () => {
  assert.equal(isActiveStatus('in_progress'), true);
  assert.equal(isActiveStatus('queued'), true);
  assert.equal(isActiveStatus('completed'), false);
  assert.equal(isActiveStatus('cancelled'), false);
  assert.equal(isActiveStatus('failure'), false);
  assert.equal(isActiveStatus(undefined), false);
});
