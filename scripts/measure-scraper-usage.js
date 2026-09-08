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
 * Note (S0-T8): the workflow list is derived from .github/workflows/*.yml
 * filtered to those carrying SCRAPINGDOG_API_KEY — currently 80+ workflows,
 * not a small hand-picked set. That's real breadth, not scope creep: the
 * previous hand-maintained 9-workflow list excluded most of it and its two
 * stale `name:` strings made `gh run list --workflow=...` return zero runs
 * silently, which is why Scrapingdog reported near zero despite real volume.
 * This is still an ON-DEMAND, manually-invoked diagnostic (never run from a
 * cron or in a loop — see CLAUDE.md on gh polling): each run costs roughly
 * (workflow count) `gh run list` calls plus up to (workflow count × --runs)
 * `gh run view --log` calls. Use a small --runs (the default is 5) unless you
 * specifically need deeper history.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Pricing (USD). Keep in sync with scraper-cost-report.yml + scraper.js.
const BD_PER_REQ = 0.0015;          // Bright Data Web Unlocker, per request
const SD_CREDIT_PAYG = 0.0004;      // Scrapingdog PAYG: $10 / 25,000 credits
const SD_CREDIT_PLAN = 0.00009;     // Scrapingdog Standard: $90 / 1,000,000
const SB_CREDIT = 99 / 1_000_000;   // ScrapingBee Startup: $99 / 1,000,000

const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');

// S0-T8 (BRO-3008): this list used to be a hand-maintained curated set whose
// `name:` strings had drifted from .github/workflows/*.yml (e.g. "Update
// Commercial" vs the real "Update Commercial Data", and a listed "Auto-
// Maintain Show Data" that matches no workflow file at all) — a
// `gh run list --workflow="<wrong name>"` silently returns zero runs, which
// is why Scrapingdog reported near zero despite real SD volume. Derive it
// live from the workflow files that actually carry SCRAPINGDOG_API_KEY, so
// drift is structurally impossible: a workflow can only fall off this list by
// dropping the secret it needs to make SD calls in the first place.
function deriveScrapingWorkflows() {
  let files;
  try { files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')); }
  catch { return null; }
  const names = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'); }
    catch { continue; }
    if (!content.includes('SCRAPINGDOG_API_KEY')) continue;
    const m = content.match(/^name:\s*(.+)$/m);
    if (m) names.push(m[1].trim().replace(/^["']|["']$/g, ''));
  }
  return names.sort();
}

const _derived = deriveScrapingWorkflows();
// Treat a readable-but-empty result the same as an unreadable one: an empty
// list would otherwise silently scan zero workflows and print the exact same
// "No telemetry lines found" message as a genuine zero-events day — the
// identical ambiguity this fix exists to kill (found in review).
const SCRAPING_WORKFLOWS = (_derived && _derived.length > 0) ? _derived : [
  // Fallback if .github/workflows is unreadable (e.g. a sparse checkout) —
  // the same curated set this replaced, kept only as a last resort.
  'Collect Review Texts', 'Gather Review Data', 'Opening Night Poller',
  'Opening Night Reviews', 'Enrich IBDB Dates', 'Bulk Show Score',
  'Scrape BWW Reviews', 'Update Commercial Data',
];
if (!_derived || _derived.length === 0) {
  console.warn(`::warning::measure-scraper-usage: could not derive SD-key workflows from .github/workflows (${_derived ? '0 matched' : 'directory unreadable'}) — using the ${SCRAPING_WORKFLOWS.length}-item fallback list, which may be stale.`);
}

const argRuns = (process.argv.find(a => a.startsWith('--runs=')) || '').split('=')[1];
const RUNS = parseInt(argRuns || '5', 10);
const logfile = (process.argv.find(a => a.startsWith('--logfile=')) || '').split('=')[1];

function gatherLines() {
  if (logfile) return fs.readFileSync(logfile, 'utf8').split('\n');
  console.log(`Scanning ${SCRAPING_WORKFLOWS.length} SD-key workflows x up to ${RUNS} run(s) each — this is an on-demand check, not a loop.`);
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
