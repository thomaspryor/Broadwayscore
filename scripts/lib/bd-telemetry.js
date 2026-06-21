#!/usr/bin/env node
/**
 * Bright Data per-call telemetry.
 *
 * Emits one JSON line per BD call to stdout, prefixed `[BD Call] `, so the weekly
 * cost report (`.github/workflows/scraper-cost-report.yml`) can attribute spend
 * by script + host + function instead of one opaque per-run total.
 *
 * Phase 1 of the BD cost-reduction plan (see Notion "Drive next BD/SB cost-cut
 * round from Monday cost report"): collect 7 days of attributed call data before
 * making more cuts. Prior broad-cut rounds missed by ~10x because the dominant
 * spend is from always-on background work in shared helpers, not the bursty
 * workflows we kept tuning. Codex review 2026-05-23.
 *
 * Format: `[BD Call] {"ts":"...","script":"...","workflow":"...","host":"...","fn":"...","success":true,"status":200,"fallback_from":null}`
 */

const path = require('path');

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

/**
 * Record a Bright Data API call.
 * @param {Object} opts
 * @param {string} [opts.url] - target URL (host extracted automatically)
 * @param {string} [opts.host] - explicit host (overrides url-derived host)
 * @param {string} opts.fn - one of: 'web-unlocker', 'serp-api', 'serp-unlocker'
 * @param {boolean} opts.success - whether the call returned usable content
 * @param {number|string|null} [opts.status] - HTTP status code or error string
 * @param {string|null} [opts.fallbackFrom] - which BD function this fell through from (e.g. 'serp-api' when 'serp-unlocker' is invoked after API failure)
 */
function recordBdCall(opts) {
  if (process.env.BD_TELEMETRY_DISABLED === '1') return;
  try {
    const record = {
      ts: new Date().toISOString(),
      script: _scriptName(),
      workflow: process.env.GITHUB_WORKFLOW || null,
      host: opts.host || _hostOf(opts.url),
      fn: opts.fn || 'unknown',
      success: opts.success === true,
      status: opts.status ?? null,
      fallback_from: opts.fallbackFrom || null,
    };
    // Single JSON line on stdout — captured by GitHub Actions logs, parseable by
    // gh run view --log | grep '\[BD Call\]' | jq -s '...'.
    console.log(`[BD Call] ${JSON.stringify(record)}`);
  } catch {
    // Telemetry must never break scraping.
  }
}

/**
 * Record a ScrapingBee API call. Mirrors recordBdCall so the cost report can
 * attribute SB spend by host (BD already had per-host attribution; SB only had
 * an aggregate per-run total). Emits `[SB Call] {...}` lines on stdout.
 *
 * Per-host SB data is what lets us decide reroute targets: a host that's cheap on
 * SB (1 credit, no render) shouldn't move; a host burning render_js/premium is a
 * candidate for a cheaper provider. Added 2026-06-21 for the BD/SB cost-cut.
 * @param {Object} opts
 * @param {string} [opts.url] - target URL (host extracted automatically)
 * @param {string} [opts.host] - explicit host (overrides url-derived host)
 * @param {string} opts.fn - e.g. 'page', 'serp', 'premium'
 * @param {boolean} opts.success - whether the call returned usable content
 * @param {number|string|null} [opts.status] - HTTP status code or error string
 * @param {number} [opts.credits] - credit cost charged for this call (1/5/10/25)
 */
function recordSbCall(opts) {
  if (process.env.BD_TELEMETRY_DISABLED === '1') return;
  try {
    const record = {
      ts: new Date().toISOString(),
      script: _scriptName(),
      workflow: process.env.GITHUB_WORKFLOW || null,
      host: opts.host || _hostOf(opts.url),
      fn: opts.fn || 'page',
      success: opts.success === true,
      status: opts.status ?? null,
      credits: opts.credits ?? null,
    };
    console.log(`[SB Call] ${JSON.stringify(record)}`);
  } catch {
    // Telemetry must never break scraping.
  }
}

/**
 * Record a Scrapingdog API call. Same shape as recordSbCall (Scrapingdog uses an
 * identical credit model: 1 plain / 5 dynamic / 10 premium / 5 google). Emits
 * `[SD Call] {...}` lines so the cost report can attribute Scrapingdog spend by
 * host once it's live as the cheap tier ahead of Bright Data.
 * @param {Object} opts — { url|host, fn, success, status, credits }
 */
function recordSdCall(opts) {
  if (process.env.BD_TELEMETRY_DISABLED === '1') return;
  try {
    const record = {
      ts: new Date().toISOString(),
      script: _scriptName(),
      workflow: process.env.GITHUB_WORKFLOW || null,
      host: opts.host || _hostOf(opts.url),
      fn: opts.fn || 'page',
      success: opts.success === true,
      status: opts.status ?? null,
      credits: opts.credits ?? null,
    };
    console.log(`[SD Call] ${JSON.stringify(record)}`);
  } catch {
    // Telemetry must never break scraping.
  }
}

module.exports = { recordBdCall, recordSbCall, recordSdCall };
