#!/usr/bin/env node
/**
 * BRO-5916: alert once per outage when the Reddit sentiment scrape has had no
 * successful run for 48h; resolve the incident on the first success. Reads
 * data/audit/reddit-run-health.jsonl (written by scrape-reddit-sentiment.js);
 * decision logic lives in scripts/lib/reddit-dispatch-cooldown.js.
 * Agent-fixable, not owner-actionable: a digest line, never an email.
 * Run from update-reddit-sentiment.yml (if: always()) so it also fires when
 * the scraper skipped itself on cooldown.
 */
const cooldown = require('./lib/reddit-dispatch-cooldown');
const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');

const KEY = 'reddit-sentiment:down-48h';

async function main() {
  const rows = cooldown.readLedger();
  const last = [...rows].reverse().find(r => r.outcome === 'ok' || r.outcome === 'unavailable');
  if (last && last.outcome === 'ok') {
    resolveCondition(KEY, { reason: 'Reddit scrape succeeded' });
    console.log('Reddit healthy; incident (if any) resolved');
    return;
  }
  const verdict = cooldown.shouldAlertStale(rows);
  if (!verdict.alert) { console.log(`No alert due: ${verdict.reason}`); return; }
  await routeAlert({
    conditionKey: KEY,
    title: 'Reddit sentiment scrape has been down 48h+',
    description: `${verdict.reason}. Every route (direct, RSS, Bright Data, Scrapingdog, ScrapingBee) failed, so new openings get no Reddit audience data. Dispatches are on cooldown to stop burning credits; one probe runs every ${cooldown.DEFAULTS.probeAfterHours}h and clears it on success.`,
    severity: 'warning',
    disposition: 'digest',
    cooldownHours: 48,
  });
  cooldown.appendRow({ ts: new Date().toISOString(), outcome: 'alerted', note: verdict.reason });
  console.log('Stale-Reddit alert routed');
}

main().catch(e => { console.warn(`reddit-stale-alert failed (non-fatal): ${e.message}`); });
