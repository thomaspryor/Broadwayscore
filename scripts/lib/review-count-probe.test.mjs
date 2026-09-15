/**
 * Unit tests for scripts/lib/review-count-probe.js's makeFingerprint()
 * (BRO-931 #4 — "local 21 vs live 13" going unexplained for hours during the
 * Fear of 13 opening night, 2026-04-15).
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
const { makeFingerprint } = require('./review-count-probe.js');

// The pre-fix formula (was inline in check-opening-night-drift.js). Frozen
// here only to demonstrate what the old behavior would have done on the
// same input sequence — see the "regression" describe block below.
function DEPRECATED_makeFingerprint(local, agg, localJson, live) {
  return `${local}:${agg}:${localJson ?? 'null'}:${live ?? 'null'}`;
}

// Mirrors check-opening-night-drift.js's shouldAlert/updateState grace-window
// shape (same fingerprint on 2+ consecutive runs → alert), parameterized over
// which fingerprint function to use, so the same driver can replay a run
// sequence against both the old and new formulas.
function replayRuns(fingerprints, graceConsecutive = 2) {
  let state = null;
  const alerts = [];
  for (const fp of fingerprints) {
    if (!state || state.fingerprint !== fp) {
      state = { fingerprint: fp, consecutiveCount: 1 };
      alerts.push(false);
      continue;
    }
    state.consecutiveCount += 1;
    alerts.push(state.consecutiveCount >= graceConsecutive);
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

describe('makeFingerprint — Fear of 13 regression (live frozen, everything else climbing)', () => {
  // Real incident shape: local/agg/localJson grow every ~30min as gather +
  // rebuild catch up, while live stays stuck at 13 across 4 consecutive runs.
  const runs = [
    { local: 15, agg: 15, localJson: 15, live: 13 },
    { local: 17, agg: 17, localJson: 17, live: 13 },
    { local: 19, agg: 19, localJson: 19, live: 13 },
    { local: 21, agg: 21, localJson: 21, live: 13 },
  ];

  it('OLD formula: fingerprint changes every run because local/agg/localJson climb — never alerts', () => {
    const fps = runs.map(r => DEPRECATED_makeFingerprint(r.local, r.agg, r.localJson, r.live));
    // Every fingerprint is unique — the bug.
    assert.strictEqual(new Set(fps).size, fps.length);
    const alerts = replayRuns(fps);
    assert.ok(alerts.every(a => a === false), 'old formula should never alert across this run sequence');
  });

  it('NEW formula: fingerprint stays constant because live is frozen — alerts by run 2', () => {
    const fps = runs.map(r => makeFingerprint(r.live));
    assert.strictEqual(new Set(fps).size, 1, 'all fingerprints should be identical (live never moved)');
    const alerts = replayRuns(fps);
    assert.deepStrictEqual(alerts, [false, true, true, true], 'grace window should confirm by the 2nd consecutive run and keep alerting');
  });

  it('NEW formula: once live actually advances, the grace window resets (real progress, not stuck)', () => {
    const recovering = [
      { local: 15, live: 13 },
      { local: 17, live: 13 },
      { local: 19, live: 17 }, // live catches up — not stuck anymore
      { local: 21, live: 21 }, // fully caught up
    ];
    const fps = recovering.map(r => makeFingerprint(r.live));
    const alerts = replayRuns(fps);
    assert.deepStrictEqual(alerts, [false, true, false, false], 'live advancing should reset the grace window instead of continuing to alert');
  });
});
