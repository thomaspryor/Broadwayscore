#!/usr/bin/env node
/**
 * Final report: every show added during this OB discovery work + their
 * scores + review counts. Run after all gather batches + LLM scoring complete.
 */
const fs = require('fs');
const path = require('path');

const TIER_W = { 1: 1.0, 2: 0.75, 3: 0.35 };

const reviews = JSON.parse(fs.readFileSync('/Users/tompryor/broadway-scorecard-data/reviews.json', 'utf8'));
const shows = JSON.parse(fs.readFileSync('/Users/tompryor/broadway-scorecard-data/shows.json', 'utf8'));
const registry = JSON.parse(fs.readFileSync('/Users/tompryor/Broadwayscore/data/outlet-registry.json', 'utf8'));
const tierByOutlet = {};
for (const [id, o] of Object.entries(registry.outlets)) tierByOutlet[id] = o.tier;

// All shows added during this session (the ~22 originally promoted + the 4 user-requested + the 4 Tier A)
const SESSION_IDS = [
  // Sprint 1+2 — 15 venue-discovered (the ones we kept after cleanup)
  'lets-love-off-broadway-2026',
  'msblackforpresident-off-broadway-2026',
  'king-of-the-yees-off-broadway-2026',
  'miles-for-mary-off-broadway-2026',
  'angela-s-mixtape-off-broadway-2026',
  'the-comeuppance-off-broadway-2026',
  'sunset-baby-off-broadway-2026',
  'orlando-off-broadway-2026',
  'three-houses-off-broadway-2026',
  'bad-krey-l-off-broadway-2026',
  'grangeville-off-broadway-2026',
  'eurydice-off-broadway-2026',
  'oratorio-for-living-things-off-broadway-2026',
  'uncensored-no-need-to-overthink-it-off-broadway-2026',
  'caroline-off-broadway-2026',
  // Tier A canonicalized (already existed but now grouped by canonical venue)
  'the-potluck-off-broadway-2026',
  'bocking-off-broadway-2026',
  'jackals-off-broadway-2026',
  'the-loved-ones-off-broadway-2026',
  // 4 user-requested
  'all-nighter-off-broadway-2024',
  'trophy-boys-off-broadway-2024',
  'the-lonely-few-off-broadway-2024',
  'shit-meet-fan-off-broadway-2024',
];

const byShow = {};
for (const r of reviews.reviews) (byShow[r.showId] = byShow[r.showId] || []).push(r);

function bucketFromScore(s) {
  if (s == null) return '—';
  if (s >= 85) return 'must-see';
  if (s >= 70) return 'recommended';
  if (s >= 55) return 'mixed';
  if (s >= 40) return 'tepid';
  return 'skip';
}

const sections = {
  'Atlantic Theater':   [],
  'Vineyard Theatre':   [],
  'Signature Theatre':  [],
  'MCC Theater':        [],
  'Soho Rep':           [],
  'The New Group':      [],
  'Irish Repertory Theatre': [],
  "Audible's Minetta Lane Theatre": [],
  'Other':              [],
};

for (const id of SESSION_IDS) {
  const show = shows.shows.find(s => s.id === id);
  if (!show) { console.error('MISSING:', id); continue; }
  const arr = byShow[id] || [];
  // Attach tier from outlet-registry
  for (const r of arr) r.tier = r.tier || tierByOutlet[r.outletId];
  const scored = arr.filter(r => typeof r.assignedScore === 'number');
  const t1 = scored.filter(r => r.tier === 1);
  const t2 = scored.filter(r => r.tier === 2);
  const t3 = scored.filter(r => r.tier === 3);
  let num = 0, den = 0;
  for (const r of scored) { const w = TIER_W[r.tier] || 0; num += w * r.assignedScore; den += w; }
  const composite = den > 0 ? Math.round(num / den) : null;
  const row = {
    id, title: show.title, venue: show.venue, status: show.status,
    openingDate: show.openingDate,
    files: arr.length, scored: scored.length,
    t1Count: t1.length, t2Count: t2.length, t3Count: t3.length,
    t1Outlets: [...new Set(t1.map(r => r.outletId))].sort().slice(0,6),
    t2Outlets: [...new Set(t2.map(r => r.outletId))].sort().slice(0,6),
    composite,
    bucket: bucketFromScore(composite),
  };
  const sec = sections[show.venue] ? show.venue : 'Other';
  sections[sec].push(row);
}

// Print report
console.log('# OB Discovery Expansion — Final Report');
console.log('Generated:', new Date().toISOString());
console.log('');
let totalShows = 0, totalScored = 0, totalReviews = 0;
for (const [venue, rows] of Object.entries(sections)) {
  if (rows.length === 0) continue;
  console.log('## ' + venue + ' (' + rows.length + ' shows)');
  console.log('');
  console.log('| Show | Status | Open | Reviews | Scored | T1/T2/T3 | Composite | Bucket |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    totalShows++; totalScored += (r.composite != null ? 1 : 0); totalReviews += r.scored;
    const t1note = r.t1Outlets.length > 0 ? ' (' + r.t1Outlets.join(',') + ')' : '';
    console.log(`| ${r.title} | ${r.status} | ${r.openingDate || '—'} | ${r.files} | ${r.scored} | ${r.t1Count}/${r.t2Count}/${r.t3Count}${t1note} | ${r.composite ?? '—'} | ${r.bucket} |`);
  }
  console.log('');
}
console.log('---');
console.log(`TOTAL: ${totalShows} shows | ${totalScored} with composite scores | ${totalReviews} scored reviews across all shows`);
