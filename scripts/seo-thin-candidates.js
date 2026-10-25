#!/usr/bin/env node
/**
 * Report-only (BRO-5969): lists the pages the thin rules WOULD noindex if
 * SEO_THIN_NOINDEX=1 and writes counts to data/audit/seo-thin-candidates.json.
 * Uses data/shows.json status and per-show review counts from reviews.json
 * (an approximation of the page's criticScore.reviewCount).
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { isThinClosedShow, hasSearchLanding, loadSearchLandings, hasGscImpressions, loadGscImpressions } = require('./lib/seo-indexability');

const root = path.join(__dirname, '..');
const shows = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8')).shows || [];
const reviews = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reviews.json'), 'utf8'));
const counts = {};
for (const r of Array.isArray(reviews) ? reviews : Object.values(reviews.reviews || reviews)) {
  const id = r && (r.showId || r.show_id);
  if (id) counts[id] = (counts[id] || 0) + 1;
}
const landings = loadSearchLandings();
const gsc = loadGscImpressions();
const candidates = shows
  .filter(s => isThinClosedShow({ status: s.status, reviewCount: counts[s.id] || 0, hasSearchLanding: hasSearchLanding(`/show/${s.slug || s.id}`, landings), hasGscImpressions: hasGscImpressions(`/show/${s.slug || s.id}`, gsc) }, true))
  .map(s => s.slug || s.id).sort();
const out = { generated: new Date().toISOString().slice(0, 10), rule: 'closed, 0 reviews, 0 search landings, 0 GSC impressions (90d)', landingsLoaded: !!landings, gscLoaded: !!gsc, shows: { total: shows.length, thinCandidates: candidates.length, slugs: candidates } };
fs.mkdirSync(path.join(root, 'data', 'audit'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'audit', 'seo-thin-candidates.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`thin show candidates: ${candidates.length} of ${shows.length} (landings loaded: ${!!landings}, gsc loaded: ${!!gsc})`);
