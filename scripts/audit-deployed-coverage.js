#!/usr/bin/env node
'use strict';

/**
 * audit-deployed-coverage.js — B4 of the v2 reconciler Sprint B plan.
 *
 * Diffs internal coverage against what production ACTUALLY SERVES
 * (broadwayscorecard.com/data/shows/{id}.json), closing the last hop every other
 * coverage audit is blind to: a review can be collected, scored, and present in
 * reviews.json while the site serves a build that predates it. That hop fails
 * silently — a cancel-cascaded Vercel deploy reports `success` on the GitHub run
 * while its deployment ends CANCELED (see check-prod-deploy.js's header).
 *
 * Decision logic lives in lib/deployed-coverage-diff.js (pure, unit-tested);
 * this file is fetch + report + route.
 *
 * WHY plain fetch and not fetchPage(): this reads our OWN public static JSON off
 * the CDN. It is not scraping a third party, so the Bright Data/ScrapingBee chain
 * would spend credits for nothing. Deliberately NOT the HTML pages either —
 * curling prod HTML trips Vercel's bot checkpoint, while the public JSON is the
 * sanctioned verification channel (memory/feedback_prod_curl_vercel_checkpoint).
 *
 * Usage:
 *   node scripts/audit-deployed-coverage.js                  # last 21 days of openings
 *   node scripts/audit-deployed-coverage.js --days=90
 *   node scripts/audit-deployed-coverage.js --show=ID        # one show
 *   node scripts/audit-deployed-coverage.js --alert          # route findings to the digest
 *   node scripts/audit-deployed-coverage.js --base=URL       # point at a preview deployment
 *   node scripts/audit-deployed-coverage.js --fixture=DIR    # read DIR/{showId}.json instead of the network
 *   node scripts/audit-deployed-coverage.js --fail-on-defect # exit 1 when anything is stale (CI gate)
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { diffShow, summarize, deployedShowUrl } = require('./lib/deployed-coverage-diff');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_SHOWS = path.join(ROOT, 'public', 'data', 'shows');
const REPORT_PATH = path.join(DATA_DIR, 'audit', 'deployed-coverage-diff.json');

const USAGE = `audit-deployed-coverage.js — diff internal coverage vs the DEPLOYED public JSON.

Usage:
  node scripts/audit-deployed-coverage.js [options]

Options:
  --days=N            openings window to check (default 21)
  --show=ID           check one show only (ignores --days)
  --base=URL          origin to diff against (default https://broadwayscorecard.com)
  --fixture=DIR       read DIR/{showId}.json instead of fetching (offline/CI verification)
  --alert             route findings through owner-alert-router (digest disposition)
  --fail-on-defect    exit 1 if any show is stale/missing on prod (CI gate)
  --report-path=P     where to write the JSON report (default data/audit/deployed-coverage-diff.json)
  --time-budget-min=N stop cleanly after N minutes and report what was skipped
  --concurrency=N     parallel fetches (default 6)
  -h, --help          print this and exit
`;

function parseArgs(argv) {
  const o = {
    days: 21, showId: null, base: 'https://broadwayscorecard.com', fixture: null,
    alert: false, failOnDefect: false, reportPath: REPORT_PATH, concurrency: 6,
  };
  for (const a of argv) {
    if (a.startsWith('--days=')) o.days = parseInt(a.split('=')[1], 10) || o.days;
    else if (a.startsWith('--show=')) o.showId = a.split('=')[1];
    else if (a.startsWith('--base=')) o.base = a.split('=')[1].replace(/\/$/, '');
    else if (a.startsWith('--fixture=')) o.fixture = a.split('=')[1];
    else if (a === '--alert') o.alert = true;
    else if (a === '--fail-on-defect') o.failOnDefect = true;
    else if (a.startsWith('--report-path=')) o.reportPath = a.split('=')[1];
    else if (a.startsWith('--concurrency=')) o.concurrency = Math.max(1, parseInt(a.split('=')[1], 10) || 6);
  }
  return o;
}

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Local canonical Critic Score for a show — the SAME field the site publishes. */
function localCs(showId) {
  try {
    const j = loadJSON(path.join(PUBLIC_SHOWS, `${showId}.json`));
    return typeof j.cs === 'number' ? j.cs : null;
  } catch { return null; }
}

/**
 * Fetch one deployed payload. Returns { deployedJson, fetchError }. NEVER throws:
 * a network blip must degrade to one 'unreachable' row, not abort the audit.
 */
async function fetchDeployed(showId, opts) {
  if (opts.fixture) {
    const p = path.join(opts.fixture, `${showId}.json`);
    if (!fs.existsSync(p)) return { deployedJson: null, fetchError: 'fixture missing' };
    try { return { deployedJson: loadJSON(p) }; }
    catch (e) { return { deployedJson: null, fetchError: `fixture unparseable: ${e.message}` }; }
  }
  const url = deployedShowUrl(showId, opts.base);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      // cache:'no-store' matters: without it a CDN/agent cache can serve us the
      // very stale copy we are trying to detect, and the audit reports green.
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) return { deployedJson: null, fetchError: `HTTP ${res.status}` };
    return { deployedJson: await res.json() };
  } catch (e) {
    return { deployedJson: null, fetchError: e.name === 'TimeoutError' ? 'fetch timeout (20s)' : e.message };
  }
}

// Small fixed-size worker pool — 6 concurrent CDN GETs is polite and keeps a
// 90-day window under a minute.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const opts = parseArgs(process.argv.slice(2));
  const budget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));

  const showsData = loadJSON(path.join(DATA_DIR, 'shows.json'));
  const shows = showsData.shows || showsData;
  const reviewsData = loadJSON(path.join(DATA_DIR, 'reviews.json'));
  const reviews = reviewsData.reviews || reviewsData;

  const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString().split('T')[0];
  const targets = opts.showId
    ? shows.filter((s) => (s.id || s.slug) === opts.showId)
    : shows.filter((s) => s.status === 'open' || (s.openingDate && s.openingDate >= cutoff));
  if (!targets.length) {
    console.log(opts.showId ? `Show not found: ${opts.showId}` : `No shows open or opened since ${cutoff}.`);
    process.exit(opts.showId ? 1 : 0);
  }

  // Index scored outlets per show once — reviews.json is large.
  const scoredByShow = new Map();
  for (const r of reviews) {
    if (!r || r.assignedScore == null || !r.outletId || !r.showId) continue;
    if (!scoredByShow.has(r.showId)) scoredByShow.set(r.showId, new Set());
    scoredByShow.get(r.showId).add(r.outletId);
  }

  console.log(`\n=== Deployed Coverage Diff (${opts.fixture ? `fixture ${opts.fixture}` : opts.base}) ===`);
  console.log(`${targets.length} show(s): open, or opened since ${cutoff}\n`);

  let skippedForBudget = 0;
  const rows = await mapPool(targets, opts.concurrency, async (show) => {
    const showId = show.id || show.slug;
    if (budget.exceeded()) { skippedForBudget++; return null; }
    const { deployedJson, fetchError } = await fetchDeployed(showId, opts);
    return diffShow({
      showId, title: show.title, openingDate: show.openingDate || null,
      localScoredOutletIds: scoredByShow.get(showId) || new Set(),
      localCs: localCs(showId),
      deployedJson, fetchError,
    });
  });

  const summary = summarize(rows);
  for (const r of summary.shows.slice(0, 40)) {
    console.log(`${r.title} (${r.showId})`);
    for (const d of r.defects) console.log(`  ${d.type === 'unreachable' ? '🚨' : '⚠️ '} ${d.type}: ${d.detail}`);
  }
  if (summary.shows.length > 40) console.log(`… ${summary.shows.length - 40} more defective show(s)`);

  console.log(`\n=== Summary ===`);
  console.log(`Checked: ${summary.checked} | clean: ${summary.clean} | stale/missing on prod: ${summary.defective}`);
  for (const [type, n] of Object.entries(summary.byType)) console.log(`  ${type}: ${n}`);
  if (skippedForBudget > 0) {
    console.log(`⏱  ${skippedForBudget} show(s) SKIPPED — ${budget.minutes}min time budget spent (not checked, not clean).`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    base: opts.fixture ? `fixture:${opts.fixture}` : opts.base,
    daysChecked: opts.days,
    skippedForBudget,
    ...summary,
  };
  try {
    fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
    fs.writeFileSync(opts.reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nReport → ${opts.reportPath}`);
  } catch (e) { console.error('Failed to write report:', e.message); }

  if (opts.alert && summary.defective > 0) {
    try {
      const { routeAlert } = require('./lib/owner-alert-router');
      const routed = await routeAlert({
        conditionKey: 'deployed-coverage:stale',
        title: 'Deployed coverage — the site is serving stale coverage',
        description: [
          `${summary.defective}/${summary.checked} show(s) differ between internal state and what prod serves.`,
          ...Object.entries(summary.byType).map(([t, n]) => `${t}: ${n}`),
          ...summary.shows.slice(0, 5).map((r) => `${r.title}: ${r.defects.map((d) => d.type).join('+')}`),
        ].join('\n'),
        severity: 'error',
        // 'digest' per the owner mandate (card #611): ALL non-page-worthy senders
        // ride the one morning email. cooldownHours < 24 so the daily digest
        // always sees a current line instead of a week-old one.
        disposition: 'digest',
        cooldownHours: 20,
      });
      // routeAlert('digest') can answer 'silent' when a fresher line is already
      // queued — must be handled explicitly (lint guard, card #616).
      console.log(routed.action === 'silent'
        ? 'Digest line suppressed (a fresher one is already queued within 20h).'
        : `Queued for the daily digest (${summary.defective} stale show(s)).`);
    } catch (e) { console.error('Alert routing failed:', e.message); }
  }

  if (opts.failOnDefect && summary.defective > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
