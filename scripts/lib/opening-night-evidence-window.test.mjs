/**
 * Regression tests for the 2026-08-12 opening-night monitor failure
 * (how-the-other-half-loves-west-end-2026).
 *
 * Two independent defects, one night:
 *   1. The monitor window is derived from openingDate alone. That show's
 *      openingDate was back-derived FROM its own reviews, so it was null while
 *      the reviews were publishing — computeWindow returned null on every
 *      launchd tick and the monitor opened 19 hours late.
 *   2. Every failed pass paged the owner. A pass killed by the 15-minute wall
 *      clock emailed "[CRITICAL] ... FAILED" on attempt 1, while its own body
 *      said "next tick retries" and while it had committed a real recovery.
 *
 * These assert the fixes as behavior, against the real timeline.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeWindow, activeWindows, nightKey, launchDecision, carryForwardNightState,
  MAX_NO_PROGRESS_PASSES,
} = require('./opening-night-windows.js');

// The real show, in the state shows.json actually held that night: no
// openingDate (it arrived later, stamped review-derived-press-night).
const SHOW_NO_DATE = {
  id: 'how-the-other-half-loves-west-end-2026',
  category: 'west-end',
  previewsStartDate: '2026-07-28',
  openingDate: null,
};
// Evidence as review-evidence.json held it: reviews published on press night.
const EVIDENCE = {
  'how-the-other-half-loves-west-end-2026': {
    latest: '2026-08-13',
    items: [
      { source: 'wet', url: 'https://example.test/a', date: '2026-08-12' },
      { source: 'bww', url: 'https://example.test/b', date: '2026-08-13' },
    ],
  },
};

const HEALTHY = {
  killSwitch: false, lockExists: false, heartbeatAgeMin: null,
  claudeAlive: false, attemptsTonight: 0, metaExists: true,
};

test('THE 19 HOURS: a west-end show with no openingDate still gets a window from its review evidence', () => {
  // 16:00Z on press night is exactly when the window should open (17:00 London).
  const at1600Z = new Date('2026-08-12T16:00:00Z');

  assert.equal(computeWindow(SHOW_NO_DATE), null,
    'without evidence the behavior is unchanged — this is the old bug, preserved as the no-evidence case');

  const w = computeWindow(SHOW_NO_DATE, { evidence: EVIDENCE, now: at1600Z });
  assert.ok(w, 'with evidence the show must get a window');
  assert.equal(w.anchor, 'evidence');
  assert.equal(w.openingDate, '2026-08-12', 'anchors on the EARLIEST fresh item (press night), not .latest');
  assert.equal(w.windowStart.toISOString(), '2026-08-12T16:00:00.000Z');

  const active = activeWindows([SHOW_NO_DATE], at1600Z, { evidence: EVIDENCE });
  assert.equal(active.length, 1, 'the launcher would have had a live window at 16:00Z');
  assert.equal(launchDecision({ ...HEALTHY, windows: active }).action, 'launch');

  // The actual failure, asserted directly: this is what shipped that night.
  assert.equal(activeWindows([SHOW_NO_DATE], at1600Z).length, 0,
    'without threading evidence the monitor stays blind — the 19h regression');
});

test('a stored openingDate always wins, and no-evidence behavior is untouched', () => {
  const withDate = { ...SHOW_NO_DATE, openingDate: '2026-08-12' };
  const w = computeWindow(withDate, { evidence: EVIDENCE, now: new Date('2026-08-12T16:00:00Z') });
  assert.equal(w.anchor, 'openingDate');
  assert.equal(w.openingDate, '2026-08-12');
  // Broadway/west-end only; OB and OWE open cold and are not monitored.
  assert.equal(computeWindow({ ...SHOW_NO_DATE, category: 'off-broadway' }, { evidence: EVIDENCE, now: new Date('2026-08-12T16:00:00Z') }), null);
});

test('the evidence anchor cannot slide: too-old items and pre-previews items are refused', () => {
  const stale = { 'x-west-end-2026': { latest: '2026-08-01', items: [{ date: '2026-08-01' }] } };
  const show = { id: 'x-west-end-2026', category: 'west-end', previewsStartDate: '2026-07-28', openingDate: null };
  assert.equal(computeWindow(show, { evidence: stale, now: new Date('2026-08-12T16:00:00Z') }), null,
    'a 11-day-old item must not anchor a window in the past');

  const prePreviews = { 'x-west-end-2026': { latest: '2026-07-20', items: [{ date: '2026-07-20' }] } };
  assert.equal(computeWindow(show, { evidence: prePreviews, now: new Date('2026-07-21T16:00:00Z') }), null,
    'nothing published before previews began can be a review of this production');
});

test('night-state carries forward when the anchor flips to a real openingDate mid-window', () => {
  // The evidence-anchored night spent $19.57 over 4 passes...
  const prior = [{
    key: 'on-monitor-2026-08-12',
    state: { shows: ['how-the-other-half-loves-west-end-2026'], usdTonight: 19.57, attempts: 4, consecutiveFailures: 1, noProgressPasses: 2, escalated: true },
  }];
  // ...then openingDate lands as 2026-08-13 and the key flips to a virgin state.
  const merged = carryForwardNightState(prior, ['how-the-other-half-loves-west-end-2026'], {});
  assert.equal(merged.usdTonight, 19.57, 'spend must not reset — that would let one night spend twice its cap');
  assert.equal(merged.attempts, 4);
  assert.equal(merged.noProgressPasses, 2);
  assert.equal(merged.escalated, true, 'a settled escalation must not re-page');
  assert.equal(merged.carriedFrom, 'on-monitor-2026-08-12');

  // An unrelated show's night must never be absorbed.
  const unrelated = carryForwardNightState(prior, ['some-other-show-2026'], {});
  assert.equal(unrelated.usdTonight, 0);
  assert.equal(unrelated.carriedFrom, undefined);
});

test('nightKey stays stable when the real openingDate matches the evidence anchor', () => {
  const at = new Date('2026-08-12T18:00:00Z');
  const before = activeWindows([SHOW_NO_DATE], at, { evidence: EVIDENCE });
  const after = activeWindows([{ ...SHOW_NO_DATE, openingDate: '2026-08-12' }], at, { evidence: EVIDENCE });
  assert.equal(nightKey(before), nightKey(after),
    'the common case (press night == evidence date) must not re-key at all');
});

test('the no-progress brake stops a night that has stopped changing anything', () => {
  const windows = activeWindows([SHOW_NO_DATE], new Date('2026-08-12T18:00:00Z'), { evidence: EVIDENCE });
  assert.equal(launchDecision({ ...HEALTHY, windows, noProgressPasses: MAX_NO_PROGRESS_PASSES - 1 }).action, 'launch',
    'below the threshold the monitor keeps working');
  const stopped = launchDecision({ ...HEALTHY, windows, noProgressPasses: MAX_NO_PROGRESS_PASSES });
  assert.equal(stopped.action, 'escalate');
  assert.match(stopped.reason, /no change/);
});
