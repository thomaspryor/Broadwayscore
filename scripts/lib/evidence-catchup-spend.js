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
 * Reserve, then true up: before each fetch the runner writes a 'reserved'
 * row charged at the worst case (projectedReservationUsd), then settles it to
 * the priced actual. A crash, cancel or lost push between the two leaves the
 * reservation standing, so the next run neither re-spends the money nor
 * re-fetches the show (any row for a show blocks it, see blockedShowIds).
 *
 * Downstream retries: a failed fetch writes NO retryable stub (the runner
 * does not pass --stub-on-failure), so collect-review-texts.yml never sees
 * it; the show is marked 'failed' and may be retried by this capped runner
 * after FAILED_RETRY_DAYS, at most MAX_SEED_ATTEMPTS times. A successful
 * ingest whose file is not contentTier 'complete' can still be refetched by
 * collect-review-texts.js, whose spend carries no show id, so it is charged
 * here up front as downstreamAllowanceUsd() and kept on settle.
 *
 * Fails CLOSED: a missing or unreadable rollup or ledger throws, and so does
 * a tagged ledger row no rollup row accounts for (a rollup commit that was
 * lost after the spend was pushed); the runner then makes no fetch. Credits become dollars only through
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

const STATUS = Object.freeze({ RESERVED: 'reserved', DONE: 'done', FAILED: 'failed' });
const FAILED_RETRY_DAYS = 30;
const MAX_SEED_ATTEMPTS = 2;
// collect-review-texts.js may refetch an incomplete review: a first attempt
// plus up to 5 retries (largest value in MAX_RETRIES_FETCH_LENIENT,
// scripts/lib/review-guards.js; a test pins that this still holds).
const DOWNSTREAM_COLLECT_FETCHES = 6;

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
 * Worst case of one collect-review-texts.js fetch: its chain can add a
 * Browserbase session (priced as a full browser-hour, see priceLedgerRow)
 * and a ScrapingBee stealth_proxy call on top of the fetchPage tiers.
 */
function projectedCollectFetchUsd(pricing = loadProviderPricing()) {
  return BB_OVERAGE_PER_BROWSER_HOUR_USD
    + usdFor('scrapingbee', creditsFor('sb', 'stealth_proxy'), pricing)
    + usdFor('scrapingdog', creditsFor('sd', 'stealth') * SD_MAX_ATTEMPTS, pricing)
    + usdFor('brightdata', PROJECTED_BD_REQUESTS, pricing);
}

/** Charge for the collect-review-texts retries an incomplete ingest can cause. */
function downstreamAllowanceUsd(pricing = loadProviderPricing()) {
  return DOWNSTREAM_COLLECT_FETCHES * projectedCollectFetchUsd(pricing);
}

/** What a reservation holds: the fetch plus its possible downstream retries. */
function projectedReservationUsd(pricing = loadProviderPricing()) {
  return projectedFetchUsd(pricing) + downstreamAllowanceUsd(pricing);
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
  const statuses = new Set(Object.values(STATUS));
  for (const f of rollup.fetches) {
    if (!f || typeof f.showId !== 'string' || typeof f.month !== 'string' || typeof f.ts !== 'string'
      || !Number.isFinite(f.usd) || f.usd < 0 || !statuses.has(f.status)) {
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
 * Throws unless every tagged ledger row that names a show is accounted for by
 * a rollup row for that show written at or before it (the reservation
 * precedes the fetch). A miss means spend happened whose rollup record never
 * landed. A tagged row with no showId cannot be matched to a show; it still
 * counts against the cap through monthToDateUsd and does not block the run.
 */
function assertRollupCoversLedger(rollup, ledgerRows) {
  const firstTs = new Map();
  for (const f of assertRollup(rollup).fetches) {
    if (!firstTs.has(f.showId) || f.ts < firstTs.get(f.showId)) firstTs.set(f.showId, f.ts);
  }
  for (const r of ledgerRows || []) {
    if (!r.showId) continue;
    const start = firstTs.get(r.showId);
    if (!start || typeof r.ts !== 'string' || r.ts < start) {
      throw new Error(`evidence-catchup-spend: ledger has ${EVIDENCE_CATCHUP_PURPOSE} spend for ${r.showId} at ${r.ts} that the rollup does not record (lost rollup commit?)`);
    }
  }
}

/**
 * Show ids the runner must not fetch now: any reserved or done row, a show
 * at MAX_SEED_ATTEMPTS, or one whose latest failure is inside its not-before.
 */
function blockedShowIds(rollup, nowMs) {
  const byShow = new Map();
  for (const f of assertRollup(rollup).fetches) {
    if (!byShow.has(f.showId)) byShow.set(f.showId, []);
    byShow.get(f.showId).push(f);
  }
  const blocked = new Set();
  for (const [showId, rows] of byShow) {
    const latest = rows.reduce((a, b) => (b.ts > a.ts ? b : a));
    const notBefore = Date.parse(latest.notBefore || '');
    if (rows.some((f) => f.status !== STATUS.FAILED)
      || rows.length >= MAX_SEED_ATTEMPTS
      || !Number.isFinite(notBefore) || notBefore > nowMs) blocked.add(showId);
  }
  return blocked;
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

/** How many of `count` fetches the cap allows, each charged `projectedUsd`. */
function allowedFetchCount({ mtdUsd, projectedUsd, capUsd = EVIDENCE_CATCHUP_MONTHLY_CAP_USD, count }) {
  let n = 0;
  while (n < count && decideFetch({ mtdUsd: mtdUsd + n * projectedUsd, projectedUsd, capUsd }).proceed) n++;
  return n;
}

/** True when collect-review-texts.js would treat the written review as done. */
function isCollectComplete(review) {
  return !!review && (review.contentTier === 'complete' || review.textQuality === 'full');
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

/** Read-modify-write the rollup under a lock (re-read fresh, then write). */
function updateRollup(filePath, mutate) {
  let result;
  withFileLock(`${filePath}.lock`, (held) => {
    if (!held) console.error(`::warning::evidence-catchup-spend lock not acquired for ${filePath}; writing unprotected.`);
    const current = loadRollup(filePath);
    result = mutate(current);
    writeJsonAtomic(filePath, assertRollup(current));
  });
  return result;
}

/** Append one row as-is (tests and backfills). */
function appendRollupFetch(filePath, fetchRow) {
  updateRollup(filePath, (r) => { r.fetches.push(fetchRow); });
}

/** Write the worst-case reservation BEFORE fetching. Returns the row id. */
function reserveFetch(filePath, { showId, url, nowMs, usd }) {
  const ts = new Date(nowMs).toISOString();
  const id = `${showId}@${ts}`;
  updateRollup(filePath, (r) => {
    r.fetches.push({ id, ts, month: monthKey(nowMs), showId, url, usd: Number(usd.toFixed(6)), status: STATUS.RESERVED });
  });
  return id;
}

/**
 * Make a just-written reservation durable before the fetch it covers. In CI
 * the rollup is committed and pushed (pushRollup); a runner killed after this
 * point (cancel, timeout, VM loss) leaves the reservation on main, so the next
 * run neither re-fetches the show nor forgets the money. Skipped for dry runs
 * and outside GitHub Actions. pushRollup returns true on success; false or a
 * throw stops the run before any fetch.
 * @returns {'pushed'|'skipped'}
 */
function persistReservation({ rollupFile, showId, dryRun, env = process.env, pushRollup }) {
  if (dryRun || env.GITHUB_ACTIONS !== 'true') return 'skipped';
  let ok = false;
  try { ok = pushRollup(rollupFile, `audit: evidence catch-up reservation for ${showId} [skip ci]`) === true; } catch (e) {
    throw new Error(`reservation for ${showId} could not be pushed (${e.message}); no fetch made`);
  }
  if (!ok) throw new Error(`reservation for ${showId} could not be pushed; no fetch made`);
  return 'pushed';
}

/**
 * True a reservation up to what was spent. exit 0 = done; anything else is
 * failed with a not-before FAILED_RETRY_DAYS out. usd stays in the
 * reservation's month (spend is charged where it was reserved).
 */
function settleFetch(filePath, id, { usd, rows, estimated, exit, nowMs, downstreamUsd = 0 }) {
  updateRollup(filePath, (r) => {
    const row = r.fetches.find((f) => f.id === id);
    if (!row) throw new Error(`evidence-catchup-spend: no reservation ${id} to settle`);
    Object.assign(row, {
      usd: Number((usd + downstreamUsd).toFixed(6)),
      fetchUsd: Number(usd.toFixed(6)),
      downstreamUsd: Number(downstreamUsd.toFixed(6)),
      rows, estimated, exit,
      settledAt: new Date(nowMs).toISOString(),
      status: exit === 0 ? STATUS.DONE : STATUS.FAILED,
      ...(exit === 0 ? {} : { notBefore: new Date(nowMs + FAILED_RETRY_DAYS * 86400000).toISOString() }),
    });
  });
}

module.exports = {
  EVIDENCE_CATCHUP_MONTHLY_CAP_USD,
  EVIDENCE_CATCHUP_PURPOSE,
  ROLLUP_PATH,
  CHILD_SB_CREDIT_BUDGET,
  CHILD_SD_CREDIT_BUDGET,
  STATUS,
  FAILED_RETRY_DAYS,
  MAX_SEED_ATTEMPTS,
  DOWNSTREAM_COLLECT_FETCHES,
  monthKey,
  projectedFetchUsd,
  projectedCollectFetchUsd,
  downstreamAllowanceUsd,
  projectedReservationUsd,
  assertRollupCoversLedger,
  blockedShowIds,
  allowedFetchCount,
  isCollectComplete,
  reserveFetch,
  persistReservation,
  settleFetch,
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
