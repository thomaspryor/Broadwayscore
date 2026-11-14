// BRO-3325 what-else (2026-09-15): Scrapingdog bills only successful requests
// (A0 billing probe, #213) but both SD call sites booked failures at full tier
// cost in data/audit/scraper-spend-ledger.jsonl — ~9,900 phantom credits in 7
// days. sdBilledCredits() is the single billing rule, beside sbBilledCredits.
// Requires the real function — never a copy (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sdBilledCredits, sbBilledCredits } = require('../../scripts/lib/provider-telemetry.js');

test('a successful SD call books its full tier cost (plain 1, dynamic 5, stealth 10/20, SERP 5)', () => {
  for (const cr of [1, 5, 10, 20]) assert.equal(sdBilledCredits(true, cr), cr);
});

test('every failed SD call books 0 — 404 "URL does not exist", "won’t be charged" 400/500s, timeouts, SERP 400s alike', () => {
  for (const cr of [1, 5, 10, 20, 60]) assert.equal(sdBilledCredits(false, cr), 0);
  assert.equal(sdBilledCredits(undefined, 5), 0);
});

test('shape matches the ScrapingBee rule it sits beside (a failed request that never billed is 0 there too)', () => {
  assert.equal(sbBilledCredits('error', 5), 0);
  assert.equal(sbBilledCredits(200, 5), 5);
});
