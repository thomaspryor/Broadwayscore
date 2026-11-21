/**
 * verify-land-checks-goal.test.mjs: the RECHECK-AFTER acceptance probe for
 * BRO-7324 ("make landing faster without removing a check").
 *
 * Goal: the land.yml Checks job takes a median under 20 min over the last 10
 * landings that ran the two-runner split with pinned core data, with all 10
 * gauntlet gates in the verdict. Reads the LIVE ledger
 * (data/audit/landings.jsonl), not a fixture, like
 * scripts/verify-provider-spend-streak.test.mjs. The Checks wall on each row is
 * the jobs API's, written by the Land job; `land-gauntlet/branch` wallSecs
 * leaves out the collect wait and the local fallback, so it is not used.
 * A red run is the goal not met yet (or disproven), not a code regression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { checksGoal, GOAL } = require('./lib/land-timing-report.js');
const { readLandings } = require('./lib/landings-ledger.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// RECHECK-AFTER date: ten pinned split landings need a few days to accumulate. Before it the
// probe skips, because the Land job runs every changed *.test.mjs as colocated-tests and a red
// probe would refuse its own landing (and every merge train it rides in).
// land-timing-report.test.mjs pins that it skips today.
const CHECKABLE_FROM = Date.parse('2026-11-28T00:00:00Z');

test(`land.yml Checks median < ${GOAL.medianSecs / 60} min over the last ${GOAL.landings} pinned split landings, all ${GOAL.gates} gates`, {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-28 (RECHECK-AFTER)',
}, () => {
  const led = readLandings(ROOT);
  assert.ok(led.available, 'data/audit/landings.jsonl not found');
  const g = checksGoal(led.rows);
  const detail = g.rows.map((r) => `${r.branch} ${r.timing.checks.wallSecs}s (${r.timing.checks.nodeShard})`).join(', ');
  assert.ok(g.ok, `${g.reason}${detail ? `; counted: ${detail}` : ''}`);
});
