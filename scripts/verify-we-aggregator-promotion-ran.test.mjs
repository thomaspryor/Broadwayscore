/**
 * verify-we-aggregator-promotion-ran.test.mjs — the RECHECK-AFTER acceptance
 * command for task #1466 (West End aggregator-listing auto-promotion
 * backstop). Unit tests already cover decideWestEndAggregatorPromotion /
 * buildWestEndAggregatorShowEntry logic against fixtures — what those can't
 * prove is that the scheduled cron (.github/workflows/promote-we-aggregator.yml,
 * daily 14:30 UTC) actually executed in production against real WET/LBO pages.
 *
 * This asserts against LIVE repo data (data/audit/we-promotion-log.jsonl)
 * rather than a fixture, so it's meant to be re-run by
 * scripts/autonomous-acceptance-recheck.js after the cron's first scheduled
 * fire. A red run here is not a code regression — it's the "the backstop is
 * live" claim not yet being provable, which is exactly what the RECHECK-AFTER
 * stamp on this card exists to catch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, '..', 'data', 'audit', 'we-promotion-log.jsonl');

// First scheduled fire of promote-we-aggregator.yml (cron: '30 14 * * *') after
// the feature merged to main on 2026-08-14.
const EARLIEST_VALID_RUN = '2026-08-15T00:00:00.000Z';

test('promote-we-aggregator-candidates.js has run at least once in production since merge', () => {
  let lines;
  try {
    lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  } catch {
    assert.fail(`no promotion log at ${LOG} yet — the scheduled cron has not run since the feature merged`);
  }
  const records = lines.map((l) => JSON.parse(l));
  const postMergeRuns = records.filter((r) => r.timestamp >= EARLIEST_VALID_RUN);
  assert.ok(
    postMergeRuns.length > 0,
    `no we-promotion-log.jsonl entries at/after ${EARLIEST_VALID_RUN} — cron has not produced a real run yet`
  );
});
