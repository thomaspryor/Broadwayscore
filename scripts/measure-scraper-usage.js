#!/usr/bin/env node
/**
 * measure-scraper-usage.js — on-demand provider usage + cost readout.
 *
 * Parses [SD Call] / [BD Call] / [SB Call] telemetry lines from recent scraping
 * workflow logs and aggregates by provider + host: requests, success rate,
 * credits, and cost (Scrapingdog shown at BOTH PAYG and plan rates). Built for the
 * Scrapingdog PAYG trial (2026-06): flip SCRAPER_USE_SCRAPINGDOG=1, run a couple
 * days, then run this to see actual credits, per-host success, and how much Bright
 * Data spend was avoided — before committing to a monthly plan.
 *
 * Usage:
 *   node scripts/measure-scraper-usage.js                 # last 5 runs per workflow
 *   node scripts/measure-scraper-usage.js --runs=10       # deeper history
 *   node scripts/measure-scraper-usage.js --logfile=x.log # parse a local log instead of gh
 *
 * Note: scans a BOUNDED set of known scraping workflows (not all 100+) to avoid
 * burning the GitHub API rate limit — see CLAUDE.md on gh polling.
 */

const { execSync } = require('child_process');
const fs = require('fs');

// Pricing (USD). Keep in sync with scraper-cost-report.yml + scraper.js.
const BD_PER_REQ = 0.0015;          // Bright Data Web Unlocker, per request
const SD_CREDIT_PAYG = 0.0004;      // Scrapingdog PAYG: $10 / 25,000 credits
const SD_CREDIT_PLAN = 0.00009;     // Scrapingdog Standard: $90 / 1,000,000
const SB_CREDIT = 99 / 1_000_000;   // ScrapingBee Startup: $99 / 1,000,000

const SCRAPING_WORKFLOWS = [
  'Collect Review Texts', 'Gather Review Data', 'Opening Night Poller',
  'Opening Night Reviews', 'Enrich IBDB Dates', 'Bulk Show Score',
  'Auto-Maintain Show Data', 'Scrape BWW Reviews', 'Update Commercial',
];

const argRuns = (process.argv.find(a => a.startsWith('--runs=')) || '').split('=')[1];
const RUNS = parseInt(argRuns || '5', 10);
const logfile = (process.argv.find(a => a.startsWith('--logfile=')) || '').split('=')[1];

function gatherLines() {
  if (logfile) return fs.readFileSync(logfile, 'utf8').split('\n');
  const lines = [];
  for (const wf of SCRAPING_WORKFLOWS) {
    let ids = [];
    try {
      ids = JSON.parse(execSync(
        `gh run list --workflow=${JSON.stringify(wf)} --limit ${RUNS} --json databaseId -q '[.[].databaseId]'`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ));
    } catch { continue; }
    for (const id of ids) {
      try {
        const log = execSync(`gh run view ${id} --log`, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const l of log.split('\n')) {
          if (l.includes('[SD Call]') || l.includes('[BD Call]') || l.includes('[SB Call]')) lines.push(l);
        }
      } catch { /* skip unreadable run */ }
    }
  }
  return lines;
}

function parse(lines) {
  const prov = {
    scrapingdog: { reqs: 0, ok: 0, credits: 0, hosts: {} },
    brightdata: { reqs: 0, ok: 0, credits: 0, hosts: {} },
    scrapingbee: { reqs: 0, ok: 0, credits: 0, hosts: {} },
  };
  const tag = { '[SD Call]': 'scrapingdog', '[BD Call]': 'brightdata', '[SB Call]': 'scrapingbee' };
  for (const line of lines) {
    const t = Object.keys(tag).find(k => line.includes(k));
    if (!t) continue;
    const m = line.slice(line.indexOf(t) + t.length).trim();
    let rec; try { rec = JSON.parse(m); } catch { continue; }
    const p = prov[tag[t]];
    p.reqs++;
    if (rec.success) p.ok++;
    if (rec.credits) p.credits += rec.credits;
    const h = rec.host || 'unknown';
    p.hosts[h] = p.hosts[h] || { reqs: 0, credits: 0 };
    p.hosts[h].reqs++; p.hosts[h].credits += rec.credits || 0;
  }
  return prov;
}

function pct(ok, n) { return n ? `${(ok / n * 100).toFixed(1)}%` : '—'; }
function usd(n) { return `$${n.toFixed(2)}`; }

(function main() {
  const lines = gatherLines();
  if (!lines.length) {
    console.log('No telemetry lines found. Has SCRAPER_USE_SCRAPINGDOG run yet, and are these the right workflows?');
    return;
  }
  const p = parse(lines);
  const sd = p.scrapingdog, bd = p.brightdata, sb = p.scrapingbee;
  const totalEvents = sd.reqs + bd.reqs + sb.reqs;

  console.log(`\nScraper usage — ${totalEvents} telemetry events (last ${RUNS} runs/workflow)\n`);
  console.log('Provider      Reqs   Success   Credits   Cost');
  console.log(`Scrapingdog  ${String(sd.reqs).padStart(5)}   ${pct(sd.ok, sd.reqs).padStart(6)}   ${String(sd.credits).padStart(7)}   PAYG ${usd(sd.credits * SD_CREDIT_PAYG)} / plan ${usd(sd.credits * SD_CREDIT_PLAN)}`);
  console.log(`Bright Data  ${String(bd.reqs).padStart(5)}   ${pct(bd.ok, bd.reqs).padStart(6)}         —   ${usd(bd.reqs * BD_PER_REQ)}`);
  console.log(`ScrapingBee  ${String(sb.reqs).padStart(5)}   ${pct(sb.ok, sb.reqs).padStart(6)}   ${String(sb.credits).padStart(7)}   ${usd(sb.credits * SB_CREDIT)}`);

  const topHosts = (prov, n = 8) => Object.entries(prov.hosts)
    .sort((a, b) => b[1].reqs - a[1].reqs).slice(0, n);

  if (sd.reqs) {
    console.log('\nTop Scrapingdog hosts (reqs · credits):');
    for (const [h, v] of topHosts(sd)) console.log(`  ${String(v.reqs).padStart(5)}  ${String(v.credits).padStart(6)}cr  ${h}`);
  }
  if (bd.reqs) {
    console.log('\nRemaining Bright Data hosts (NOT yet rerouted — reqs):');
    for (const [h, v] of topHosts(bd)) console.log(`  ${String(v.reqs).padStart(5)}  ${h}`);
  }

  // What moving the still-on-BD traffic to Scrapingdog (plan rate) would save.
  if (bd.reqs) {
    const bdCost = bd.reqs * BD_PER_REQ;
    // Assume rerouted at ~plan rate; page≈1cr, serp≈5cr — use observed SD avg if available, else 2cr.
    const sdAvgCr = sd.credits && sd.reqs ? sd.credits / sd.reqs : 2;
    const ifMoved = bd.reqs * sdAvgCr * SD_CREDIT_PLAN;
    console.log(`\nIf the ${bd.reqs} remaining BD reqs moved to Scrapingdog (plan rate, ~${sdAvgCr.toFixed(1)}cr/req):`);
    console.log(`  BD ${usd(bdCost)} → SD ${usd(ifMoved)}  (this window)`);
  }
  console.log('\nExtrapolate to monthly by your window length; pick a plan once steady-state credits/mo is clear.');
})();
