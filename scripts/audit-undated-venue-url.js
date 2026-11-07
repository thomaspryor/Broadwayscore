#!/usr/bin/env node
/**
 * BRO-7086: undated included reviews whose URL slug names a venue the show
 * never played. Undated rows skip date-guard / collected-before-previews, and
 * market-routing only compares URL venues against sibling shows, so these
 * stay on the wrong production. Detector: scripts/lib/undated-venue-url.js.
 *
 * Usage:
 *   node scripts/audit-undated-venue-url.js                # report
 *   node scripts/audit-undated-venue-url.js --json
 *   node scripts/audit-undated-venue-url.js --max=N        # exit 1 if hits > N
 *
 * Hits already settled as legitimate live in data/undated-venue-url-legit.json.
 * Read-only. Fixes go through a pending-fix plan (CLOUD.md "Fixing private data").
 */
const fs = require('fs');
const path = require('path');
const { detectUndatedVenueUrl, buildVenueIndex } = require('./lib/undated-venue-url');
const { parseMaxArg } = require('./lib/parse-max-arg.js');

const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');
const HAS_MAX = ARGV.some(a => a === '--max' || a.startsWith('--max='));
const DATA = path.join(__dirname, '..', 'data');

function loadLegit() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'undated-venue-url-legit.json'), 'utf8')).entries || []; } catch (_) { return []; }
}

function run({ reviews, shows, legit = loadLegit() }) {
  const settled = (showId, venues) => venues.every(v => legit.some(l => l.showId === showId && l.venue === v));
  const byId = new Map(shows.map(s => [s.id, s]));
  const idx = buildVenueIndex(shows);
  let scanned = 0;
  const hits = [];
  for (const r of reviews) {
    if (!r || !r.url || r.publishDate) continue;
    const show = byId.get(r.showId);
    if (!show) continue;
    scanned++;
    const d = detectUndatedVenueUrl(r, show, idx);
    if (d && !settled(r.showId, d.venues)) hits.push({ showId: r.showId, showVenue: show.venue || null, outletId: r.outletId || null, criticName: r.criticName || null, url: r.url, namedVenues: d.venues });
  }
  return { scanned, hits };
}

function main() {
  const rv = JSON.parse(fs.readFileSync(path.join(DATA, 'reviews.json'), 'utf8'));
  const sh = JSON.parse(fs.readFileSync(path.join(DATA, 'shows.json'), 'utf8'));
  const { scanned, hits } = run({ reviews: Array.isArray(rv) ? rv : rv.reviews || [], shows: Array.isArray(sh) ? sh : sh.shows || [] });
  if (scanned === 0) { console.error('✗ scanned 0 undated rows: data/reviews.json or shows.json missing/empty'); process.exit(2); }
  if (JSON_OUT) console.log(JSON.stringify({ scanned, flagged: hits.length, hits }, null, 2));
  else {
    console.log(`Undated venue-in-URL audit: scanned ${scanned} undated rows with a URL, ${hits.length} name a foreign venue`);
    for (const h of hits) console.log(`  ${h.showId} [${h.showVenue}] ${h.outletId} -> ${h.namedVenues.join('|')} | ${h.url.slice(0, 110)}`);
  }
  if (HAS_MAX) {
    const max = parseMaxArg(ARGV, { scriptName: 'audit-undated-venue-url.js' });
    if (hits.length > max) { console.error(`\n✗ ${hits.length} undated rows name a foreign venue > baseline ${max}`); process.exit(1); }
  }
}

if (require.main === module) main();
module.exports = { run };
