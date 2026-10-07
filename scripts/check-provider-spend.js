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
 * Runs in data-health-check.yml (daily 02:15 UTC, has all provider secrets,
 * commits data/audit). CLI: --dry-run (no writes, no alerts), --day=YYYY-MM-DD.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const {
  fetchBdZoneCostDay, fetchBbUsageForDay, fetchSbUsage, fetchSdAccount,
} = require('./lib/provider-billing');
const {
  computeDayRecord, budgetBreaches, computeStreak, renderSnapshot, utcYesterday, aggregateLedgerByDay,
  ledgerFreshnessHours, missingLedgerDays, STALE_HOURS_THRESHOLD, CONTINUITY_WINDOW_DAYS,
  attributionGaps, attributionWindowVerdict,
} = require('./lib/provider-spend-core');
const {
  countCallsByProvider, topCallers, creditsByProvider, topCallersByCredits,
  computeAttributedPct, CREDIT_BILLED_PROVIDERS, BILLING_COUNT_FIELD, LEDGER_PATH: CALL_LEDGER_PATH,
} = require('./lib/provider-telemetry');

const REPO = path.join(__dirname, '..');
const LEDGER = path.join(REPO, 'data', 'audit', 'provider-spend-daily.jsonl');
const SNAPSHOT = path.join(REPO, 'data', 'audit', 'provider-spend-snapshot.json');
const THRESHOLDS_PATH = path.join(REPO, 'scripts', 'config', 'provider-spend-thresholds.json');
// BRO-3349: these four moved to lib/provider-spend-core.js (imported above)
// so scripts/health-check.js's "Data quality: provider spend ledger" row can
// share the SAME freshness predicate instead of re-deriving it. They are
// re-exported below unchanged, so every existing caller/test of this script's
// module surface keeps working. Why the move rather than health-check.js
// requiring this file directly: this file is a CLI with top-level side
// effects (hasHelpFlag/process.exit, argv-derived DAY), and provider-spend-
// core.js is the file whose own docstring already claims ownership of "pure
// decision functions" for this subsystem.
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

  // BRO-3227: check the ledger AS COMMITTED (before this run adds anything)
  // — this run's own write always looks fresh by construction, so freshness/
  // continuity only means something measured against what survived to disk.
  const now = new Date();
  const freshnessHours = ledgerFreshnessHours(ledger, now);
  const missingDays = missingLedgerDays(ledger, now, CONTINUITY_WINDOW_DAYS);
  const ledgerUnhealthy = freshnessHours > STALE_HOURS_THRESHOLD || missingDays.length > 0;
  if (ledgerUnhealthy) {
    const parts = [];
    if (freshnessHours > STALE_HOURS_THRESHOLD) {
      const ageText = Number.isFinite(freshnessHours) ? `${freshnessHours.toFixed(1)}h` : 'no entries ever recorded';
      parts.push(`most recent entry was ${ageText} old before this run (> ${STALE_HOURS_THRESHOLD}h threshold)`);
    }
    if (missingDays.length) parts.push(`missing day(s) in the trailing ${CONTINUITY_WINDOW_DAYS}: ${missingDays.join(', ')}`);
    console.error(`::error::provider-spend-daily.jsonl is stale/discontinuous — ${parts.join('; ')}. Continuing so today's (${DAY}) entry can still land.`);
  }

  const zone = process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
  const [bbUsage, bdSerp, bdUnlocker, sb, sd] = await Promise.all([
    fetchBbUsageForDay(process.env.BROWSERBASE_API_KEY, process.env.BROWSERBASE_PROJECT_ID, DAY),
    fetchBdZoneCostDay('serp_api1', DAY, process.env.BRIGHTDATA_TOKEN),
    fetchBdZoneCostDay(zone, DAY, process.env.BRIGHTDATA_TOKEN),
    fetchSbUsage(process.env.SCRAPINGBEE_API_KEY),
    fetchSdAccount(process.env.SCRAPINGDOG_API_KEY),
  ]);

  const record = computeDayRecord({
    day: DAY,
    bb: bbUsage,
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
  // ScrapingBee/Scrapingdog "dayCredits" is the counter delta since the
  // previous record's reading, not the UTC day. Sum ledger credits over that
  // same window once the previous record carries its reading time; comparing
  // a ~13:00->13:00 billed window to a 00:00->24:00 ledger day put
  // Scrapingdog at 13% on 2026-09-28 when the matching window was ~81%.
  record.capturedAt = now.toISOString();
  const creditScope = prev && prev.capturedAt && prev.capturedAt < record.capturedAt
    ? { from: prev.capturedAt, to: record.capturedAt }
    : DAY;
  const ledgerCredits = creditsByProvider(callLedger, creditScope);
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
      ? topCallersByCredits(callLedger, creditScope, provider, 5).map((t) => ({ script: t.script, amount: t.credits }))
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

  // BRO-4215: computed before the dry-run return so --dry-run shows them.
  const attributionAlertProviders = thresholds.attributionAlertProviders || ['scrapingbee', 'scrapingdog', 'brightdata'];
  const attributionAlertMin = thresholds.attributionAlertMin ?? 0.8;
  const gaps = attributionGaps(series, {
    min: attributionAlertMin,
    days: thresholds.attributionAlertDays ?? 2,
    providers: attributionAlertProviders,
  });
  for (const gap of gaps) {
    console.log(`[provider-spend] ${DAY}: attribution gap — ${gap.provider} ${gap.pcts.map((p) => `${Math.round(p * 100)}%`).join(', ')} (< ${Math.round(attributionAlertMin * 100)}%)`);
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

  // BRO-4215: a SUSTAINED attribution gap is its own actionable condition.
  // Until now a low attributedPct only added a digest line; ScrapingBee sat at
  // 12-23% for weeks (Reddit Sentiment + Show Score rows discarded at runner
  // exit) and the same gap would have alerted on 29 days back to 2026-08-02.
  // disposition 'auto' files a card and dispatches a fix session, so a gap is
  // worked instead of observed. One conditionKey per provider. Wrapped so a
  // router failure here can never skip the stale-ledger alert below.
  try {
  for (const gap of gaps) {
    const { routeAlert } = require('./lib/owner-alert-router');
    const pctText = gap.pcts.map((p) => `${Math.round(p * 100)}%`).join(', ');
    const top = (attribution[gap.provider]?.top || []).map((t) => `${t.script} ${t.amount}`).join('; ');
    await routeAlert({
      conditionKey: `provider-spend:attribution-gap:${gap.provider}`,
      title: `Untracked ${gap.provider} spend: ledger explains only ${pctText} of billed`,
      description: `data/audit/provider-spend-daily.jsonl attributedPct.${gap.provider} was below ${Math.round(attributionAlertMin * 100)}% on each of the last ${gap.pcts.length} days (${pctText}), so most of this provider's billed spend comes from callers whose rows never reach data/audit/scraper-spend-ledger.jsonl. Top logged callers today: ${top || 'none'}.`,
      hint: 'Method that found BRO-4215: (1) collect the provider balance readings CI logs print (ScrapingBee: "[SB Credits] N remaining" from scraper.js checkScrapingBeeCredits) across job logs for one day; (2) per interval, compare billed delta vs ledger rows in that window; (3) list workflow runs active in high-gap intervals and absent in matched ones; (4) grep those job logs for "[SB Call]"/"[SD Call]" lines to confirm. Usual causes: a job that writes telemetry but never commits the ledger (bash scripts/lint-workflow-guards.sh ledger-coverage), a script calling the provider with no record*Call (node --test scripts/lib/sb-call-telemetry-coverage.test.mjs), or runs in progress when the day closed.',
      severity: 'error',
      disposition: 'auto',
      cooldownHours: 72,
      cardAction: 'Investigate',
      // Machine-checkable finish line (SAFE_CHECK_FORMS in autonomous-triage-core.js),
      // so the parked-card drain can dispatch it and the Done gate can close it.
      verify: { line: `VERIFY: node scripts/check-attribution-gap-clear.js --provider=${gap.provider}` },
    });
  }
  // Gap closed today: resolve the condition so a later regression files a fresh
  // card immediately instead of waiting out the 72h cooldown.
  {
    const { resolveCondition } = require('./lib/owner-alert-router');
    for (const provider of attributionAlertProviders) {
      // Same rule as the card's VERIFY (check-attribution-gap-clear.js): the whole
      // alert window must be clear, or one good day would resolve the condition
      // and let the next bad pair file a duplicate card.
      const v = attributionWindowVerdict(series, provider, {
        min: attributionAlertMin, days: thresholds.attributionAlertDays ?? 2,
      });
      if (v.verdict === 'clear') {
        resolveCondition(`provider-spend:attribution-gap:${provider}`, { reason: `attributedPct ${v.pcts.map((p) => Math.round(p * 100) + '%').join(', ')} through ${DAY}` });
      }
    }
  }
  } catch (err) {
    console.log(`::warning::attribution-gap alerting failed: ${err.message}`);
  }

  // BRO-3227: fires independently of the overspend/unmeasured breach above —
  // a stale/discontinuous ledger is a "the truth layer itself is broken"
  // condition, not a spend condition, so it gets its own conditionKey and
  // survives even on a day with no budget breach at all. Routed AFTER this
  // run's own write lands, so a real fix (today's entry landing) is on
  // record even if this alert is what someone acts on.
  if (ledgerUnhealthy) {
    const { routeAlert } = require('./lib/owner-alert-router');
    const parts = [];
    if (freshnessHours > STALE_HOURS_THRESHOLD) {
      const ageText = Number.isFinite(freshnessHours) ? `${freshnessHours.toFixed(1)}h` : 'no entries ever recorded';
      parts.push(`most recent entry was ${ageText} old before this run`);
    }
    if (missingDays.length) parts.push(`missing day(s): ${missingDays.join(', ')}`);
    await routeAlert({
      conditionKey: 'provider-spend:stale-ledger',
      title: 'Provider spend ledger is stale or discontinuous',
      description: `Before today's (${DAY}) write: ${parts.join('; ')}. See data/audit/provider-spend-daily.jsonl.`,
      hint: 'Check whether check-provider-spend.js ran on the missing day(s), and whether its write survived a later push-with-retry.sh hard-reset (BRO-3317 class bug) — that class silently discarded 11 days of this same ledger once already.',
      severity: 'warn',
      disposition: 'digest',
      cooldownHours: 20,
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`::error::check-provider-spend crashed: ${err && err.message}`);
    process.exit(1);
  });
}

module.exports = {
  ledgerFreshnessHours, missingLedgerDays, STALE_HOURS_THRESHOLD, CONTINUITY_WINDOW_DAYS,
};
