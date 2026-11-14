import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findInFlightPollerForShow,
  findInFlightTargetedPollerForShow,
  findInFlightAutoPoller,
  buildTitleSuffix,
  isActiveStatus,
  isActiveRun,
  AUTO_RUN_SUFFIX,
  ACTIVE_STATUSES,
  targetedShowIdFromTitle,
  activeTargetedPollerShows,
  partitionByActiveTargetedPoller,
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

test('different show falls back to auto-coverage when an auto run is in fixture', () => {
  // The shared fixture intentionally includes an auto run (id=2). For a show
  // not in the fixture, the targeted match misses but auto-coverage applies —
  // an in-flight auto poller iterates ALL today's openings, so it covers the
  // unrelated show too. (Pre-/ship-check this returned null; the new behavior
  // closes the auto-vs-targeted push race.)
  const m = findInFlightPollerForShow(fixture, 'no-such-show-2026');
  assert.equal(m && m.databaseId, 2);
});

test('different show without auto in fixture returns null', () => {
  const noAuto = fixture.filter(r => !r.displayTitle?.endsWith('— auto'));
  assert.equal(findInFlightPollerForShow(noAuto, 'no-such-show-2026'), null);
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

test('isActiveStatus matches all GitHub Actions active lifecycle states', () => {
  // Per /ship-check 2026-04-26 (Codex finding): the prior in_progress|queued-only
  // check was too narrow. GitHub transitions runs through waiting/pending/requested
  // before in_progress, and deploy-on-data-change.yml already treats `waiting` as
  // active. Pollers in any of these states will eventually write to data/.
  assert.equal(isActiveStatus('in_progress'), true);
  assert.equal(isActiveStatus('queued'), true);
  assert.equal(isActiveStatus('waiting'), true);
  assert.equal(isActiveStatus('pending'), true);
  assert.equal(isActiveStatus('requested'), true);
  // Terminal states must NOT count as active.
  assert.equal(isActiveStatus('completed'), false);
  assert.equal(isActiveStatus('cancelled'), false);
  assert.equal(isActiveStatus('failure'), false);
  assert.equal(isActiveStatus('success'), false);
  assert.equal(isActiveStatus('skipped'), false);
  assert.equal(isActiveStatus('timed_out'), false);
  assert.equal(isActiveStatus(undefined), false);
  assert.equal(isActiveStatus(null), false);
  assert.equal(isActiveStatus(''), false);
});

test('ACTIVE_STATUSES is the canonical set used by isActiveStatus', () => {
  // Defensive: keep the exported Set in sync with the predicate.
  for (const s of ACTIVE_STATUSES) {
    assert.equal(isActiveStatus(s), true, `expected ${s} to be active`);
  }
});

// === P0-1 — auto-poller coverage (ship-check finding) ===
// update-show-status.yml:943 and the orchestrator's multi-show branch dispatch
// the poller WITHOUT show_id. The resulting run-name is "Opening Night Poller — auto"
// and the run iterates ALL of today's openings inside opening-night-poller.js.
// The watcher must treat such a run as covering any show it might target —
// otherwise the watcher's targeted dispatch races against the auto run for
// the same show, re-introducing the Joe Turner push storm.

test('AUTO_RUN_SUFFIX is em dash + space + auto', () => {
  assert.equal(AUTO_RUN_SUFFIX, '— auto');
});

test('findInFlightAutoPoller finds an in-flight auto run', () => {
  const sample = [
    { databaseId: 50, status: 'in_progress', displayTitle: 'Opening Night Poller — auto' },
  ];
  const m = findInFlightAutoPoller(sample);
  assert.equal(m && m.databaseId, 50);
});

test('findInFlightAutoPoller ignores completed auto runs', () => {
  const sample = [
    { databaseId: 51, status: 'completed', displayTitle: 'Opening Night Poller — auto' },
  ];
  assert.equal(findInFlightAutoPoller(sample), null);
});

test('findInFlightAutoPoller ignores targeted runs', () => {
  const sample = [
    { databaseId: 52, status: 'in_progress', displayTitle: 'Opening Night Poller — beaches-2026' },
  ];
  assert.equal(findInFlightAutoPoller(sample), null);
});

test('findInFlightPollerForShow falls back to auto when no targeted match', () => {
  // P0-1: The whole point. Watcher targets show X; an auto run is in-flight;
  // the watcher must skip its dispatch.
  const sample = [
    { databaseId: 60, status: 'in_progress', displayTitle: 'Opening Night Poller — auto' },
  ];
  const m = findInFlightPollerForShow(sample, 'beaches-2026');
  assert.equal(m && m.databaseId, 60);
});

test('findInFlightPollerForShow prefers targeted match over auto when both exist', () => {
  // Operator wants the most specific match in the skip log.
  const sample = [
    { databaseId: 70, status: 'in_progress', displayTitle: 'Opening Night Poller — auto' },
    { databaseId: 71, status: 'in_progress', displayTitle: 'Opening Night Poller — beaches-2026' },
  ];
  const m = findInFlightPollerForShow(sample, 'beaches-2026');
  assert.equal(m && m.databaseId, 71);
});

test('findInFlightPollerForShow with auto in waiting state still skips dispatch', () => {
  // Combines P0-1 (auto coverage) with P0-2 (waiting status).
  const sample = [
    { databaseId: 80, status: 'waiting', displayTitle: 'Opening Night Poller — auto' },
  ];
  const m = findInFlightPollerForShow(sample, 'whatever-2026');
  assert.equal(m && m.databaseId, 80);
});

test('findInFlightTargetedPollerForShow does NOT match auto runs', () => {
  // Strict targeted match — useful when the caller wants to know "is there a
  // same-show run specifically?" without auto-coverage fallback.
  const sample = [
    { databaseId: 90, status: 'in_progress', displayTitle: 'Opening Night Poller — auto' },
  ];
  assert.equal(findInFlightTargetedPollerForShow(sample, 'beaches-2026'), null);
});

test('isActiveRun rejects runs without displayTitle', () => {
  // Hardening: GitHub may omit displayTitle for runs created before run-name
  // was added. Don't treat them as matchable, but don't crash either.
  assert.equal(isActiveRun({ status: 'in_progress' }), false);
  assert.equal(isActiveRun({ status: 'in_progress', displayTitle: null }), false);
  assert.equal(isActiveRun({ status: 'in_progress', displayTitle: 123 }), false);
  assert.equal(isActiveRun({ status: 'in_progress', displayTitle: 'Opening Night Poller' }), true);
  assert.equal(isActiveRun({ status: 'completed', displayTitle: 'x' }), false);
  assert.equal(isActiveRun(null), false);
  assert.equal(isActiveRun(undefined), false);
});

import { findInFlightCoverage } from '../../scripts/lib/poller-idempotency.js';

test('BRO-4209: override-URL dispatch is NOT skipped by an active auto run', () => {
  const runs = [{ databaseId: 9, status: 'in_progress', displayTitle: 'Opening Night Poller — auto' }];
  assert.equal(findInFlightCoverage(runs, 'x-2026', { hasOverrideUrl: true }), null);
  assert.equal(findInFlightCoverage(runs, 'x-2026', {})?.databaseId, 9);
});

test('BRO-4209: override-URL dispatch still skips for a same-show targeted run', () => {
  const runs = [
    { databaseId: 9, status: 'in_progress', displayTitle: 'Opening Night Poller — auto' },
    { databaseId: 10, status: 'queued', displayTitle: 'Opening Night Poller — x-2026' },
  ];
  assert.equal(findInFlightCoverage(runs, 'x-2026', { hasOverrideUrl: true })?.databaseId, 10);
});

// ---------------------------------------------------------------------------
// BRO-7117: an auto run leaves shows an active targeted run owns to that run.
// ---------------------------------------------------------------------------

test('targetedShowIdFromTitle reads the show id after the em-dash separator', () => {
  assert.equal(targetedShowIdFromTitle('Opening Night Poller — cloud-9-west-end-2026'), 'cloud-9-west-end-2026');
  assert.equal(targetedShowIdFromTitle('Opening Night Poller — auto'), null);
  assert.equal(targetedShowIdFromTitle('Opening Night Poller - cloud-9'), null); // ASCII hyphen is not the contract
  assert.equal(targetedShowIdFromTitle(undefined), null);
  assert.equal(targetedShowIdFromTitle('Opening Night Poller — '), null);
});

// Replay of 2026-11-11 00:25Z (BRO-7338): auto run 42931217026 and targeted
// run 42931235978 both worked on cloud-9-west-end-2026 and both crashed in
// collect. With the targeted run active, the auto run must drop that show.
const BRO_7338_RUNS = [
  { databaseId: 42931235978, status: 'in_progress', displayTitle: 'Opening Night Poller — cloud-9-west-end-2026' },
  { databaseId: 42931217026, status: 'in_progress', displayTitle: 'Opening Night Poller — auto' },
  { databaseId: 42874533817, status: 'completed', displayTitle: 'Opening Night Poller — the-lives-of-others-west-end-2026' },
];
const BRO_7338_AUTO_SHOWS = [
  'cloud-9-west-end-2026',
  'iphigenie-en-tauride-english-national-opera-west-end-2026',
  'tosca-english-national-opera-west-end-2026',
  'the-lives-of-others-west-end-2026',
];

test('BRO-7338 replay: the auto run drops the show the targeted run owns, keeps the rest', () => {
  const { keep, owned } = partitionByActiveTargetedPoller(BRO_7338_RUNS, BRO_7338_AUTO_SHOWS);
  assert.deepEqual(owned, [{ showId: 'cloud-9-west-end-2026', runId: 42931235978 }]);
  assert.deepEqual(keep, BRO_7338_AUTO_SHOWS.slice(1));
});

test('completed targeted runs and auto runs own nothing', () => {
  const active = activeTargetedPollerShows(BRO_7338_RUNS);
  assert.deepEqual([...active.keys()], ['cloud-9-west-end-2026']);
  assert.equal(activeTargetedPollerShows([]).size, 0);
  assert.equal(activeTargetedPollerShows(null).size, 0);
});

test('every active status counts (queued targeted run still owns its show)', () => {
  for (const status of ACTIVE_STATUSES) {
    const { owned } = partitionByActiveTargetedPoller(
      [{ databaseId: 1, status, displayTitle: 'Opening Night Poller — x-2026' }], ['x-2026']);
    assert.equal(owned.length, 1, status);
  }
});

test('slug prefixes do not collide (the-bear-2025 vs the-bear-bites-back-2025)', () => {
  const runs = [{ databaseId: 9, status: 'queued', displayTitle: 'Opening Night Poller — the-bear-bites-back-2025' }];
  const { keep, owned } = partitionByActiveTargetedPoller(runs, ['the-bear-2025', 'the-bear-bites-back-2025']);
  assert.deepEqual(keep, ['the-bear-2025']);
  assert.deepEqual(owned.map((o) => o.showId), ['the-bear-bites-back-2025']);
});
