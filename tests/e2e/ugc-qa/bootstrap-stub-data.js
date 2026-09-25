#!/usr/bin/env node
/**
 * Bootstrap gitignored data/*.json stubs for a cloud session without the
 * private core-data repo. Synthesizes shows.json from committed
 * public/data/mobile-shows.json; writes kitchen-sink empty stubs for the rest.
 * NEVER writes to tracked files.
 */
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const NOW = '2026-07-01T00:00:00.000Z';

// Guard: refuse to overwrite any git-tracked file
const { execSync } = require('child_process');
const tracked = new Set(
  execSync('git ls-files data', { cwd: ROOT }).toString().trim().split('\n')
);
function writeJson(rel, obj) {
  if (tracked.has(rel)) {
    console.log(`SKIP tracked: ${rel}`);
    return;
  }
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p)) {
    console.log(`exists, leaving: ${rel}`);
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
  console.log(`wrote ${rel}`);
}

// ---- shows.json from mobile-shows.json ----
const mobile = require(path.join(ROOT, 'public/data/mobile-shows.json'));
const WANT = new Set([
  // ids referenced by __dev-mock-data.ts
  'book-of-mormon-2011','cabaret-2024','chess-2025','death-becomes-her-2024',
  'gypsy-2024','hamilton-2015','les-miserables-west-end-1985',
  'merrily-we-roll-along-2023','oh-mary-2024','operation-mincemeat-2025',
  'ragtime-2025','rent-off-broadway-1996','smash-2025','sunset-boulevard-2024',
  'wicked-2003',
]);
// plus a handful of currently-open broadway shows for live show-page flows
const open = mobile.shows.filter(s => s.st === 'open' && !/west-end|off-broadway/.test(s.id)).slice(0, 8);
for (const s of open) WANT.add(s.id);

const cat = id => /west-end/.test(id) ? 'west-end' : /off-broadway/.test(id) ? 'off-broadway' : 'broadway';
const picked = mobile.shows.filter(s => WANT.has(s.id));
const missing = [...WANT].filter(id => !picked.some(s => s.id === id));
if (missing.length) console.log('not in mobile-shows (skipped):', missing.join(', '));

const shows = picked.map(s => ({
  id: s.id,
  title: s.t,
  slug: s.s,
  venue: s.v || 'Unknown Theatre',
  openingDate: s.od || '2024-01-01',
  closingDate: s.cd || null,
  status: s.st || 'open',
  type: s.ty || 'musical',
  category: cat(s.id),
  runtime: '2h 30m',
  intermissions: 1,
  images: s.img ? { thumbnail: s.img.th, poster: s.img.po } : undefined,
  synopsis: s.syn || '',
  tags: s.tg || [],
  creativeTeam: (s.ct || []).map(c => ({ name: c.n, role: c.r })),
  isRevival: (s.tg || []).includes('revival'),
}));
writeJson('data/shows.json', { _meta: { lastUpdated: NOW }, shows });

// ---- empty-but-shaped stubs ----
const stubs = {
  'data/reviews.json': { _meta: { lastUpdated: NOW }, reviews: [] },
  'data/audience.json': { _meta: { lastUpdated: NOW }, audience: [] },
  'data/buzz.json': { _meta: { lastUpdated: NOW }, threads: [] },
  'data/blog-reviews-for-scoring.json': { _meta: { lastUpdated: NOW }, reviews: [] },
  'data/awards.json': { _meta: { lastUpdated: NOW }, awards: [], shows: {}, seasons: {} },
  'data/tony-nominations.json': { _meta: { lastUpdated: NOW }, seasons: {}, nominations: [], shows: {} },
  'data/commercial.json': { _meta: { lastUpdated: NOW }, shows: {}, commercial: [] },
  'data/grosses.json': { _meta: { lastUpdated: NOW }, shows: {}, grosses: {} },
  'data/grosses-history.json': { _meta: { lastUpdated: NOW }, shows: {}, weeks: [] },
  'data/critic-consensus.json': { _meta: { lastUpdated: NOW }, shows: {}, consensus: {} },
  'data/audience-buzz.json': { _meta: { lastUpdated: NOW }, shows: {} },
  'data/cast-changes.json': { _meta: { lastUpdated: NOW }, shows: [] },
  'data/gold-lists-computed.json': { _meta: { lastUpdated: NOW }, lists: [], badges: {} },
  'data/related-shows.json': { _meta: { lastUpdated: NOW }, related: {}, shows: {} },
  'data/show-schedules.json': { _meta: { lastUpdated: NOW }, schedules: {}, shows: {} },
  'data/theater-metadata.json': { _meta: { lastUpdated: NOW }, theaters: {}, theatres: {} },
  'data/west-end-venues.json': [],
  'data/lottery-rush.json': { _meta: { lastUpdated: NOW }, shows: {}, lotteries: [] },
  'data/todaytix-showtimes.json': { _meta: { lastUpdated: NOW }, shows: {}, showIds: [] },
  'data/curated-historical-shows.json': { _meta: { lastUpdated: NOW }, shows: [] },
  'data/show-score-urls.json': { _meta: { lastUpdated: NOW }, urls: {}, shows: {} },
  'data/nyt-critics-picks.json': { urls: [] },
  'data/actor-images.json': { _meta: { lastUpdated: NOW }, images: {}, actors: {} },
  'data/fantasy-league.json': { _meta: { lastUpdated: NOW }, config: {}, entries: [] },
  'data/fantasy-scores.json': { _meta: { lastUpdated: NOW }, scores: {}, shows: {} },
  'data/tony-win-probabilities.json': { _meta: { lastUpdated: NOW }, categories: {}, probabilities: {} },
  'data/tony-polymarket-odds.json': { _meta: { lastUpdated: NOW }, markets: [], categories: {} },
  'data/tony-kalshi-odds.json': { _meta: { lastUpdated: NOW }, markets: [], categories: {} },
  'data/tony-loso-stats.json': { _meta: { lastUpdated: NOW }, stats: {}, shows: {} },
  'data/tony-critic-picks.json': { _meta: { lastUpdated: NOW }, picks: [], critics: {} },
  'data/tony-frozen-audience-grades.json': { _meta: { lastUpdated: NOW }, grades: {}, shows: {} },
  'data/analysis/gd-vs-broadwayscore.json': { _meta: { lastUpdated: NOW }, rows: [], shows: {} },
};
for (const [rel, obj] of Object.entries(stubs)) writeJson(rel, obj);
console.log('done');
