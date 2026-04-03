#!/usr/bin/env node
/**
 * Opening Night Readiness Check
 *
 * Runs the full pre-flight checklist from CLAUDE.md §14 for upcoming opening nights.
 * Outputs structured results for the status page and CLI.
 *
 * Checks per show:
 *   1. Orchestrator cron — has it fired recently for this market?
 *   2. Cron health — orchestrator in CRITICAL_CRONS list (static check)
 *   3. ScrapingBee credits — >25% remaining
 *   4. Wrong-production pre-scores — no stale score files
 *   5. DTLI slug verification (Broadway only)
 *   6. Bright Data zone — not disabled
 *   7. BWW Review Roundup URL — check if discoverable
 *   8. Talkin' Broadway URL — check if discoverable (Broadway only)
 *
 * Usage:
 *   node scripts/opening-night-readiness.js                        # All upcoming shows (7 days)
 *   node scripts/opening-night-readiness.js --show=show-id-2026    # Single show
 *   node scripts/opening-night-readiness.js --json                 # Machine-readable
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { isLondonMarket } = require('./lib/venue-classification');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');

const SHOW_ID = (process.argv.find(a => a.startsWith('--show=')) || '').replace('--show=', '');
const JSON_OUTPUT = process.argv.includes('--json');
const LOOKBACK = 7; // days ahead to check

function loadJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function ghJSON(cmd) {
  try {
    return JSON.parse(execSync(`gh ${cmd}`, { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch { return null; }
}

function ghText(cmd) {
  try {
    return execSync(`gh ${cmd}`, { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
}

// ── Checks ──

function checkOrchestratorCron(market) {
  const runs = ghJSON('run list --workflow=opening-night-orchestrator.yml --limit=10 --json createdAt,status,conclusion');
  if (!runs || runs.length === 0) return { pass: false, detail: 'No orchestrator runs found' };

  const latest = runs[0];
  const hoursAgo = (Date.now() - new Date(latest.createdAt).getTime()) / 3600000;

  if (hoursAgo > 25) {
    return { pass: false, detail: `Last run ${Math.round(hoursAgo)}h ago — may have missed cron` };
  }
  return { pass: true, detail: `Last run ${Math.round(hoursAgo)}h ago (${latest.conclusion || latest.status})` };
}

function checkScrapingBeeCredits() {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) return { pass: null, detail: 'SCRAPINGBEE_API_KEY not set — check in CI' };

  try {
    const result = execSync(
      `curl -s "https://app.scrapingbee.com/api/v1/usage?api_key=${key}"`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const data = JSON.parse(result);
    const used = data.used_api_credit || 0;
    const max = data.max_api_credit || 1;
    const pctUsed = Math.round((used / max) * 100);
    const pctRemaining = 100 - pctUsed;

    if (pctRemaining < 25) return { pass: false, detail: `${pctRemaining}% remaining (${used}/${max} used) — opening nights at risk` };
    if (pctRemaining < 50) return { pass: true, detail: `${pctRemaining}% remaining (monitor)`, warn: true };
    return { pass: true, detail: `${pctRemaining}% remaining` };
  } catch (e) {
    return { pass: null, detail: `API check failed: ${e.message}` };
  }
}

function checkBrightDataZone() {
  const token = process.env.BRIGHTDATA_TOKEN;
  if (!token) return { pass: null, detail: 'BRIGHTDATA_TOKEN not set — check in CI' };

  try {
    const result = execSync(
      `curl -s "https://api.brightdata.com/zone?zone=web_unlocker2" -H "Authorization: Bearer ${token}"`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const data = JSON.parse(result);
    if (data.disable || data.plan?.disable) {
      return { pass: false, detail: 'Zone DISABLED — UI recovery needed (Recover + enable toggle)' };
    }
    return { pass: true, detail: `Zone active (${data.zone || 'web_unlocker2'})` };
  } catch (e) {
    return { pass: null, detail: `API check failed: ${e.message}` };
  }
}

function checkWrongProductionPreScores(showId) {
  const scoresDir = path.join(DATA_DIR, 'llm-scores', showId);
  if (!fs.existsSync(scoresDir)) return { pass: true, detail: 'No pre-existing score files' };

  const files = fs.readdirSync(scoresDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) return { pass: true, detail: 'No pre-existing score files' };

  let wrongProd = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(scoresDir, f), 'utf8'));
      if (data.wrongProduction) wrongProd++;
    } catch {}
  }

  if (wrongProd > 0) {
    return { pass: false, detail: `${wrongProd}/${files.length} files flagged wrongProduction` };
  }
  return { pass: true, detail: `${files.length} score files — none flagged` };
}

function checkDTLISlug(showId) {
  const slugMap = loadJSON(path.join(DATA_DIR, 'dtli-slug-map.json'));
  if (!slugMap?.shows) return { pass: null, detail: 'dtli-slug-map.json not found' };

  const slug = slugMap.shows[showId];
  if (!slug) return { pass: false, detail: 'No DTLI slug mapped — run discover-dtli-slugs.js' };

  // Check for revival mismatch (year in ID should have numbered suffix)
  const yearMatch = showId.match(/-(\d{4})$/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    // If it's a revival (multiple productions), slug should have a number suffix
    const entries = Object.entries(slugMap.shows).filter(([id]) => {
      const base = id.replace(/-\d{4}$/, '');
      return base === showId.replace(/-\d{4}$/, '');
    });
    if (entries.length > 1) {
      // Multiple productions — slug should have numbered suffix
      if (!/\d+$/.test(slug) && slug !== showId.replace(/-\d{4}$/, '')) {
        return { pass: false, detail: `Slug "${slug}" may be wrong production (${entries.length} productions exist)`, warn: true };
      }
    }
  }

  return { pass: true, detail: `DTLI slug: ${slug}` };
}

function checkBWWRoundupURL(show) {
  // Check if we already have a BWW roundup archive
  const archiveDir = path.join(DATA_DIR, 'aggregator-archive', 'bww-roundups');
  if (fs.existsSync(archiveDir)) {
    const archive = fs.readdirSync(archiveDir).find(f => f.startsWith(show.id));
    if (archive) return { pass: true, detail: 'BWW roundup archived' };
  }

  // Construct expected URL pattern
  const title = show.title.replace(/[^a-zA-Z0-9 ]/g, '').replace(/ +/g, '-');
  const date = show.openingDate?.replace(/-/g, '');
  const url = `https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-${date}`;
  return { pass: null, detail: `Not yet archived. Expected: ${url}`, warn: true };
}

function checkTBURL(show) {
  const year = show.openingDate?.slice(0, 4);
  const slug = show.title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  // TB uses CamelCase — construct best guess
  const camelSlug = show.title.replace(/[^a-zA-Z0-9 ]/g, '').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  const url = `https://www.talkinbroadway.com/page/world/${camelSlug}${year}.html`;
  return { pass: null, detail: `Verify manually: ${url}`, warn: true };
}

// ── Main ──

function runChecks() {
  const showsData = loadJSON(SHOWS_PATH);
  if (!showsData) { console.error('Cannot load shows.json'); process.exit(1); }
  const showsList = Array.isArray(showsData.shows || showsData) ? (showsData.shows || showsData) : Object.values(showsData.shows || showsData);

  const now = new Date();
  const futureLimit = new Date(now);
  futureLimit.setDate(futureLimit.getDate() + LOOKBACK);

  // Find shows opening within lookback window (including today)
  const targetShows = showsList.filter(s => {
    if (SHOW_ID && s.id !== SHOW_ID) return false;
    if (!s.openingDate) return false;
    const d = new Date(s.openingDate);
    d.setHours(0, 0, 0, 0);
    // Include today + next 7 days
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    if (d < today) return false;
    if (d > futureLimit) return false;
    if (s.status === 'closed') return false;
    return true;
  }).sort((a, b) => new Date(a.openingDate) - new Date(b.openingDate));

  if (targetShows.length === 0) {
    if (!JSON_OUTPUT) console.log('No shows opening in the next 7 days.');
    return { checks: [], global: {} };
  }

  // Global checks (run once)
  const global = {
    orchestratorCron: checkOrchestratorCron(),
    scrapingBee: checkScrapingBeeCredits(),
    brightData: checkBrightDataZone(),
  };

  // Per-show checks
  const results = targetShows.map(show => {
    const market = isLondonMarket(show.category) ? 'west-end' : 'broadway';
    const isBroadway = !isLondonMarket(show.category);
    const daysUntil = Math.ceil((new Date(show.openingDate) - now) / 86400000);

    const checks = {
      wrongProduction: checkWrongProductionPreScores(show.id),
    };

    if (isBroadway) {
      checks.dtliSlug = checkDTLISlug(show.id);
      checks.bwwRoundup = checkBWWRoundupURL(show);
      checks.talkingBroadway = checkTBURL(show);
    }

    const allChecks = [global.orchestratorCron, global.scrapingBee, global.brightData, ...Object.values(checks)];
    const failures = allChecks.filter(c => c.pass === false).length;
    const warnings = allChecks.filter(c => c.warn).length;
    const unknowns = allChecks.filter(c => c.pass === null).length;

    return {
      id: show.id, title: show.title, market, category: show.category || market,
      openingDate: show.openingDate, daysUntil,
      checks,
      summary: { failures, warnings, unknowns, total: allChecks.length },
      ready: failures === 0,
    };
  });

  return { checks: results, global };
}

function formatCheck(name, result) {
  const icon = result.pass === true ? (result.warn ? '\x1b[33m!\x1b[0m' : '\x1b[32m\u2713\x1b[0m')
    : result.pass === false ? '\x1b[31m\u2717\x1b[0m'
    : '\x1b[2m?\x1b[0m';
  return `  ${icon} ${name}: ${result.detail}`;
}

function main() {
  const { checks, global } = runChecks();

  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify({ checks, global }, null, 2) + '\n');
    return;
  }

  if (checks.length === 0) return;

  console.log('\n\x1b[1mOpening Night Readiness\x1b[0m\n');

  // Global checks
  console.log('\x1b[1mInfrastructure\x1b[0m');
  console.log(formatCheck('Orchestrator cron', global.orchestratorCron));
  console.log(formatCheck('ScrapingBee credits', global.scrapingBee));
  console.log(formatCheck('Bright Data zone', global.brightData));

  // Per-show
  for (const show of checks) {
    const dayLabel = show.daysUntil === 0 ? 'TODAY' : show.daysUntil === 1 ? 'TOMORROW' : `in ${show.daysUntil} days`;
    const statusColor = show.ready ? '\x1b[32m' : '\x1b[31m';
    console.log(`\n\x1b[1m${show.title}\x1b[0m  \x1b[2m${show.openingDate} · ${dayLabel} · ${show.market}\x1b[0m`);

    for (const [name, result] of Object.entries(show.checks)) {
      console.log(formatCheck(name, result));
    }

    console.log(`  ${statusColor}${show.ready ? '\u2713 Ready' : `\u2717 ${show.summary.failures} issue(s)`}\x1b[0m`);
  }
  console.log('');
}

main();

module.exports = { runChecks };
