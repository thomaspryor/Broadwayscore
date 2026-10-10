/**
 * verify-main-green-streak.test.mjs — the RECHECK-AFTER acceptance command for
 * the "main stays green for 24 hours" hold (2026-08-14 recovery, after nine
 * consecutive green test.yml runs ended a multi-day red).
 *
 * RECHECK-AFTER: 2026-08-15
 * Acceptance command: node --test scripts/verify-main-green-streak.test.mjs
 *
 * Same shape as scripts/verify-provider-spend-streak.test.mjs and
 * scripts/verify-seo-health-clean.test.mjs: a DEFERRED-EFFECT probe, not a unit
 * test. It deliberately asserts against LIVE committed repo data
 * (data/audit/trunk-status-snapshot.json, written daily by
 * scripts/produce-trunk-snapshot.js in data-health-check.yml) rather than a
 * fixture, because its whole purpose is to be re-run by
 * scripts/autonomous-acceptance-recheck.js days after today, against whatever
 * main's CI has actually done by then. A red run here is not a code regression;
 * it is the "main stayed green" claim being disproven, which is exactly the
 * signal the RECHECK-AFTER stamp exists to produce. It is EXEMPT_NEVER_CI in
 * scripts/audit-orphan-tests.js for that reason — CI must never run it.
 *
 * Why the snapshot and not `gh run list`: the recheck executes acceptance
 * commands with the check gauntlet's secret-free, fake-HOME env
 * (scripts/lib/autonomous-checks.js checksEnv — KEEP_ENV is PATH/HOME/TERM/
 * LANG/LC_ALL/NODE_ENV only), so `gh` is unauthenticated there. The committed
 * snapshot is the offline record of the same `gh run list --workflow test.yml
 * --branch main --limit 100` query, which is what makes this evaluable
 * non-interactively.
 *
 * TIMING NOTE (expected, not a bug): in data-health-check.yml the recheck step
 * runs BEFORE the produce-trunk-snapshot step, so the snapshot this reads is
 * the PREVIOUS day's. The green streak began the evening of 2026-08-14, so the
 * first evaluation (the 2026-08-15 run) can legitimately report "green, but not
 * yet 24h" — that is the honest answer at that moment. The recheck re-runs
 * nightly in shadow mode and flips to a pass the first morning the 24-hour hold
 * is genuinely met. Shadow mode reports; it never reopens a card either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(HERE, '..', 'data', 'audit', 'trunk-status-snapshot.json');

// The hold the owner asked for.
const REQUIRED_GREEN_HOURS = 24;
// A streak, not one lucky run. Nine was the count when the hold was set; the
// bar is deliberately not raised above it, so this asserts "the streak held",
// not "the streak grew".
const REQUIRED_CONSECUTIVE_SUCCESSES = 9;
// The snapshot is produced once a day and read a step earlier in the same job,
// so a ~24h-old file is the NORMAL case. 48h tolerates one skipped daily run
// without turning a stale-data problem into a false "main went red" report —
// staleness is asserted separately below so it can never pass silently.
const MAX_SNAPSHOT_AGE_H = 48;

test('main test.yml has held green for 24h (trunk snapshot)', () => {
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  } catch (e) {
    assert.fail(`no trunk snapshot at ${SNAPSHOT} (${e.message}) — produce-trunk-snapshot.js has not run, so main's CI state is unknown, not proven green`);
  }

  assert.equal(snap.workflow, 'test.yml', `snapshot tracks ${snap.workflow}, not test.yml`);
  assert.equal(snap.branch, 'main', `snapshot tracks ${snap.branch}, not main`);

  const ageH = (Date.now() - new Date(snap.generatedAt).getTime()) / 3600e3;
  assert.ok(Number.isFinite(ageH), `unparseable generatedAt: ${snap.generatedAt}`);
  assert.ok(ageH <= MAX_SNAPSHOT_AGE_H,
    `trunk snapshot is ${ageH.toFixed(1)}h old (max ${MAX_SNAPSHOT_AGE_H}h) — data-health-check.yml has stopped producing it, so this proves nothing about main`);

  assert.equal(snap.state, 'GREEN',
    `trunk is ${snap.state}${snap.consecutiveFailures ? ` (${snap.consecutiveFailures} consecutive failures since ${snap.redSince})` : ''} — the 24h green hold did NOT hold`);

  // Older snapshots (pre-2026-08-14) have no green-streak fields at all. Treat
  // their absence as unproven rather than as a pass — `undefined >= 9` is false
  // but silently so, and this probe must never rubber-stamp a snapshot that
  // structurally cannot answer the question.
  assert.ok(typeof snap.consecutiveSuccesses === 'number',
    'snapshot has no consecutiveSuccesses field — it predates the green-streak fields in scripts/lib/trunk-status.js and cannot prove a 24h hold');

  assert.ok(snap.consecutiveSuccesses >= REQUIRED_CONSECUTIVE_SUCCESSES,
    `only ${snap.consecutiveSuccesses} consecutive successes on main (need >= ${REQUIRED_CONSECUTIVE_SUCCESSES}) — main flapped red and back since the hold was set`);

  // greenDurationIsFloor means the streak ran off the end of the 100-run window
  // with no failure in it at all: the true duration is at least greenForHours,
  // which satisfies the bound rather than capping it.
  const heldHours = Number(snap.greenForHours);
  assert.ok(Number.isFinite(heldHours),
    `snapshot has no usable greenForHours (${snap.greenForHours}) — cannot evaluate the 24h hold`);
  assert.ok(heldHours >= REQUIRED_GREEN_HOURS || snap.greenDurationIsFloor === true,
    `main has been green for ${heldHours.toFixed(1)}h since ${snap.greenSince} — the 24h hold is not met yet as of the ${snap.generatedAt} snapshot`);
});
