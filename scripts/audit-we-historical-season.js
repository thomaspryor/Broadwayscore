#!/usr/bin/env node
/**
 * audit-we-historical-season.js
 *
 * Quality gate for one West End historical backfill season (BRO-4851, plan
 * v3.1 docs/specs/west-end-historical-backfill-v3.md "Season audit"). Read-only:
 * prints pass/fail per check, writes nothing. Measure it ~7 days after the
 * season's last scoring dispatch; a season must pass before the next starts.
 *
 * Checks, over shows promoted by promote-historical-we.js
 * (discoverySource 'we-historical:wos') for the season:
 *   1. displayable   >= 70% of shows have >= 5 scored reviews
 *   2. in-window     every scored review is inside the show's run window
 *                    (date-guard.js evaluateDateGuard, the same rule the
 *                    rebuild's flagger uses), so no review of another
 *                    production is counted
 *   3. duplicates    no outlet+critic appears twice for one show
 *   4. provenance    share of T1/T2 reviews with a URL (reported, not gated:
 *                    paywalled Theatre Record texts legitimately lack one)
 *
 * Usage:
 *   node scripts/audit-we-historical-season.js --season=2024-2025 [--json] [--ids=a,b]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { evaluateDateGuard } = require('./lib/date-guard');
const { getOutletTier } = require('./lib/review-normalization');
const { hasHelpFlag } = require('./lib/cli-help.js');

const DISCOVERY_SOURCE = 'we-historical:wos';
const MIN_SCORED = 5;
const MIN_DISPLAYABLE_SHARE = 0.7;

const USAGE = `audit-we-historical-season.js — pass/fail quality gate for a West End historical season.

Usage:
  node scripts/audit-we-historical-season.js --season=YYYY-YYYY [options]

Options:
  --ids=a,b     Audit only these show ids (e.g. a pilot batch)
  --json        Print the result as JSON
  --help, -h    print this usage and exit
`;

const isScored = r => typeof r.assignedScore === 'number' && Number.isFinite(r.assignedScore);

/**
 * Pure: shows + reviews → audit result.
 * @param {{shows: object[], reviews: object[], season: string, ids?: Set<string>}} input
 */
function auditSeason({ shows, reviews, season, ids }) {
  const promoted = shows.filter(s => s.discoverySource === DISCOVERY_SOURCE && s.season === season
    && (!ids || !ids.size || ids.has(s.id)));
  const byShow = new Map(promoted.map(s => [s.id, []]));
  for (const r of reviews) if (byShow.has(r.showId)) byShow.get(r.showId).push(r);

  const perShow = [];
  const outOfWindow = [];
  const duplicates = [];
  let t12 = 0;
  let t12WithUrl = 0;
  for (const show of promoted) {
    const rows = byShow.get(show.id);
    const scored = rows.filter(isScored);
    const seen = new Map();
    for (const r of scored) {
      const pub = r.publishDate ? new Date(String(r.publishDate).slice(0, 10)) : null;
      if (pub && !Number.isNaN(pub.getTime())) {
        const d = evaluateDateGuard({ pubDate: pub, show, outletId: r.outletId });
        if (d && d.flag) outOfWindow.push({ showId: show.id, outlet: r.outlet, critic: r.criticName, publishDate: r.publishDate });
      }
      const key = `${r.outletId || r.outlet}|${String(r.criticName || '').toLowerCase()}`;
      if (seen.has(key)) duplicates.push({ showId: show.id, outlet: r.outlet, critic: r.criticName });
      seen.set(key, true);
      const tier = getOutletTier(r.outletId);
      if (tier === 1 || tier === 2) { t12++; if (r.url) t12WithUrl++; }
    }
    perShow.push({ id: show.id, scored: scored.length, total: rows.length, displayable: scored.length >= MIN_SCORED });
  }

  const displayableShare = promoted.length ? perShow.filter(s => s.displayable).length / promoted.length : 0;
  const checks = {
    displayable: { pass: displayableShare >= MIN_DISPLAYABLE_SHARE, value: Math.round(displayableShare * 100) / 100, threshold: MIN_DISPLAYABLE_SHARE },
    inWindow: { pass: outOfWindow.length === 0, value: outOfWindow.length, rows: outOfWindow },
    duplicates: { pass: duplicates.length === 0, value: duplicates.length, rows: duplicates },
    provenance: { pass: null, value: t12 ? Math.round((t12WithUrl / t12) * 100) / 100 : null, note: `${t12WithUrl}/${t12} T1/T2 reviews have a URL (reported, not gated)` },
  };
  const gated = Object.values(checks).filter(c => c.pass !== null);
  return { season, shows: promoted.length, pass: promoted.length > 0 && gated.every(c => c.pass), checks, perShow };
}

function main() {
  const args = process.argv.slice(2);
  const season = args.find(a => a.startsWith('--season='))?.split('=')[1];
  if (!season) { console.error('Usage: node scripts/audit-we-historical-season.js --season=YYYY-YYYY'); process.exit(2); }
  const ids = new Set((args.find(a => a.startsWith('--ids='))?.split('=')[1] || '').split(',').filter(Boolean));
  const root = path.join(__dirname, '..');
  const showsRaw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
  const reviewsRaw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reviews.json'), 'utf8'));
  const shows = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || Object.values(showsRaw));
  const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : (reviewsRaw.reviews || []);
  const result = auditSeason({ shows, reviews, season, ids });

  if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); }
  else {
    console.log(`West End historical season ${season}: ${result.shows} promoted show(s)`);
    for (const s of result.perShow) console.log(`  ${s.displayable ? '✓' : '·'} ${s.id}: ${s.scored} scored / ${s.total} reviews`);
    const c = result.checks;
    const mark = p => (p === null ? 'INFO' : p ? 'PASS' : 'FAIL');
    console.log(`${mark(c.displayable.pass)} displayable: ${c.displayable.value} (need >= ${c.displayable.threshold})`);
    console.log(`${mark(c.inWindow.pass)} in-window: ${c.inWindow.value} review(s) outside their show's run`);
    for (const r of c.inWindow.rows) console.log(`    ${r.showId}: ${r.outlet} / ${r.critic} ${r.publishDate}`);
    console.log(`${mark(c.duplicates.pass)} duplicates: ${c.duplicates.value}`);
    for (const r of c.duplicates.rows) console.log(`    ${r.showId}: ${r.outlet} / ${r.critic}`);
    console.log(`${mark(c.provenance.pass)} provenance: ${c.provenance.note}`);
    console.log(result.pass ? 'SEASON PASS' : 'SEASON FAIL');
  }
  process.exit(result.pass ? 0 : 1);
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  main();
}

module.exports = { auditSeason };
