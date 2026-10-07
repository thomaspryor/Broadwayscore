/**
 * verify-update-show-status-no-cancellations.test.mjs — the RECHECK-AFTER
 * acceptance command for task #1814 ("update-show-status.yml runs keep
 * ending CANCELLED"). Fixed 2026-08-19 by raising the job timeout 75->130min
 * (this repo, commit 0d3716a9ba8) and, independently, capping the shared
 * setup-playwright composite action's install step at a shell-level
 * `timeout 480` (task #1815, already merged) — composite-action steps don't
 * support the `timeout-minutes` key.
 *
 * Unlike this repo's usual colocated tests, this one deliberately asserts
 * against LIVE GitHub Actions run history (`gh run list`) rather than a
 * fixture — its whole purpose is to be re-run by
 * scripts/autonomous-acceptance-recheck.js days after today, against
 * whatever real scheduled/dispatched runs have actually landed by then.
 * A red run here is not a code regression; it is the claim being disproven.
 *
 * Per the card's acceptance criteria: "Cancelled runs must be EXCLUDED when
 * counting... because a cancelled run carries no signal in either
 * direction." So this walks completed runs since the fix landed, skips
 * (does not count, does not fail on) any that were cancelled, and requires
 * 5 non-cancelled completed runs (success or failure — only "cancelled" is
 * disqualifying) in that window. Cancelled runs encountered are reported
 * but do not themselves fail the test, per that instruction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const FIX_LANDED_AT = '2026-08-19T10:19:28Z'; // commit 0d3716a9ba8 author date
const REQUIRED_STREAK = 5;
const LOOKBACK_LIMIT = 30; // generous window in case cancellations recur

test('update-show-status.yml has 5 non-cancelled completed runs since the timeout fix landed', () => {
  let raw;
  try {
    raw = execFileSync(
      'gh',
      [
        'run', 'list',
        '--workflow=update-show-status.yml',
        `--limit=${LOOKBACK_LIMIT}`,
        '--json=databaseId,status,conclusion,createdAt',
      ],
      { encoding: 'utf8' }
    );
  } catch (e) {
    assert.fail(`gh run list failed — is gh authenticated on this machine? ${e.message}`);
  }

  const runs = JSON.parse(raw)
    .filter((r) => r.status === 'completed' && r.createdAt >= FIX_LANDED_AT)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first

  const cancelled = runs.filter((r) => r.conclusion === 'cancelled');
  const nonCancelled = runs.filter((r) => r.conclusion !== 'cancelled');

  assert.ok(
    nonCancelled.length >= REQUIRED_STREAK,
    `only ${nonCancelled.length} non-cancelled completed run(s) since the fix ` +
      `(${FIX_LANDED_AT}), needs >= ${REQUIRED_STREAK}. ` +
      `${cancelled.length} cancelled run(s) excluded from the count: ` +
      `${cancelled.map((r) => r.databaseId).join(', ') || 'none'}.`
  );
});
