/**
 * Unit tests for scripts/lib/review-count-probe.js's makeFingerprint(),
 * shouldAlert(), and updateState() (BRO-931 #4 — "local 21 vs live 13"
 * going unexplained for hours during the Fear of 13 opening night,
 * 2026-04-15).
 *
 * Logic is require()'d from the lib — never copied (CLAUDE.md §15). The one
 * exception is DEPRECATED_makeFingerprint below, which intentionally
 * reproduces the OLD, buggy 4-field fingerprint formula check-opening-night-
 * drift.js used to compute inline — kept here ONLY as a frozen historical
 * comparison to prove the regression the fix closes, not as logic under
 * test.
 *
 * Run: node --test scripts/lib/review-count-probe.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { makeFingerprint, shouldAlert, updateState } = require('./review-count-probe.js');

// The pre-fix formula (was inline in check-opening-night-drift.js). Frozen
// here only to demonstrate what the old behavior would have done on the
// same input sequence — see the "regression" describe block below.
function DEPRECATED_makeFingerprint(local, agg, localJson, live) {
  return `${local}:${agg}:${localJson ?? 'null'}:${live ?? 'null'}`;
}

// Drives the REAL shouldAlert/updateState pair exactly as
// check-opening-night-drift.js's main loop does (compute fingerprint +
// aboveThreshold, call shouldAlert, then updateState with the same values).
// One driver, real functions — a fresh `state` object per call so tests don't
// bleed into each other.
function replayRuns(showId, runs, threshold = 2) {
  const state = {};
  const alerts = [];
  for (const r of runs) {
    const fingerprint = makeFingerprint(r.live);
    const aboveThreshold = r.drift > threshold;
    const alert = shouldAlert(showId, fingerprint, r.drift, threshold, state);
    updateState(state, showId, fingerprint, alert, aboveThreshold);
    alerts.push(alert);
  }
  return alerts;
}

describe('makeFingerprint — basic identity', () => {
  it('same live value → same fingerprint', () => {
    assert.strictEqual(makeFingerprint(13), makeFingerprint(13));
  });

  it('different live value → different fingerprint', () => {
    assert.notStrictEqual(makeFingerprint(13), makeFingerprint(14));
  });

  it('null/undefined live → stable "null" fingerprint', () => {
    assert.strictEqual(makeFingerprint(null), makeFingerprint(undefined));
    assert.strictEqual(makeFingerprint(null), 'null');
  });

  it('"rc-missing" sentinel passes through unchanged', () => {
    assert.strictEqual(makeFingerprint('rc-missing'), 'rc-missing');
  });
});

describe('makeFingerprint — Fear of 13 regression: OLD formula never alerts', () => {
  it('OLD formula: fingerprint changes every run because local/agg/localJson climb — never alerts', () => {
    // Real incident shape: local/agg/localJson grow every ~30min as gather +
    // rebuild catch up, while live stays stuck at 13 across 4 runs.
    const runs = [
      { local: 15, agg: 15, localJson: 15, live: 13 },
      { local: 17, agg: 17, localJson: 17, live: 13 },
      { local: 19, agg: 19, localJson: 19, live: 13 },
      { local: 21, agg: 21, localJson: 21, live: 13 },
    ];
    const fps = runs.map(r => DEPRECATED_makeFingerprint(r.local, r.agg, r.localJson, r.live));
    // Every fingerprint is unique — the bug.
    assert.strictEqual(new Set(fps).size, fps.length);
  });
});

describe('shouldAlert/updateState — Fear of 13 regression (live frozen, drift climbing)', () => {
  it('NEW: live frozen at 13 while drift grows past threshold — confirms and alerts by run 2', () => {
    const runs = [
      { live: 13, drift: 2 },  // local=15 vs live=13, at threshold — not yet alerting
      { live: 13, drift: 4 },  // local=17 vs live=13 — 1st confirmed-drifting run
      { live: 13, drift: 6 },  // local=19 vs live=13 — 2nd confirmed-drifting run: ALERT
      { live: 13, drift: 8 },  // local=21 vs live=13 — cooldown active, no re-alert yet
    ];
    const alerts = replayRuns('fear-of-13-2026', runs);
    assert.deepStrictEqual(alerts, [false, false, true, false]);
  });

  it('NEW: once live actually advances, the grace window resets (real progress, not stuck)', () => {
    const runs = [
      { live: 13, drift: 4 },
      { live: 13, drift: 6 }, // confirmed twice → alert
      { live: 17, drift: 4 }, // live moved — different fingerprint, resets
      { live: 21, drift: 0 }, // fully caught up — no drift at all
    ];
    const alerts = replayRuns('recovering-show-2026', runs);
    assert.deepStrictEqual(alerts, [false, true, false, false]);
  });
});

describe('shouldAlert/updateState — grace-window priming bug (adversarial ship-check finding)', () => {
  it('a healthy stretch at live=13 does NOT pre-arm the grace window when drift suddenly appears at the same live value', () => {
    // Before the aboveThreshold gate: updateState ran every check regardless
    // of drift, so consecutiveCount kept climbing through healthy runs. If a
    // real drift then appeared while live happened to hold that same value,
    // the fingerprint already "matched" the entry from the healthy runs and
    // shouldAlert fired on the very FIRST drifting reading — skipping the
    // 2-consecutive-run confirmation the grace window exists to enforce.
    const runs = [
      { live: 13, drift: 0 },  // healthy
      { live: 13, drift: 0 },  // healthy — pre-fix, this alone primed consecutiveCount=2
      { live: 13, drift: 0 },  // healthy
      { live: 13, drift: 5 },  // drift just appeared, live unchanged — must NOT alert yet
      { live: 13, drift: 6 },  // 2nd confirmed-drifting run — NOW it alerts
    ];
    const alerts = replayRuns('primed-show-2026', runs);
    assert.deepStrictEqual(alerts, [false, false, false, false, true],
      'drift must be confirmed on 2 consecutive ABOVE-THRESHOLD runs, not just 2 runs with a matching fingerprint');
  });
});
