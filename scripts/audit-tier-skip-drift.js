#!/usr/bin/env node
/**
 * S1-T3 (Scraping cost v3, card 3b1637c5): bidirectional drift check for
 * scripts/config/domain-tier-skip.json against live scraper-spend-ledger
 * data. Two directions, both silent gaps until now:
 *   - degrade: a skip:false domain+tier is failing hard on real traffic
 *     (>=100 calls/7d, <30% success) — flags for a skip:true flip.
 *   - recovery: a skip:true domain+tier gets a small live probe (5 URLs,
 *     monthly cadence via the weekly workflow's day-of-month gate) to see
 *     if the underlying block cleared.
 *
 * Pure decision logic lives in scripts/lib/tier-skip-drift.js; this file is
 * the thin I/O layer: read config + ledger, aggregate, call the pure fns,
 * route alerts.
 *
 * Usage:
 *   node scripts/audit-tier-skip-drift.js --dry-run   # print verdicts, no alert dispatch, no probe network calls
 *   node scripts/audit-tier-skip-drift.js              # dispatch alerts via owner-alert-router; runs recovery probes
 */

const fs = require('fs');
const path = require('path');
const { evaluateDegradeDrift, evaluateRecoveryProbe, resolveDegradeConfig, DEFAULT_RECOVERY_PROBE_SIZE } = require('./lib/tier-skip-drift');

const DRY_RUN = process.argv.includes('--dry-run');
const LEDGER_WINDOW_DAYS = 7;
const LEDGER_PATH = path.join(__dirname, '..', 'data', 'audit', 'scraper-spend-ledger.jsonl');
const CONFIG_PATH = path.join(__dirname, 'config', 'domain-tier-skip.json');

function loadDomainTierSkip() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

/**
 * Aggregate the ledger into { [host]: { [provider]: { successes, failures } } }
 * over the trailing window. Ledger rows use `provider` (scrapingdog/brightdata/
 * scrapingbee) and `host` (already normalized, no www.) — see bd-telemetry.js.
 */
function aggregateLedger(windowDays = LEDGER_WINDOW_DAYS) {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const agg = {};
  let raw;
  try {
    raw = fs.readFileSync(LEDGER_PATH, 'utf8');
  } catch {
    return agg;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.host || !row.provider || !row.ts) continue;
    if (new Date(row.ts).getTime() < cutoff) continue;
    if (!agg[row.host]) agg[row.host] = {};
    if (!agg[row.host][row.provider]) agg[row.host][row.provider] = { successes: 0, failures: 0 };
    if (row.success) agg[row.host][row.provider].successes++;
    else agg[row.host][row.provider].failures++;
  }
  return agg;
}

async function runRecoveryProbe(host, tier) {
  if (tier !== 'scrapingdog') return { probeSuccesses: 0, probeTotal: 0 }; // only SD probing implemented (the tier this card's incident is about)
  if (!process.env.SCRAPINGDOG_API_KEY) return { probeSuccesses: 0, probeTotal: 0 };
  const { fetchWithScrapingdog, verifyFetchedUrl } = require('./lib/scraper');
  // Small, cheap sample: the host's homepage plus (if present) a couple of
  // real URLs pulled from data/aggregator-summary.json — reuses S1-T1's
  // discovery approach at 1/6th the volume (probe, not a full parity test).
  const candidates = [`https://${host}/`];
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'aggregator-summary.json'), 'utf8');
    const re = new RegExp(`https:\\/\\/${host.replace(/\./g, '\\.')}\\/[a-z0-9\\/-]+`, 'g');
    const found = [...new Set(raw.match(re) || [])].slice(0, DEFAULT_RECOVERY_PROBE_SIZE - 1);
    candidates.push(...found);
  } catch { /* aggregator-summary.json optional */ }

  let successes = 0;
  for (const url of candidates.slice(0, DEFAULT_RECOVERY_PROBE_SIZE)) {
    const result = await fetchWithScrapingdog(url, {});
    if (result && result.content && result.content.length > 1000 && verifyFetchedUrl(result.content, url).verified) successes++;
  }
  return { probeSuccesses: successes, probeTotal: Math.min(candidates.length, DEFAULT_RECOVERY_PROBE_SIZE) };
}

async function main() {
  const config = loadDomainTierSkip();
  const ledgerStats = aggregateLedger();
  const degradeConfig = resolveDegradeConfig();
  const verdicts = [];
  let recoveryEligible = 0;

  for (const domain of Object.keys(config)) {
    const entry = config[domain];
    if (Array.isArray(entry)) continue; // legacy shape, no per-tier skip booleans to evaluate
    for (const tier of Object.keys(entry)) {
      const currentSkip = entry[tier] && entry[tier].skip === true;
      const stats = (ledgerStats[domain] && ledgerStats[domain][tier]) || { successes: 0, failures: 0 };

      const degrade = evaluateDegradeDrift({ currentSkip, ...stats, ...degradeConfig });
      if (degrade.alert) {
        verdicts.push({ domain, tier, direction: 'degrade', ...degrade });
      }

      if (currentSkip) {
        recoveryEligible++;
        if (!DRY_RUN) {
          const probe = await runRecoveryProbe(domain, tier);
          const recovery = evaluateRecoveryProbe({ currentSkip, ...probe });
          if (recovery.alert) verdicts.push({ domain, tier, direction: 'recovery', ...recovery });
        }
      }
    }
  }

  console.log(`Tier-skip drift audit: ${Object.keys(config).length} domains checked, ${LEDGER_WINDOW_DAYS}d ledger window${DRY_RUN ? ' (--dry-run)' : ''}`);
  console.log(`${recoveryEligible} skip:true domain+tier entries are recovery-probe eligible${DRY_RUN ? ' (probes skipped in --dry-run)' : ''}.`);
  if (!verdicts.length) {
    console.log('No drift detected.');
    return;
  }
  for (const v of verdicts) {
    console.log(`[${v.direction}] ${v.domain} / ${v.tier}: ${v.reason}`);
  }

  if (DRY_RUN) return;

  const alertable = verdicts.filter((v) => v.alert);
  if (!alertable.length) return;
  const { routeAlert } = require('./lib/owner-alert-router');
  await routeAlert({
    conditionKey: 'tier-skip-drift',
    title: `domain-tier-skip.json drift: ${alertable.length} domain+tier verdict(s) need review`,
    description: alertable.map((v) => `[${v.direction}] ${v.domain} / ${v.tier}: ${v.reason}`).join('\n'),
    severity: 'warn',
    disposition: 'digest',
    cooldownHours: 20,
  });
}

main().catch((err) => {
  console.error('audit-tier-skip-drift.js failed:', err.message);
  process.exit(1);
});
