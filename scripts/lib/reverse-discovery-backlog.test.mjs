// Guards the escalation half of the Rhinoceros miss (2026-08-24 → 2026-09-06).
// The detector caught the show on day one; the digest line read identically on
// day 1 and day 12, so nobody acted. These assert the two properties that
// would have changed that: name the OLDEST, and escalate a review-backed
// candidate that has outlived the daily promotion cycle.
//
// CLAUDE.md §15: requires the real functions — no logic copied here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EVIDENCE_SOURCES,
  RD_AGED_DAYS_ERROR,
  rankReverseDiscoveryBacklog,
  describeCandidate,
} = require('./reverse-discovery-backlog.js');
const { candidateKey } = require('./reverse-discovery.js');

const DAY = 86400000;
const NOW = Date.parse('2026-09-05T12:00:00Z');

/** Build a state file the same way audit-reverse-discovery.js does. */
const stateOf = (entries) =>
  Object.fromEntries(
    entries.map(([c, firstSeen]) => [candidateKey(c), { firstSeen, title: c.title, source: c.source }])
  );

const RHINO = { title: 'RHINOCEROS at American Repertory Theater?', source: 'bww-roundup' };
const CALENDAR = { title: 'Tin Pan Alley', source: 'nyt-theater' };

test('nothing to report yields null, never a phantom row', () => {
  assert.equal(rankReverseDiscoveryBacklog({ candidates: [], state: {}, nowMs: NOW }), null);
  assert.equal(rankReverseDiscoveryBacklog({ candidates: null, state: {}, nowMs: NOW }), null);
  assert.equal(rankReverseDiscoveryBacklog(), null);
});

test('the Rhinoceros timeline: warn on day 1, ERROR by day 12', () => {
  const day1 = rankReverseDiscoveryBacklog({
    candidates: [RHINO],
    state: stateOf([[RHINO, '2026-09-05T09:00:00Z']]),
    nowMs: NOW,
  });
  assert.equal(day1.status, 'warn', 'a fresh candidate must not cry wolf');
  assert.equal(day1.oldest.ageDays, 0);

  // The real firstSeen. Note ageDays counts ELAPSED 24h periods, not calendar
  // days: 08-24T14:36 → 09-05T12:00 is 11d21h, so floor() gives 11 (the miss
  // spanned 12 calendar days). Asserting the computed value rather than the
  // headline number keeps this honest.
  const aged = rankReverseDiscoveryBacklog({
    candidates: [RHINO],
    state: stateOf([[RHINO, '2026-08-24T14:36:58Z']]),
    nowMs: NOW,
  });
  assert.equal(aged.status, 'error', 'a review-backed show missing this long must escalate');
  assert.equal(aged.oldest.ageDays, 11);
  assert.ok(aged.oldest.ageDays >= RD_AGED_DAYS_ERROR);
  assert.equal(aged.agedEvidence.length, 1);
});

test('escalation boundary is exactly RD_AGED_DAYS_ERROR', () => {
  const at = (days) =>
    rankReverseDiscoveryBacklog({
      candidates: [RHINO],
      state: stateOf([[RHINO, new Date(NOW - days * DAY).toISOString()]]),
      nowMs: NOW,
    }).status;
  assert.equal(at(RD_AGED_DAYS_ERROR - 1), 'warn');
  assert.equal(at(RD_AGED_DAYS_ERROR), 'error');
});

test('a calendar source never escalates, however old', () => {
  // nyt-theater is an openings calendar, not evidence of reviews. Escalating
  // it would train everyone to ignore this row — how the channel failed before.
  const r = rankReverseDiscoveryBacklog({
    candidates: [CALENDAR],
    state: stateOf([[CALENDAR, '2026-06-01T00:00:00Z']]),
    nowMs: NOW,
  });
  assert.equal(r.status, 'warn');
  assert.equal(r.agedEvidence.length, 0);
  assert.ok(r.oldest.ageDays > 90, 'it is still reported, just not escalated');
  assert.equal(EVIDENCE_SOURCES.has('nyt-theater'), false);
});

test('names the OLDEST candidate, not the first in the array', () => {
  // The exact bug: Rhinoceros sat behind whatever happened to be candidates[0].
  const FRESH = { title: 'Something New', source: 'wet-roundup' };
  const r = rankReverseDiscoveryBacklog({
    candidates: [FRESH, RHINO],
    state: stateOf([
      [FRESH, '2026-09-05T09:00:00Z'],
      [RHINO, '2026-08-24T14:36:58Z'],
    ]),
    nowMs: NOW,
  });
  assert.match(r.oldest.title, /RHINOCEROS/);
  assert.equal(r.count, 2);
  assert.match(describeCandidate(r.oldest), /missing 11d/);
});

test('an unknown age degrades to warn instead of throwing', () => {
  // State file absent or key missing (first run, or a renamed source).
  const r = rankReverseDiscoveryBacklog({ candidates: [RHINO], state: {}, nowMs: NOW });
  assert.equal(r.status, 'warn');
  assert.equal(r.oldest.ageDays, null);
  assert.equal(describeCandidate(r.oldest).includes('missing'), false);

  const garbage = rankReverseDiscoveryBacklog({
    candidates: [RHINO],
    state: stateOf([[RHINO, 'not-a-date']]),
    nowMs: NOW,
  });
  assert.equal(garbage.status, 'warn');
  assert.equal(garbage.oldest.ageDays, null);
});

test('aged entries sort ahead of age-less ones', () => {
  const NOAGE = { title: 'No Age Signal', source: 'bww-roundup' };
  const r = rankReverseDiscoveryBacklog({
    candidates: [NOAGE, RHINO],
    state: stateOf([[RHINO, '2026-08-24T14:36:58Z']]),
    nowMs: NOW,
  });
  assert.match(r.oldest.title, /RHINOCEROS/);
});

test('describeCandidate tolerates nothing to describe', () => {
  assert.equal(describeCandidate(null), '(none)');
  assert.equal(describeCandidate(undefined), '(none)');
});

test('a since-catalogued candidate cannot escalate on its own', () => {
  // "Game of Thrones: The Mad King" was still in the candidates report on
  // 2026-09-10, 30 days old, while already catalogued as
  // game-of-thrones-the-mad-king-regional-2026. The report was simply stale.
  const MADKING = { title: 'Game of Thrones: The Mad King', source: 'wet-roundup', market: 'west-end' };
  const state = stateOf([[MADKING, '2026-08-10T17:16:57Z']]);

  const trusting = rankReverseDiscoveryBacklog({ candidates: [MADKING], state, nowMs: NOW });
  assert.equal(trusting.status, 'error', 'without re-confirmation it escalates');

  const gated = rankReverseDiscoveryBacklog({
    candidates: [MADKING],
    state,
    nowMs: NOW,
    isStillMissing: () => false, // already in shows.json
  });
  assert.equal(gated.status, 'warn', 'a show already added must not raise severity');
  assert.equal(gated.agedEvidence.length, 0);
  assert.equal(gated.count, 1, 'it is still counted and can still be named');
});

test('a genuinely-missing candidate still escalates through the gate', () => {
  const MARILYN = { title: 'Who Killed Marilyn', source: 'wet-roundup', market: 'west-end' };
  const r = rankReverseDiscoveryBacklog({
    candidates: [MARILYN],
    state: stateOf([[MARILYN, '2026-08-24T15:07:42Z']]),
    nowMs: NOW,
    isStillMissing: () => true,
  });
  assert.equal(r.status, 'error');
  assert.equal(r.agedEvidence.length, 1);
});

test('a throwing matcher fails LOUD, never silent', () => {
  // Silencing a real backlog because the matcher broke would recreate the
  // original defect in a new costume.
  const r = rankReverseDiscoveryBacklog({
    candidates: [RHINO],
    state: stateOf([[RHINO, '2026-08-24T14:36:58Z']]),
    nowMs: NOW,
    isStillMissing: () => { throw new Error('shows.json unreadable'); },
  });
  assert.equal(r.status, 'error');
});
