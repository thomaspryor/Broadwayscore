/**
 * Monthly spend cap for the evidence-promoted review catch-up (BRO-4290).
 *
 * promote-owe-venue-candidates.js adds Off-West-End rows proven by one review
 * URL (discoverySource 'audit-review-evidence', evidenceUrls). Most are
 * closed runs nothing else gathers, so scripts/seed-evidence-review-stubs.js
 * fetches that one URL per show through ingest-review-from-url.js. The owner
 * approved this spend with a HARD monthly cap (2026-10-15): CAP_USD below is
 * the one value to change.
 *
 * Where the money is counted:
 *   - Every provider call the catch-up makes lands in the shared spend ledger
 *     (data/audit/scraper-spend-ledger.jsonl, provider-telemetry.js) tagged
 *     purpose = EVIDENCE_CATCHUP_PURPOSE, because the runner sets
 *     SCRAPER_SPEND_PURPOSE for each child.
 *   - That ledger is trimmed to the last ~2-3 days (trimLedgerLines), so it
 *     cannot answer "month to date" alone. The runner also appends one row per
 *     fetch to ROLLUP_PATH with the dollars it priced from the tagged rows.
 *   - Month to date = the larger of the two sums for the current UTC month.
 *
 * Fails CLOSED: a missing or unreadable rollup or ledger throws, and the
 * runner makes no fetch. Credits become dollars only through
 * provider-pricing.js (scripts/config/provider-pricing.json), never a literal
 * here.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { usdFor, loadProviderPricing } = require('./provider-pricing');
const { creditsFor } = require('./provider-credits');
const { BB_OVERAGE_PER_BROWSER_HOUR_USD } = require('./provider-spend-core');
const { withFileLock } = require('./file-lock');
const { writeJsonAtomic } = require('./zero-review-catchup-attempts');

/** Owner-approved hard cap, USD per UTC calendar month (BRO-4290, 2026-10-15). */
const EVIDENCE_CATCHUP_MONTHLY_CAP_USD = 20;
/** Ledger `purpose` tag on every provider call this catch-up makes. */
const EVIDENCE_CATCHUP_PURPOSE = 'evidence-catchup';
const ROLLUP_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'evidence-catchup-spend.json');

/**
 * Per-child provider budgets the runner passes to ingest-review-from-url.js
 * (scraper.js reads SB_CREDIT_BUDGET / SD_CREDIT_BUDGET per process). They
 * bound one fetch, which is what makes PROJECTED_USD_PER_FETCH a ceiling.
 */
const CHILD_SB_CREDIT_BUDGET = 10;
const CHILD_SD_CREDIT_BUDGET = 20;
// scraper.js: one Bright Data Web Unlocker request per fetchPage tier pass;
// 2 leaves room for a second pass (e.g. a Playwright-first host falling back).
const PROJECTED_BD_REQUESTS = 2;
// scraper.js fetchWithScrapingdog: a call that passes the budget check can
// still bill MAX_ATTEMPTS (2) x its tier on a transient retry.
const SD_MAX_ATTEMPTS = 2;

function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * Worst-case dollars for one fetchPage under the child budgets above.
 * @param {object} [pricing] provider-pricing.json table (fixture in tests)
 */
function projectedFetchUsd(pricing = loadProviderPricing()) {
  const sdCredits = CHILD_SD_CREDIT_BUDGET + creditsFor('sd', 'stealth') * SD_MAX_ATTEMPTS;
  const sbCredits = CHILD_SB_CREDIT_BUDGET + creditsFor('sb', 'premium');
  return usdFor('scrapingdog', sdCredits, pricing)
    + usdFor('scrapingbee', sbCredits, pricing)
    + usdFor('brightdata', PROJECTED_BD_REQUESTS, pricing);
}

/**
 * Dollars one spend-ledger row cost. Throws on a provider it cannot price,
 * so an unknown cost stops the catch-up instead of counting as $0.
 */
function priceLedgerRow(row, pricing = loadProviderPricing()) {
  const credits = Number.isFinite(row.credits) ? row.credits : 0;
  switch (row.provider) {
    case 'scrapingbee': return usdFor('scrapingbee', credits, pricing);
    case 'scrapingdog': return usdFor('scrapingdog', credits, pricing);
    // Bright Data bills per request; a budget_capped row was never sent.
    case 'brightdata': return row.status === 'budget_capped' ? 0 : usdFor('brightdata', 1, pricing);
    // Browserbase bills browser-hours; a full hour per session row
    // overstates it, which is the safe direction for a cap.
    case 'browserbase': return BB_OVERAGE_PER_BROWSER_HOUR_USD;
    default: throw new Error(`evidence-catchup-spend: cannot price provider "${row.provider}"`);
  }
}

/**
 * Parse spend-ledger text, keeping rows tagged EVIDENCE_CATCHUP_PURPOSE.
 * Untagged malformed lines are ignored (merge=union can leave them); a
 * malformed line that mentions the tag throws, since it may be our spend.
 */
function parseTaggedLedgerRows(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (!line.includes(EVIDENCE_CATCHUP_PURPOSE)) continue;
    let row;
    try { row = JSON.parse(line); } catch {
      throw new Error(`evidence-catchup-spend: unreadable ledger line carrying the ${EVIDENCE_CATCHUP_PURPOSE} tag`);
    }
    if (row && row.purpose === EVIDENCE_CATCHUP_PURPOSE) rows.push(row);
  }
  return rows;
}

/** Validate a parsed rollup; throws on anything but {version:1, fetches:[...]}. */
function assertRollup(rollup) {
  if (!rollup || typeof rollup !== 'object' || rollup.version !== 1 || !Array.isArray(rollup.fetches)) {
    throw new Error('evidence-catchup-spend: rollup is not {version:1, fetches:[]}');
  }
  for (const f of rollup.fetches) {
    if (!f || typeof f.showId !== 'string' || typeof f.month !== 'string' || !Number.isFinite(f.usd) || f.usd < 0) {
      throw new Error('evidence-catchup-spend: rollup has a malformed fetch row');
    }
  }
  return rollup;
}

/** Read the rollup. Missing file or bad JSON throws (fail closed). */
function loadRollup(filePath = ROLLUP_PATH) {
  return assertRollup(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/** Read the shared spend ledger's tagged rows. Missing file throws. */
function loadTaggedLedgerRows(filePath) {
  return parseTaggedLedgerRows(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Month-to-date dollars: the larger of the rollup's sum and the tagged
 * ledger rows' priced sum for the UTC month containing `now`.
 */
function monthToDateUsd(rollup, ledgerRows, now, pricing = loadProviderPricing()) {
  const month = monthKey(now);
  const fromRollup = assertRollup(rollup).fetches
    .filter((f) => f.month === month)
    .reduce((sum, f) => sum + f.usd, 0);
  const fromLedger = (ledgerRows || [])
    .filter((r) => typeof r.ts === 'string' && r.ts.slice(0, 7) === month)
    .reduce((sum, r) => sum + priceLedgerRow(r, pricing), 0);
  return Math.max(fromRollup, fromLedger);
}

/**
 * Proceed only if month-to-date plus the next fetch's worst case stays at or
 * under the cap. Non-finite inputs stop (NaN comparisons are always false).
 */
function decideFetch({ mtdUsd, projectedUsd, capUsd = EVIDENCE_CATCHUP_MONTHLY_CAP_USD }) {
  if (![mtdUsd, projectedUsd, capUsd].every((n) => Number.isFinite(n) && n >= 0)) {
    return { proceed: false, reason: 'spend figures unreadable' };
  }
  const after = mtdUsd + projectedUsd;
  // Round to the cent fraction before comparing so float noise at exactly the
  // cap (e.g. 19.99 + 0.01) does not refuse a fetch the cap allows.
  if (Math.round(after * 1e6) > Math.round(capUsd * 1e6)) {
    return { proceed: false, reason: `cap: $${mtdUsd.toFixed(4)} spent + $${projectedUsd.toFixed(4)} next > $${capUsd}` };
  }
  return { proceed: true, reason: `$${after.toFixed(4)} of $${capUsd} after this fetch` };
}

/**
 * Dollars the child spent: tagged rows for showId written since startIso.
 * Returns {usd, rows, estimated}: with no rows found it charges the
 * projected worst case (a child that died before writing still spent).
 */
function spendForFetch(ledgerRows, showId, startIso, pricing = loadProviderPricing()) {
  const mine = (ledgerRows || []).filter((r) => r.showId === showId && typeof r.ts === 'string' && r.ts >= startIso);
  if (mine.length === 0) return { usd: projectedFetchUsd(pricing), rows: 0, estimated: true };
  return { usd: mine.reduce((s, r) => s + priceLedgerRow(r, pricing), 0), rows: mine.length, estimated: false };
}

/** Append one fetch to the rollup under a lock (re-read fresh, then write). */
function appendRollupFetch(filePath, fetchRow) {
  withFileLock(`${filePath}.lock`, (held) => {
    if (!held) console.error(`::warning::evidence-catchup-spend lock not acquired for ${filePath}; writing unprotected.`);
    const current = loadRollup(filePath);
    current.fetches.push(fetchRow);
    writeJsonAtomic(filePath, assertRollup(current));
  });
}

module.exports = {
  EVIDENCE_CATCHUP_MONTHLY_CAP_USD,
  EVIDENCE_CATCHUP_PURPOSE,
  ROLLUP_PATH,
  CHILD_SB_CREDIT_BUDGET,
  CHILD_SD_CREDIT_BUDGET,
  monthKey,
  projectedFetchUsd,
  priceLedgerRow,
  parseTaggedLedgerRows,
  assertRollup,
  loadRollup,
  loadTaggedLedgerRows,
  monthToDateUsd,
  decideFetch,
  spendForFetch,
  appendRollupFetch,
};
