/**
 * provider-telemetry.js — per-call attribution for every scraping provider
 * (Bright Data, ScrapingBee, Scrapingdog, Browserbase), generalized from
 * bd-telemetry.js for task #752.
 *
 * bd-telemetry.js already emitted `[BD Call]`/`[SB Call]` stdout lines with
 * per-script attribution — good design, but stdout-only means Actions-log
 * retention (90d) and zero visibility for local/launchd runs. This module adds
 * a durable, committed ledger (data/audit/scraper-spend-ledger.jsonl) IN
 * ADDITION to the stdout line, so CI, launchd, and local runs all land in one
 * place the daily reconciliation (check-provider-spend.js) can read.
 *
 * bd-telemetry.js's recordBdCall/recordSbCall/recordSdCall now delegate here
 * (unchanged call signature — scraper.js and url-discovery.js need no edits).
 * recordBbCall is new, called only from the browserbase-session.js chokepoint.
 *
 * attributedPct (pure, tested) answers "did we capture ALL of it?": it compares
 * a day's ledger call/session counts against that day's billing-API totals
 * (already computed by provider-spend-core.js's computeDayRecord). A gap here
 * means code we aren't instrumenting spent money — that becomes the alert.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'data', 'audit', 'scraper-spend-ledger.jsonl');
const MAX_LEDGER_LINES = 20000; // ~2-3 months at current call volume; oldest lines drop first
const TAG_BY_PROVIDER = {
  brightdata: 'BD',
  scrapingbee: 'SB',
  scrapingdog: 'SD',
  browserbase: 'BB',
};

function _scriptName() {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return 'unknown';
    return path.basename(argv1);
  } catch { return 'unknown'; }
}

function _hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

// Overridable at call time (not module load) so tests can redirect ledger
// writes to a scratch path instead of polluting the real committed ledger —
// every recordProviderCall() in a test run was writing real rows here until
// this was added (caught while shipping task #752).
function _ledgerPath() {
  return process.env.SCRAPER_SPEND_LEDGER_PATH || LEDGER_PATH;
}

function _appendLedgerLine(record) {
  const ledgerPath = _ledgerPath();
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    let lines = [];
    try {
      lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
    } catch { /* first write */ }
    lines.push(JSON.stringify(record));
    if (lines.length > MAX_LEDGER_LINES) lines = lines.slice(lines.length - MAX_LEDGER_LINES);
    fs.writeFileSync(ledgerPath, lines.join('\n') + '\n');
  } catch {
    // Ledger persistence must never break scraping — the stdout line still fired.
  }
}

/**
 * Record one provider call: emits `[<TAG> Call] {...}` to stdout (same
 * contract as bd-telemetry.js) AND appends a durable row to
 * data/audit/scraper-spend-ledger.jsonl.
 * @param {Object} opts
 * @param {'brightdata'|'scrapingbee'|'scrapingdog'|'browserbase'} opts.provider
 * @param {string} [opts.url] - target URL (host extracted automatically)
 * @param {string} [opts.host] - explicit host (overrides url-derived host)
 * @param {string} [opts.caller] - explicit caller label (browserbase chokepoint); otherwise derived from argv[1]
 * @param {string} [opts.fn] - provider function/tier (e.g. 'web-unlocker', 'page', 'session')
 * @param {boolean} opts.success
 * @param {number|string|null} [opts.status]
 * @param {number|null} [opts.credits] - SB/SD credit cost
 * @param {string|null} [opts.fallbackFrom]
 * @param {string|null} [opts.purpose] - free-text reason (Browserbase userMetadata parity)
 */
function recordProviderCall(opts) {
  if (process.env.BD_TELEMETRY_DISABLED === '1') return;
  try {
    opts = opts || {};
    const provider = opts.provider || 'unknown';
    const tag = TAG_BY_PROVIDER[provider] || provider.toUpperCase();
    const record = {
      ts: new Date().toISOString(),
      provider,
      script: opts.caller || _scriptName(),
      workflow: process.env.GITHUB_WORKFLOW || null,
      host: opts.host || _hostOf(opts.url),
      fn: opts.fn || 'unknown',
      success: opts.success === true,
      status: opts.status ?? null,
      credits: opts.credits ?? null,
      fallback_from: opts.fallbackFrom || null,
      purpose: opts.purpose || null,
    };
    console.log(`[${tag} Call] ${JSON.stringify(record)}`);
    _appendLedgerLine(record);
  } catch {
    // Telemetry must never break scraping.
  }
}

/** Mirrors legacy recordBdCall(opts: {url|host, fn, success, status, fallbackFrom}). */
function recordBdCall(opts) {
  opts = opts || {};
  recordProviderCall({ ...opts, provider: 'brightdata', fn: opts.fn || 'web-unlocker' });
}

/** Mirrors legacy recordSbCall(opts: {url|host, fn, success, status, credits}). */
function recordSbCall(opts) {
  opts = opts || {};
  recordProviderCall({ ...opts, provider: 'scrapingbee', fn: opts.fn || 'page' });
}

/** Mirrors legacy recordSdCall(opts: {url|host, fn, success, status, credits}). */
function recordSdCall(opts) {
  opts = opts || {};
  recordProviderCall({ ...opts, provider: 'scrapingdog', fn: opts.fn || 'page' });
}

/** New: recordBbCall(opts: {caller, purpose, success, status}) — called only from browserbase-session.js. */
function recordBbCall(opts) {
  opts = opts || {};
  recordProviderCall({ ...opts, provider: 'browserbase', fn: 'session' });
}

// ---------- pure reducers (fixture-tested, no I/O) ----------

/** "YYYY-MM-DD" from an ISO timestamp. */
function _dayOf(ts) {
  return typeof ts === 'string' ? ts.slice(0, 10) : null;
}

/**
 * Count ledger calls per provider for one UTC day.
 * @param {Array<Object>} ledgerRecords - raw parsed ledger lines
 * @param {string} day - "YYYY-MM-DD"
 * @returns {{[provider: string]: number}}
 */
function countCallsByProvider(ledgerRecords, day) {
  const counts = {};
  for (const r of ledgerRecords || []) {
    if (!r || _dayOf(r.ts) !== day) continue;
    counts[r.provider] = (counts[r.provider] || 0) + 1;
  }
  return counts;
}

/**
 * Top-N callers (by ledger call count) for one provider on one day.
 * @returns {Array<{script: string, count: number}>}
 */
function topCallers(ledgerRecords, day, provider, n = 5) {
  const counts = {};
  for (const r of ledgerRecords || []) {
    if (!r || _dayOf(r.ts) !== day || r.provider !== provider) continue;
    const key = r.script || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([script, count]) => ({ script, count }))
    .sort((a, b) => b.count - a.count || a.script.localeCompare(b.script))
    .slice(0, n);
}

/**
 * The billing-count field to compare ledger counts against, per provider, as
 * produced by provider-spend-core.js's computeDayRecord().
 */
const BILLING_COUNT_FIELD = {
  browserbase: (p) => p.sessions,
  brightdata: (p) => (p.serpReqs != null && p.unlockerReqs != null ? p.serpReqs + p.unlockerReqs : null),
  scrapingbee: (p) => p.dayCredits,
  scrapingdog: (p) => p.dayCredits,
};

/**
 * attributedPct = ledger call count / billing-API count, per provider, for one
 * day. This is the completeness metric task #752 exists to create: "we
 * believe we track everything" becomes a number that fails loudly.
 *
 * @param {Object} ledgerCounts - { [provider]: count } from countCallsByProvider()
 * @param {Object} billingRecord - one day's record.providers from provider-spend-daily.jsonl
 *   (shape: { browserbase: {status, sessions}, brightdata: {status, serpReqs, unlockerReqs}, ... })
 * @returns {{[provider: string]: number|null}} null = cannot be computed (billing
 *   unmeasurable, or billing count is 0 with ledger also 0 — a genuine zero-spend
 *   day is reported as 1.0, not null, since 0/0 IS full coverage of nothing spent)
 */
function computeAttributedPct(ledgerCounts, billingRecord) {
  const out = {};
  for (const provider of Object.keys(BILLING_COUNT_FIELD)) {
    const p = billingRecord && billingRecord[provider];
    if (!p || p.status !== 'ok') { out[provider] = null; continue; }
    const billingCount = BILLING_COUNT_FIELD[provider](p);
    if (billingCount == null) { out[provider] = null; continue; }
    const ledgerCount = ledgerCounts[provider] || 0;
    if (billingCount === 0) { out[provider] = ledgerCount === 0 ? 1 : null; continue; }
    out[provider] = Math.min(1, ledgerCount / billingCount);
  }
  return out;
}

module.exports = {
  recordProviderCall,
  recordBdCall,
  recordSbCall,
  recordSdCall,
  recordBbCall,
  countCallsByProvider,
  topCallers,
  computeAttributedPct,
  LEDGER_PATH,
  MAX_LEDGER_LINES,
};
