#!/usr/bin/env node
/**
 * check-provider-spend.js — daily billing-API reconciliation (Scraping Cost
 * System v2, Sprint 0; plan: claude-outputs/scraping-cost-system-v2-plan.md).
 *
 * Reads yesterday-agnostic ground truth from each provider's billing API,
 * appends one record per UTC day to data/audit/provider-spend-daily.jsonl
 * (idempotent: re-running a day replaces that day's record), and writes
 * data/audit/provider-spend-snapshot.json for the morning digest
 * (digest-snapshots.js registry). Breaches route through owner-alert-router.
 *
 * FAIL-CLOSED: an unreachable billing API records status 'unknown' for that
 * provider — the day cannot count toward the 7-day verification streak and
 * the digest says "could not measure", never "within budget". Exit code stays
 * 0 for unknown providers (observability must not kill the carrier workflow);
 * only a programming error exits non-zero.
 *
 * Runs in data-health-check.yml (daily 06:45 UTC, has all provider secrets,
 * commits data/audit). CLI: --dry-run (no writes, no alerts), --day=YYYY-MM-DD.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const {
  fetchBdZoneCostDay, fetchBbSessionCountForDay, fetchSbUsage, fetchSdAccount,
} = require('./lib/provider-billing');
const {
  computeDayRecord, budgetBreaches, computeStreak, renderSnapshot, utcYesterday, aggregateLedgerByDay,
} = require('./lib/provider-spend-core');
const {
  countCallsByProvider, topCallers, creditsByProvider, topCallersByCredits,
  computeAttributedPct, CREDIT_BILLED_PROVIDERS, BILLING_COUNT_FIELD, LEDGER_PATH: CALL_LEDGER_PATH,
} = require('./lib/provider-telemetry');

const REPO = path.join(__dirname, '..');
const LEDGER = path.join(REPO, 'data', 'audit', 'provider-spend-daily.jsonl');
const SNAPSHOT = path.join(REPO, 'data', 'audit', 'provider-spend-snapshot.json');
const THRESHOLDS_PATH = path.join(REPO, 'scripts', 'config', 'provider-spend-thresholds.json');
// S0-T6: durable daily rollup of the per-call ledger. The raw ledger
// (CALL_LEDGER_PATH, provider-telemetry.js) rotates at MAX_LEDGER_LINES —
// under a day at unthrottled Scrapingdog volume — so it cannot answer a
// 7-day attribution question by itself. This file is NEVER rotated; each
// day's rows are written once and, on re-run, idempotently replaced (same
// pattern as LEDGER above).
const DAILY_AGG = path.join(REPO, 'data', 'audit', 'scraper-spend-daily-agg.jsonl');

if (hasHelpFlag(process.argv)) {
  console.log('Usage: node scripts/check-provider-spend.js [--dry-run] [--day=YYYY-MM-DD]\n'
    + 'Daily scraping-spend reconciliation against provider billing APIs.\n'
    + 'Default day is YESTERDAY (UTC) — the last COMPLETE day. Reconciling the\n'
    + 'in-progress day would permanently record a few-hours-old partial figure.\n'
    + 'Writes data/audit/provider-spend-daily.jsonl + provider-spend-snapshot.json.');
  process.exit(0);
}

const DRY_RUN = process.argv.includes('--dry-run');
const dayArg = (process.argv.find((a) => a.startsWith('--day=')) || '').slice(6);
const DAY = /^\d{4}-\d{2}-\d{2}$/.test(dayArg) ? dayArg : utcYesterday();

function readLedger() {
  let lines;
  try { lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); }
    catch { /* a corrupt line loses one day, never the run */ }
  }
  return records.sort((a, b) => (a.day < b.day ? -1 : 1));
}

// The per-call attribution ledger (scripts/lib/provider-telemetry.js, task
// #752) — separate file from the billing ledger above. Same
// corrupt-line-tolerant read; a bad row loses one call record, never the run.
function readCallLedger() {
  let lines;
  try { lines = fs.readFileSync(CALL_LEDGER_PATH, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); }
    catch { /* skip corrupt line */ }
  }
  return records;
}

// Same corrupt-line-tolerant read as the ledgers above; a bad row loses one
// aggregate record, never the run.
function readDailyAgg() {
  let lines;
  try { lines = fs.readFileSync(DAILY_AGG, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); }
    catch { /* skip corrupt line */ }
  }
  return records;
}

async function main() {
  let thresholds;
  try {
    thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf8'));
  } catch (err) {
    // A broken thresholds file must be loud, not a silent green: crash with
    // ::error:: — the stale snapshot then trips the digest 36h staleness banner.
    throw new Error(`thresholds config unreadable at ${THRESHOLDS_PATH}: ${err.message}`);
  }
  const ledger = readLedger();
  const prev = [...ledger].reverse().find((r) => r.day < DAY) || null;

  const zone = process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
  const [bbSessions, bdSerp, bdUnlocker, sb, sd] = await Promise.all([
    fetchBbSessionCountForDay(process.env.BROWSERBASE_API_KEY, process.env.BROWSERBASE_PROJECT_ID, DAY),
    fetchBdZoneCostDay('serp_api1', DAY, process.env.BRIGHTDATA_TOKEN),
    fetchBdZoneCostDay(zone, DAY, process.env.BRIGHTDATA_TOKEN),
    fetchSbUsage(process.env.SCRAPINGBEE_API_KEY),
    fetchSdAccount(process.env.SCRAPINGDOG_API_KEY),
  ]);

  const record = computeDayRecord({
    day: DAY,
    bb: bbSessions,
    bd: bdSerp == null || bdUnlocker == null ? null : { serp: bdSerp, unlocker: bdUnlocker },
    sb,
    sd,
    prev,
  });

  // attributedPct (task #752): compare the call-level ledger against the
  // billing-API totals just fetched. This is what converts "we believe we
  // capture all scraping spend" into a number that fails loudly when it's
  // wrong — the exact gap that let the Aug 1 Browserbase rebound go unnamed.
  const callLedger = readCallLedger();
  const ledgerCounts = countCallsByProvider(callLedger, DAY);
  const ledgerCredits = creditsByProvider(callLedger, DAY);
  const attributedPct = computeAttributedPct(ledgerCounts, record.providers, ledgerCredits);
  record.attributedPct = attributedPct;
  // Billed-unit denominator per provider — reuses provider-telemetry.js's
  // BILLING_COUNT_FIELD directly (not a re-typed copy) so this can't drift
  // from computeAttributedPct's own denominator if the mapping ever changes.
  const attribution = {};
  for (const provider of Object.keys(attributedPct)) {
    if (attributedPct[provider] == null) continue;
    const isCreditBased = CREDIT_BILLED_PROVIDERS.has(provider);
    const top = isCreditBased
      ? topCallersByCredits(callLedger, DAY, provider, 5).map((t) => ({ script: t.script, amount: t.credits }))
      : topCallers(callLedger, DAY, provider, 5).map((t) => ({ script: t.script, amount: t.count }));
    const billingUnit = BILLING_COUNT_FIELD[provider](record.providers[provider] || {});
    const topSum = top.reduce((s, t) => s + t.amount, 0);
    const topCoveragePct = billingUnit ? Math.min(1, topSum / billingUnit) : (billingUnit === 0 ? 1 : null);
    attribution[provider] = {
      pct: attributedPct[provider], top, unit: isCreditBased ? 'credits' : 'calls', topCoveragePct,
    };
  }

  const breaches = budgetBreaches(record, thresholds);
  const series = [...ledger.filter((r) => r.day !== DAY), record];
  const streak = computeStreak(series, thresholds);
  const snapshot = renderSnapshot({
    record, streak, breaches, generatedAt: new Date().toISOString(), attribution,
    attributionCoverageMin: thresholds.attributionCoverageMin ?? 0.8,
  });

  console.log(`[provider-spend] ${DAY}: ${snapshot.bannerText}`);
  for (const item of snapshot.items) console.log(`  ${item.title}`);

  // S0-T6: roll today's per-call ledger into the durable daily aggregate
  // BEFORE the raw ledger rotates it away. Idempotent by day, same as LEDGER.
  const todaysAggRows = aggregateLedgerByDay(callLedger, DAY);
  const existingAgg = readDailyAgg();
  const aggSeries = [...existingAgg.filter((r) => r.day !== DAY), ...todaysAggRows];
  console.log(`[provider-spend] ${DAY}: daily aggregate — ${todaysAggRows.length} (provider,workflow,script,fn) row(s)`);
  for (const row of todaysAggRows.slice(0, 5)) {
    console.log(`  ${row.provider} ${row.credits}cr / ${row.calls} calls — ${row.script} (${row.fn}, workflow=${row.workflow || 'none'})`);
  }

  if (DRY_RUN) {
    console.log('[provider-spend] --dry-run: no writes, no alerts');
    return;
  }

  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, series.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n');
  fs.writeFileSync(DAILY_AGG, aggSeries.map((r) => JSON.stringify(r)).join('\n') + '\n');

  if (breaches.overspend.length || breaches.unmeasured.length) {
    const { routeAlert } = require('./lib/owner-alert-router');
    const over = breaches.overspend.length > 0;
    await routeAlert({
      conditionKey: `provider-spend:${over ? 'overspend' : 'unmeasured'}`,
      // Stable title (BRO-232 S4 — breach detail lives in description/
      // decisionPrompt): headStandsAlone requires decisionPrompt's clipped
      // head to name the title verbatim (owner-alert-router.js), so a
      // per-day-varying provider/amount list in the title would make that
      // match unreliable. Mirrors check-linear-cap.js's decision:true row.
      title: over ? 'Scraping spend over budget' : 'Scraping spend unmeasurable',
      description: over
        ? `Day ${DAY}. Over budget: ${breaches.overspend.join('; ')}. ${snapshot.items.map((i) => i.title).join(' · ')}. Verification streak reset to ${streak}.`
        : `Day ${DAY}. Unmeasurable: ${breaches.unmeasured.join(', ')}. ${snapshot.items.map((i) => i.title).join(' · ')}. Verification streak reset to ${streak}.`,
      hint: over
        ? 'Attribute via data/audit/provider-spend-daily.jsonl trend + the Monday cost report top-consumer table; the v2 plan file lists the demand levers.'
        : 'Billing API unreachable — check the provider key/status in check-secrets-health before trusting any green day.',
      severity: over ? 'error' : 'warn',
      disposition: 'digest',
      cooldownHours: 20,
      // Genuine judgment call (BRO-232 S4, the "credit burn" example from
      // task #1184's follow-up plan): raise the budget or cut usage is an
      // owner policy decision, not something a dispatched fix session can
      // resolve — a "BSC Daily: Scraping spend over budget" P1 card can
      // never mechanically satisfy its own verify command. The unmeasurable
      // branch stays a normal auto-fix candidate (its hint is literally
      // "check the provider key/status" — a real technical investigation).
      ...(over ? {
        decision: true,
        decisionPrompt: `Scraping spend over budget: ${breaches.overspend.join('; ')}. Should I raise the daily budget, or do you want scraping volume cut to stay within it?`,
      } : {}),
    });
  }
}

main().catch((err) => {
  console.error(`::error::check-provider-spend crashed: ${err && err.message}`);
  process.exit(1);
});
