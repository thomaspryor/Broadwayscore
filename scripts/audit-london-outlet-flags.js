#!/usr/bin/env node
/**
 * audit-london-outlet-flags.js — Read-only count of NYC-show reviews held back
 * by the reverse cross-market guard ("Cross-market: London outlet") and of the
 * ones the rebuild's reverse self-heal has released (BRO-5896).
 *
 * A US outlet wrongly stamped region:'london' (BRO-133 backfill) loses every
 * Broadway / off-Broadway review it writes. Once its region is corrected the
 * rebuild clears those flags and stamps wrongProductionAutoCleared; this
 * script reports both sides, grouped by outlet with the outlet's current
 * registry region, so a wrong stamp shows up as a big "still flagged" row.
 *
 * Usage:
 *   node scripts/audit-london-outlet-flags.js                    # report
 *   node scripts/audit-london-outlet-flags.js --since=2026-10-22 # released on/after date
 *   node scripts/audit-london-outlet-flags.js --json             # machine-readable
 *   node scripts/audit-london-outlet-flags.js --dir=PATH         # other review-texts root
 *   node scripts/audit-london-outlet-flags.js --help, -h
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { normalizeOutlet } = require('./lib/review-normalization');
const { buildOutletMaps } = require('./lib/outlet-region-map');
const { isBroadwayCategory, isOffBroadwayCategory } = require('./lib/venue-classification');

const USAGE = `audit-london-outlet-flags.js — count NYC reviews held or released by the London-outlet cross-market guard.

Usage:
  node scripts/audit-london-outlet-flags.js [--since=YYYY-MM-DD] [--json]
  node scripts/audit-london-outlet-flags.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv)) { process.stdout.write(USAGE); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const REVIEW_TEXTS_DIR = dirArg ? path.resolve(dirArg.slice('--dir='.length)) : path.join(ROOT, 'data', 'review-texts');
const sinceArg = process.argv.find((a) => a.startsWith('--since='));
const since = sinceArg ? sinceArg.slice('--since='.length) : '';
const asJson = process.argv.includes('--json');

// Stamps written by the reverse self-heal in rebuild-all-reviews.js.
const RELEASE_STAMPS = ['rebuild: non-London region outlet on its own domain', 'rebuild: dual-market outlet on its own US domain'];

function main() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`No ${path.relative(ROOT, REVIEW_TEXTS_DIR)}; run with review texts (cloud-run-script.js --review-texts).`);
    process.exit(1);
  }
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')).shows || [];
  const nycShows = new Set(shows.filter((s) => isBroadwayCategory(s) || isOffBroadwayCategory(s)).map((s) => s.id));
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
  const { canonicalOutletId } = buildOutletMaps(registry);

  const byOutlet = {};
  const row = (id) => (byOutlet[id] = byOutlet[id] || { stillFlagged: 0, released: 0 });
  let stillFlagged = 0;
  let released = 0;
  for (const showId of fs.readdirSync(REVIEW_TEXTS_DIR)) {
    if (!nycShows.has(showId)) continue;
    const dir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { continue; }
    for (const file of files) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      const raw = String(data.outletId || data.outlet || '').toLowerCase();
      const id = canonicalOutletId[normalizeOutlet(raw)] || canonicalOutletId[raw] || normalizeOutlet(raw) || 'unknown';
      if (data.wrongProduction === true && String(data.wrongProductionNote || '').startsWith('Cross-market: London outlet')) {
        row(id).stillFlagged++; stillFlagged++;
      } else if (RELEASE_STAMPS.some((s) => String(data.wrongProductionAutoCleared || '').startsWith(s))
          && (!since || String(data.wrongProductionAutoClearedAt || '') >= since)) {
        row(id).released++; released++;
      }
    }
  }
  const rows = Object.entries(byOutlet)
    .map(([id, r]) => ({ id, region: (registry.outlets[id] || {}).region || null,
      isDualMarket: !!(registry.outlets[id] || {}).isDualMarket, ...r }))
    .sort((a, b) => (b.stillFlagged + b.released) - (a.stillFlagged + a.released));
  const summary = { since: since || null, stillFlagged, released, outlets: rows };
  if (asJson) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`NYC-show reviews still flagged "Cross-market: London outlet": ${stillFlagged}`);
  console.log(`NYC-show reviews released by the reverse self-heal${since ? ` since ${since}` : ''}: ${released}`);
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(32)} region=${String(r.region).padEnd(8)} dual=${r.isDualMarket ? 'y' : 'n'}  flagged=${r.stillFlagged}  released=${r.released}`);
  }
}

main();
