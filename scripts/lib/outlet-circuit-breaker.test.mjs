import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  isOutletTripped, evaluateOutlet, updateBreaker, buildEvidence, entryOf,
  serializeBreaker, emptyBreaker,
  TRIP_MIN_AGE_HOURS, TRIP_MIN_GAP_CELLS, SUCCESS_WINDOW_HOURS,
  PROBE_COOLDOWN_HOURS, MAX_PROBE_COOLDOWN_HOURS,
  STATE_CLOSED, STATE_OPEN, STATE_HALF_OPEN,
} = require('./outlet-circuit-breaker.js');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const H = 3600000;
const closed = { state: STATE_CLOSED, probesUsed: 0 };

// --- trip conditions -------------------------------------------------------

test('trips only on ALL THREE conditions: enough cells, old enough, zero recent success', () => {
  const enough = { gapCells: TRIP_MIN_GAP_CELLS, minGapAgeHours: TRIP_MIN_AGE_HOURS, recentSuccess: false };
  assert.equal(evaluateOutlet({ prev: closed, evidence: enough, nowMs: NOW }).entry.state, STATE_OPEN);

  assert.equal(evaluateOutlet({ prev: closed, nowMs: NOW,
    evidence: { ...enough, gapCells: TRIP_MIN_GAP_CELLS - 1 } }).entry.state, STATE_CLOSED,
    'one gap short — could still be a single bad roundup URL');

  assert.equal(evaluateOutlet({ prev: closed, nowMs: NOW,
    evidence: { ...enough, minGapAgeHours: TRIP_MIN_AGE_HOURS - 1 } }).entry.state, STATE_CLOSED,
    'youngest cell inside the age bar — late-drop T1s are not a failure');

  assert.equal(evaluateOutlet({ prev: closed, nowMs: NOW,
    evidence: { ...enough, recentSuccess: true } }).entry.state, STATE_CLOSED,
    'a recent scored review PROVES retrieval works — gaps stay dispatchable');
});

test('a null/unmeasurable clock cannot lift the age floor for the outlet', () => {
  // buildEvidence records a null clock as age 0 so the minimum can never be
  // inflated by a dateless show.
  const ev = buildEvidence([
    { outletId: 'nytimes', wouldBeGap: true, clockAgeHours: 500 },
    { outletId: 'nytimes', wouldBeGap: true, clockAgeHours: 500 },
    { outletId: 'nytimes', wouldBeGap: true, clockAgeHours: null },
  ], []);
  assert.equal(ev.nytimes.gapCells, 3);
  assert.equal(ev.nytimes.minGapAgeHours, 0);
  assert.equal(evaluateOutlet({ prev: closed, evidence: ev.nytimes, nowMs: NOW }).entry.state, STATE_CLOSED);
});

test('buildEvidence: non-gap observations ignored; success only counts inside the window', () => {
  const ev = buildEvidence(
    [{ outletId: 'nypost', wouldBeGap: false, clockAgeHours: 900 },
      { outletId: 'nypost', wouldBeGap: true, clockAgeHours: 900 }],
    [{ outletId: 'nypost', clockAgeHours: SUCCESS_WINDOW_HOURS + 1 },
      { outletId: 'hollywoodreporter', clockAgeHours: 10 }],
  );
  assert.equal(ev.nypost.gapCells, 1, 'covered cells are not evidence');
  assert.equal(ev.nypost.recentSuccess, false, 'a success older than the window proves nothing about now');
  assert.equal(ev.hollywoodreporter.recentSuccess, true);
  assert.equal(ev.hollywoodreporter.gapCells, 0, 'success-only outlets appear with zero gaps');
});

// --- half-open probe lifecycle --------------------------------------------

test('open → half-open at nextProbeAt, and half-open is NOT tripped (it is the probe)', () => {
  const open = { state: STATE_OPEN, probesUsed: 0, openedAt: '2026-07-29T12:00:00.000Z',
    nextProbeAt: new Date(NOW + H).toISOString() };
  const stillCooling = evaluateOutlet({ prev: open, evidence: { gapCells: 5, minGapAgeHours: 500, recentSuccess: false }, nowMs: NOW });
  assert.equal(stillCooling.entry.state, STATE_OPEN);
  assert.equal(stillCooling.transition, null, 'no transition churn while cooling down');

  const due = { ...open, nextProbeAt: new Date(NOW - H).toISOString() };
  const probing = evaluateOutlet({ prev: due, evidence: { gapCells: 5, minGapAgeHours: 500, recentSuccess: false }, nowMs: NOW });
  assert.equal(probing.entry.state, STATE_HALF_OPEN);
  assert.equal(probing.transition, 'half-open');
  assert.equal(isOutletTripped({ outlets: { x: probing.entry } }, 'x'), false,
    'half-open must be actionable or the probe can never happen');
});

test('failed probe re-opens with a DOUBLED cooldown, capped', () => {
  let entry = { state: STATE_HALF_OPEN, probesUsed: 0, openedAt: '2026-07-01T00:00:00.000Z' };
  const fail = () => {
    const r = evaluateOutlet({ prev: entry, evidence: { gapCells: 4, minGapAgeHours: 500, recentSuccess: false }, nowMs: NOW });
    entry = r.entry;
    return { hours: (Date.parse(entry.nextProbeAt) - NOW) / H, transition: r.transition };
  };
  const first = fail();
  assert.equal(first.transition, 'reopened');
  assert.equal(first.hours, PROBE_COOLDOWN_HOURS, 'probe 1 → base cooldown');
  assert.equal(entry.probesUsed, 1);

  entry = { ...entry, state: STATE_HALF_OPEN };
  assert.equal(fail().hours, PROBE_COOLDOWN_HOURS * 2, 'probe 2 → doubled');

  // Escalate until the cap binds; it must never exceed MAX.
  let lastHours = 0;
  for (let i = 0; i < 8; i++) {
    entry = { ...entry, state: STATE_HALF_OPEN };
    lastHours = fail().hours;
    assert.ok(lastHours <= MAX_PROBE_COOLDOWN_HOURS, `cooldown ${lastHours}h exceeded the ${MAX_PROBE_COOLDOWN_HOURS}h cap`);
  }
  assert.equal(lastHours, MAX_PROBE_COOLDOWN_HOURS, 'escalation saturates AT the cap, it does not stop early');
  assert.equal(entry.openedAt, '2026-07-01T00:00:00.000Z', 'original open time survives re-opens (age not reset)');
});

test('a success closes the breaker from ANY state and clears the escalation history', () => {
  for (const state of [STATE_OPEN, STATE_HALF_OPEN, STATE_CLOSED]) {
    const prev = { state, probesUsed: 4, openedAt: '2026-07-01T00:00:00.000Z',
      nextProbeAt: '2026-08-20T00:00:00.000Z' };
    // Gap counts are deliberately still high: a review scored moments ago is
    // still a GAP cell until the next ledger rebuild sees it.
    const r = evaluateOutlet({ prev, evidence: { gapCells: 9, minGapAgeHours: 900, recentSuccess: true }, nowMs: NOW });
    assert.equal(r.entry.state, STATE_CLOSED, `${state} + success → closed`);
    assert.equal(r.entry.probesUsed, 0, 'escalation forgotten');
    assert.equal(r.entry.nextProbeAt, null);
    assert.equal(r.entry.lastSuccessAt, new Date(NOW).toISOString());
    assert.equal(r.transition, state === STATE_CLOSED ? null : 'closed');
  }
});

// --- whole-breaker update -------------------------------------------------

test('updateBreaker carries forward outlets absent from this cycle instead of resetting them', () => {
  const prev = { outlets: {
    nytimes: { state: STATE_OPEN, probesUsed: 2, nextProbeAt: '2026-09-01T00:00:00.000Z' },
    vulture: { state: STATE_CLOSED, probesUsed: 0 },
  } };
  // This cycle only saw evidence for 'variety' (e.g. the other shows aged out).
  const { breaker, transitions } = updateBreaker(prev, {
    variety: { gapCells: TRIP_MIN_GAP_CELLS, minGapAgeHours: 200, recentSuccess: false },
  }, NOW);
  assert.equal(breaker.outlets.nytimes.state, STATE_OPEN, 'an open breaker must not silently close on a partial cycle');
  assert.equal(breaker.outlets.nytimes.probesUsed, 2);
  assert.equal(breaker.outlets.vulture.state, STATE_CLOSED);
  assert.equal(breaker.outlets.variety.state, STATE_OPEN);
  assert.deepEqual(transitions.map(t => `${t.outletId}:${t.transition}`), ['variety:opened']);
});

test('isOutletTripped / entryOf: unknown, corrupt and bogus-state entries fail CLOSED', () => {
  assert.equal(isOutletTripped(emptyBreaker(), 'nytimes'), false, 'unknown outlet');
  assert.equal(isOutletTripped(null, 'nytimes'), false, 'no breaker file yet');
  assert.equal(isOutletTripped({ outlets: { nytimes: 'garbage' } }, 'nytimes'), false, 'corrupt entry');
  assert.equal(isOutletTripped({ outlets: { nytimes: { state: 'OPEN' } } }, 'nytimes'), false,
    'unrecognized state string is not "open" — never suppress on a typo');
  assert.equal(entryOf({ outlets: { x: { state: STATE_OPEN } } }, 'x').probesUsed, 0, 'missing counters default to 0');
});

test('serializeBreaker is deterministic — insertion order does not change the bytes', () => {
  const a = { outlets: { z: { state: STATE_CLOSED, probesUsed: 0 }, a: { probesUsed: 1, state: STATE_OPEN } } };
  const b = { outlets: { a: { state: STATE_OPEN, probesUsed: 1 }, z: { probesUsed: 0, state: STATE_CLOSED } } };
  assert.equal(serializeBreaker(a), serializeBreaker(b));
});

// --- the end-to-end scenario the plan names -------------------------------

test('scenario: NYT hard-blocked across 4 shows trips, stops dispatch, then self-heals on a probe success', () => {
  // Hour 0: four in-window shows, NYT missing on all, nothing scored recently.
  const obs = ['a', 'b', 'c', 'd'].map(() => ({ outletId: 'nytimes', wouldBeGap: true, clockAgeHours: 120 }));
  let breaker = emptyBreaker();
  ({ breaker } = updateBreaker(breaker, buildEvidence(obs, []), NOW));
  assert.equal(isOutletTripped(breaker, 'nytimes'), true, 'tripped → no more gathers for NYT');

  // 12h later: still cooling down, still tripped (no repeated dispatch).
  ({ breaker } = updateBreaker(breaker, buildEvidence(obs, []), NOW + 12 * H));
  assert.equal(isOutletTripped(breaker, 'nytimes'), true);

  // 25h later: probe window opens, so it becomes actionable for one cycle.
  ({ breaker } = updateBreaker(breaker, buildEvidence(obs, []), NOW + 25 * H));
  assert.equal(isOutletTripped(breaker, 'nytimes'), false, 'half-open → one probe allowed');

  // The probe lands a scored review → breaker closes for good.
  ({ breaker } = updateBreaker(breaker,
    buildEvidence(obs, [{ outletId: 'nytimes', clockAgeHours: 120 }]), NOW + 26 * H));
  assert.equal(breaker.outlets.nytimes.state, STATE_CLOSED);
  assert.equal(isOutletTripped(breaker, 'nytimes'), false);
});
