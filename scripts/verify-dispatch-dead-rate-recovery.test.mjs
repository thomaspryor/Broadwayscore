/**
 * verify-dispatch-dead-rate-recovery.test.mjs — the RECHECK-AFTER acceptance
 * command for task #1812's "the cmux wrapper-detection fix actually moved
 * the dead-launch rate" claim.
 *
 * Unlike this repo's usual colocated tests, this one deliberately asserts
 * against LIVE repo data (data/audit/dispatch-ledger.jsonl) rather than a
 * fixture — its whole purpose is to be re-run by
 * scripts/autonomous-acceptance-recheck.js days after the fix landed
 * (commit 96ec6d951d8, merged 2026-08-19T04:05Z), against whatever real
 * dispatch volume has actually accumulated by then. A red run here is not a
 * code regression; it is the claim being disproven — exactly the signal
 * task #1812's RECHECK-AFTER stamp exists to produce. See
 * scripts/verify-provider-spend-streak.test.mjs for the same pattern.
 *
 * Scoped to entries AFTER the fix landed — the pre-fix baseline (115/366 =
 * 31.4% over the 7 days before this fix) is expected to still be dead; only
 * the POST-fix window is the claim under test.
 *
 * The ledger path is the CANONICAL repo root, not a path relative to this
 * file — unlike verify-provider-spend-streak.test.mjs's ledger (git-tracked,
 * so a fresh origin/main checkout has it), dispatch-ledger.jsonl is
 * gitignored and per-machine (scripts/lib/dispatch-ledger.js:18,38-39 uses
 * the same hardcoded '/Users/tompryor/Broadwayscore' convention for exactly
 * this reason — every worktree needs to share the ONE real ledger).
 * autonomous-acceptance-recheck.js runs this from a fresh DETACHED checkout
 * (scripts/autonomous-acceptance-recheck.js:13,87) that would never have a
 * gitignored file in its own tree — a path relative to `import.meta.url`
 * would silently and permanently read "no ledger" there regardless of the
 * real world dead-rate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { computeDeadRate, CMUX_LANE, DEFAULTS } = require('/Users/tompryor/Broadwayscore/scripts/lib/dispatch-health.js');

const LEDGER = path.join('/Users/tompryor/Broadwayscore', 'data', 'audit', 'dispatch-ledger.jsonl');

// The fix's merge commit landing time (git log -1 --format=%cI 96ec6d951d8).
const FIX_LANDED_MS = Date.parse('2026-08-19T04:05:47Z');
const MIN_LAUNCHES = DEFAULTS.minLaunches; // 20 — same "enough sample" floor computeDispatchHealthDigest uses

test('the cmux dead-launch rate has recovered below the alarm floor since the wrapper-detection fix landed (task #1812)', () => {
  let lines;
  try {
    lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  } catch {
    assert.fail(`no dispatch ledger at ${LEDGER} yet — it is per-machine and gitignored; run this where dispatches actually launch`);
  }
  const entries = lines.map((l) => JSON.parse(l));
  const nowMs = Date.now();
  // NO Math.max(1, ...) floor here (caught by this test's own first run,
  // 2026-08-19): computeDeadRate only accepts a windowDays SPAN, not an
  // absolute windowStart, and a 1-day floor would silently pull in most of
  // the pre-fix baseline for the first 24h after the fix lands — exactly
  // the population this test exists to exclude. A sub-1-day windowDays is
  // fine; computeDeadRate does no rounding on it.
  const windowDays = Math.max(1e-6, (nowMs - FIX_LANDED_MS) / (24 * 60 * 60 * 1000));
  // computeDeadRate's window starts at nowMs - windowDays*DAY_MS, which by
  // construction is FIX_LANDED_MS here — so `stats` covers only the
  // post-fix period, never the pre-fix baseline.
  const stats = computeDeadRate(entries, { nowMs, windowDays, lane: CMUX_LANE });

  assert.ok(
    stats.launches >= MIN_LAUNCHES,
    `only ${stats.launches} workspace launch(es) since the fix landed (${new Date(FIX_LANDED_MS).toISOString()}) — needs >= ${MIN_LAUNCHES} to judge the rate; too early to call, not a failure of the fix`
  );
  assert.ok(
    stats.deadRate <= DEFAULTS.deadRateFloor,
    `post-fix dead rate is ${(stats.deadRate * 100).toFixed(1)}% (${stats.dead}/${stats.launches}) — still over the ${(DEFAULTS.deadRateFloor * 100).toFixed(0)}% floor; the wrapper-detection fix has not resolved the dead-launch rate`
  );
});
