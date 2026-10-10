#!/usr/bin/env node
'use strict';

/**
 * check-cost-anchors.js — BRO-4989 weekly cost-data checks (see
 * scripts/lib/cost-anchor-checks.js). Prints stale / below-floor / missing-tier
 * findings; with --queue, adds up to --max (default 3) of the stalest open
 * shows to data/commercial-research-queue.json (trigger 'stale-cost-anchor'),
 * capped so one run never fans out into a burst of paid research. Shows
 * researched in the last 180 days are skipped (no weekly re-queue loop).
 *
 *   node scripts/check-cost-anchors.js [--queue] [--max=3] [--json]
 *
 * Exit 1 when a figure is below its category floor or lacks a source tier
 * (data errors); stale figures only queue.
 */

const fs = require('fs');
const path = require('path');
const { historyWithSeeds } = require('./lib/cost-history');
const { costForWeek } = require('./lib/cost-for-week');
const { classifyShow } = require('./lib/recoupment-model');
const { checkCostAnchors, refreshOrder, recentlyResearched } = require('./lib/cost-anchor-checks');
const { addToQueue } = require('./lib/commercial-queue');

const DATA = path.join(__dirname, '..', 'data');
const QUEUE = path.join(DATA, 'commercial-research-queue.json');
const args = process.argv.slice(2);
if (require('./lib/cli-help').hasHelpFlag(args)) {
  console.log('Usage: node scripts/check-cost-anchors.js [--queue] [--max=3] [--json]  (see header)');
  process.exit(0);
}
const QUEUE_ON = args.includes('--queue');
const MAX = Number(args.find((a) => a.startsWith('--max='))?.split('=')[1] || 3);
const NOT_COMMERCIAL = new Set(['Nonprofit', 'Tour Stop']);

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function main() {
  const commercial = load(path.join(DATA, 'commercial.json')).shows;
  const shows = Object.values(load(path.join(DATA, 'shows.json')).shows);
  const seeds = load(path.join(DATA, 'cost-anchor-seeds.json')).anchors;
  const by = {};
  for (const s of shows) { by[s.id] = s; if (s.slug) by[s.slug] = s; }
  const today = new Date().toISOString().slice(0, 10);

  const results = [];
  for (const [slug, record] of Object.entries(commercial)) {
    if (NOT_COMMERCIAL.has(record.designation)) continue;
    const show = by[slug] || by[record.slug] || by[slug.replace(/-\d{4}$/, '')];
    if (!show) continue;
    const history = historyWithSeeds(record, show, seeds[slug] || []);
    const category = classifyShow(show);
    const cw = history.length ? costForWeek({ ...record, costHistory: history }, today, { show, category }) : null;
    results.push(checkCostAnchors({ slug, record, show, history, currentCost: cw?.cost, category }));
  }

  const stale = refreshOrder(results);
  const floor = results.filter((r) => r.floor);
  const tier = results.filter((r) => r.tier.length);
  if (args.includes('--json')) console.log(JSON.stringify({ stale, floor, tier }, null, 2));
  else {
    console.log(`Cost checks: ${results.length} commercial shows`);
    console.log(`  stale (open, newest reported figure > 3 yrs or none): ${stale.length}`);
    for (const r of stale) console.log(`    ${r.slug}: ${r.stale.newest || 'no dated reported figure'}${r.stale.ageYears ? ` (${r.stale.ageYears} yrs)` : ''}`);
    console.log(`  below category floor: ${floor.length}`);
    for (const r of floor) console.log(`    ${r.slug}: $${r.floor.currentCost}/wk < $${r.floor.floor} (${r.floor.category})`);
    console.log(`  missing/invalid source tier: ${tier.length}`);
    for (const r of tier) console.log(`    ${r.slug}: ${r.tier.join(' | ')}`);
  }

  if (QUEUE_ON && stale.length) {
    const queue = fs.existsSync(QUEUE) ? load(QUEUE) : { shows: [] };
    const fresh = stale
      .filter((r) => !recentlyResearched(commercial[r.slug]))
      .map((r) => r.slug).filter((s) => !(queue.shows || []).includes(s)).slice(0, MAX);
    if (fresh.length) {
      fs.writeFileSync(QUEUE, JSON.stringify(addToQueue(queue, fresh, 'stale-cost-anchor'), null, 2) + '\n');
      console.log(`Queued for cost refresh: ${fresh.join(', ')}`);
    } else console.log('Nothing new to queue.');
  }

  if (floor.length || tier.length) {
    console.log(`::warning::cost data: ${floor.length} below floor, ${tier.length} missing source tier`);
    process.exit(1);
  }
}

main();
