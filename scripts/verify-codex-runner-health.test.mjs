// BRO-5287 live acceptance (RECHECK-AFTER probe; not in the unit batches, see
// scripts/lib/unit-test-collection.js): the Codex runner's summaries on BRO-4745 since the
// last fix landed show at least 3 runs, none stopped by a lost lock, and at least one landing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./lib/load-env').loadEnv();
const linear = require('./lib/linear-client.js');
const { assessRunnerSummaries } = require('./lib/codex-runner.js');

// The 04:47 UTC firing on 2026-10-14 is the first with the lock fixes (the land-push fix landed 06:33).
const SINCE = process.env.CODEX_HEALTH_SINCE || '2026-10-14T04:40:00Z';
// = the card's RECHECK-AFTER. Before it the claim cannot be true yet (3 firings have not run),
// and land's colocated-tests gate runs every changed test file, so the probe skips until then
// (same pattern as verify-bro-3490-recheck.test.mjs).
const CHECKABLE_FROM = Date.parse('2026-10-15T00:00:00Z');

test('Codex runner: 3+ runs since the BRO-5287 fixes, no lock stops, something landed', {
  skip: Date.now() < CHECKABLE_FROM && !process.env.CODEX_HEALTH_SINCE ? 'not checkable before 2026-10-15 (3 board-workers firings after the fixes)' : false,
}, async () => {
  const comments = (await linear.listIssueComments(['BRO-4745'])).get('BRO-4745') || [];
  const bodies = comments.filter((c) => c.createdAt >= SINCE).map((c) => c.body);
  const verdict = assessRunnerSummaries(bodies);
  assert.ok(verdict.ok, `${verdict.runs} runs, ${verdict.landed} landed: ${verdict.problems.join('; ')}`);
});
