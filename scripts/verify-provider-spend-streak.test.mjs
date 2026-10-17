/**
 * verify-provider-spend-streak.test.mjs — the RECHECK-AFTER acceptance
 * command for the scraping-v2 "spend stays within thresholds" claim (task
 * #695, mechanical backstop to the crowned verifier at workspace:219).
 *
 * Unlike this repo's usual colocated tests, this one deliberately asserts
 * against LIVE repo data (data/audit/provider-spend-daily.jsonl) rather than
 * a fixture — its whole purpose is to be re-run by
 * scripts/autonomous-acceptance-recheck.js days after today, against
 * whatever the daily reconciliation (scripts/check-provider-spend.js) has
 * actually recorded by then. A red run here is not a code regression; it is
 * the claim being disproven, which is exactly the signal this card's
 * RECHECK-AFTER stamp exists to produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { computeStreak } = require('./lib/provider-spend-core.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, '..', 'data', 'audit', 'provider-spend-daily.jsonl');
const THRESHOLDS_PATH = path.join(HERE, 'config', 'provider-spend-thresholds.json');

test('scraping spend has held within thresholds for 7+ consecutive fully-measured days', () => {
  let lines;
  try {
    lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  } catch {
    assert.fail(`no provider-spend ledger at ${LEDGER} yet — check-provider-spend.js has not accumulated enough daily history`);
  }
  const records = lines.map((l) => JSON.parse(l)).sort((a, b) => (a.day < b.day ? -1 : 1));
  const thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf8'));
  const streak = computeStreak(records, thresholds);
  assert.ok(streak >= 7, `verification streak is ${streak} day(s), needs >= 7 consecutive fully-measured, within-budget days`);
});
