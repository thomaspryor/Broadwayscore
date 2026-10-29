#!/usr/bin/env node
'use strict';
/**
 * BRO-6541 CLI: match the London census's regional-uk items to UK hub shows and list the
 * reviews we do not hold yet. Read-only. Logic: scripts/lib/uk-regional-census-match.js.
 *
 *   node scripts/uk-regional-census-match.js [--since=2024-01-01] [--outlet=a,b] [--out=<file.json>]
 *   node scripts/uk-regional-census-match.js --guardian   also list each hub show's seeding
 *                                                         Guardian review (evidenceUrls) when not held
 *   --plans=bro-N-x   write the not-held reviews as pending-fix plans (run-script
 *                     ingest-review-from-url.js, 25 per plan) to data/pending-fixes/
 */
const fs = require('fs');
const path = require('path');
const { matchCensusItems } = require('./lib/uk-regional-census-match');
const { urlKey } = require('./lib/outlet-feed-reconcile');
const { hasHelpFlag } = require('./lib/cli-help');
const { buildPlans } = require('./new-fix-plan');

const ROOT = path.join(__dirname, '..');
const CENSUS_DIR = path.join(ROOT, 'data', 'audit', 'outlet-census', 'london');

function heldUrlIndex(showIds) {
  const dir = path.join(ROOT, 'data', 'review-texts');
  const held = new Map();
  for (const id of showIds) {
    const set = new Set();
    const d = path.join(dir, id);
    if (fs.existsSync(d)) {
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
          for (const u of [r.url, r.originalUrl, ...(r.altUrls || [])]) if (u) set.add(urlKey(u));
          set.add(`outlet:${r.outletId || f.split('--')[0]}`);
        } catch { /* unreadable file: not held */ }
      }
    }
    held.set(id, set);
  }
  return held;
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/uk-regional-census-match.js [--since=YYYY-MM-DD] [--outlet=a,b] [--guardian] [--out=<file.json>]');
    return;
  }
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || null;
  const since = arg('since') || '2024-01-01';
  const outlets = arg('outlet') ? new Set(arg('outlet').split(',')) : null;
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = (Array.isArray(data) ? data : data.shows).filter((s) => /-uk$/.test(s.city || ''));
  const held = heldUrlIndex(shows.map((s) => s.id));

  const items = [];
  for (const f of fs.readdirSync(CENSUS_DIR).filter((x) => x.endsWith('.manifest.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(CENSUS_DIR, f), 'utf8'));
    if (outlets && !outlets.has(m.outletId)) continue;
    for (const i of m.items || []) {
      if (i.itemMarket !== 'regional-uk' || String(i.publishDate || '') < since) continue;
      items.push({ ...i, outletId: m.outletId });
    }
  }
  const res = matchCensusItems(items, shows, held, urlKey);

  const guardian = [];
  if (argv.includes('--guardian')) {
    for (const s of shows) {
      const u = (s.evidenceUrls || []).find((x) => /theguardian\.com\/stage\//.test(x));
      if (u && !held.get(s.id).has(urlKey(u)) && !held.get(s.id).has('outlet:guardian')) guardian.push({ showId: s.id, url: u, outletId: 'guardian' });
    }
  }

  const byOutlet = {};
  for (const r of res.matched) byOutlet[r.outletId] = (byOutlet[r.outletId] || 0) + 1;
  console.log(`hub shows ${shows.length}; census regional-uk items since ${since}: ${items.length}`);
  console.log(`matched-not-held ${res.matched.length}, already held ${res.held.length}, ambiguous ${res.ambiguous.length}, unmatched ${res.unmatched.length}`);
  console.log(`by outlet: ${JSON.stringify(byOutlet)}`);
  if (guardian.length) console.log(`guardian seeding reviews not held: ${guardian.length}`);
  for (const a of res.ambiguous.slice(0, 10)) console.log(`  AMBIGUOUS ${a.url} -> ${a.showIds.join(', ')}`);
  const prefix = arg('plans');
  if (prefix) {
    // One review per outlet per production: a second file from an outlet the show already
    // holds is almost always another leg of a co-production tour.
    const seen = new Set();
    const rows = [...guardian, ...res.matched].filter((r) => {
      const showOutlet = `${r.showId}|${r.outletId}`;
      if (seen.has(showOutlet) || held.get(r.showId).has(`outlet:${r.outletId}`) || !/^[A-Za-z0-9:/._~%=+,-]+$/.test(r.url)) return false;
      seen.add(showOutlet);
      return true;
    });
    console.log(`plan rows ${rows.length} (one per show and outlet, outlets already held skipped)`);
    const actions = rows.map((r) => ({
      type: 'run-script',
      script: 'ingest-review-from-url.js',
      args: `--show=${r.showId} --url=${r.url} --outlet=${r.outletId}`,
      description: `BRO-6541: ingest ${r.outletId} review for ${r.showId}`,
    }));
    for (const p of buildPlans(prefix, 'BRO-6541: ingest UK hub reviews (Guardian seeding reviews + census matches)', actions)) {
      const file = path.join(ROOT, 'data', 'pending-fixes', `${p.name}.json`);
      fs.writeFileSync(file, `${JSON.stringify(p.plan, null, 2)}\n`);
      console.log(`plan ${p.name}: ${p.plan.plan.actions.length} actions, planId ${p.plan.planId}`);
    }
  }
  const out = arg('out');
  if (out) {
    fs.writeFileSync(out, `${JSON.stringify({ since, matched: res.matched, guardian, ambiguous: res.ambiguous, heldCount: res.held.length }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
  return res;
}

if (require.main === module) main();
module.exports = { main };
