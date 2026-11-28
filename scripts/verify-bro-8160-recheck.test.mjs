/**
 * verify-bro-8160-recheck.test.mjs: RECHECK-AFTER probe for BRO-8160.
 *
 * Claim: after the Gemini code reviewer moved from the agentic CLI (about
 * $190/day) to one packed request per review, daily Gemini spend stays low.
 * Reads the LIVE session usage ledger (data/audit/llm-session-usage.jsonl),
 * not a fixture, so it is exempt from CI (EXEMPT_NEVER_CI in
 * scripts/audit-orphan-tests.js) and skipped until full days have accumulated.
 *
 * BRO8160_FROM_DAY / BRO8160_FORCE let a run check an earlier window (used to
 * prove the probe goes red on the pre-fix day 2026-11-23).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, '..', 'data', 'audit', 'llm-session-usage.jsonl');
const CHECKABLE_FROM = Date.parse('2026-11-26T00:00:00Z');
const FROM_DAY = process.env.BRO8160_FROM_DAY || '2026-11-24'; // first full day after the landing
const FORCE = process.env.BRO8160_FORCE === '1';
const MAX_DAILY_USD = 25;

export function dailyGeminiSpend(rows, fromDay, beforeDay) {
  const byDay = {};
  for (const r of rows) {
    if (r.provider !== 'gemini' || !r.ts) continue;
    const day = r.ts.slice(0, 10);
    if (day < fromDay || (beforeDay && day >= beforeDay)) continue;
    byDay[day] = (byDay[day] || 0) + (Number(r.costUsd) || 0);
  }
  return byDay;
}

test('Gemini spend stays under $25 on every full day since the BRO-8160 landing', {
  skip: !FORCE && Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-26',
}, () => {
  const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const today = new Date().toISOString().slice(0, 10);
  const byDay = dailyGeminiSpend(rows, FROM_DAY, FORCE ? null : today);
  const days = Object.keys(byDay).sort();
  assert.ok(days.length >= 1, `no Gemini spend rows since ${FROM_DAY}: no evidence either way (is the session ledger being written?)`);
  const over = days.filter((d) => byDay[d] > MAX_DAILY_USD);
  assert.deepEqual(over, [], `days over $${MAX_DAILY_USD}: ${over.map((d) => `${d}=$${byDay[d].toFixed(2)}`).join(', ')}`);
});
