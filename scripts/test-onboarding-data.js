#!/usr/bin/env node
/**
 * Guards for the quiz-onboarding data files (BRO-6579): genre sidecar and the
 * generated cities/hits. Reads the real committed files; invents nothing.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const GENRES = ['comedy', 'drama', 'thriller', 'romance', 'classic-musical', 'jukebox', 'family', 'concert', 'opera', 'dance'];

let failed = 0;
const assert = (c, m) => { if (c) console.log(`  ✅ ${m}`); else { console.error(`  ❌ FAIL: ${m}`); failed++; } };
// BRO-6925: genre coverage feeds the mobile feed's `gn`, not the city or hit lists, so a coverage
// shortfall must never block publishing them. Advisory unless --strict-genres (tag-genres.js heals it).
const STRICT_GENRES = process.argv.includes('--strict-genres');
const genreAssert = (c, m) => { if (c || STRICT_GENRES) assert(c, m); else console.warn(`::warning::genre coverage (advisory, BRO-6925): ${m}`); };

const mobile = read('public/data/mobile-shows.json').shows;
const ids = new Set(mobile.map(s => s.id));

const tags = read('src/config/genre-tags.json');
const entries = Object.entries(tags);
assert(entries.every(([, v]) => Array.isArray(v) && v.length <= 3 && v.every(g => GENRES.includes(g))), 'every tag is a known genre, max 3 per show');
const live = mobile.filter(s => ['open', 'previews', 'upcoming'].includes(s.st) && s.syn);
const covered = live.filter(s => s.id in tags).length;
genreAssert(covered / live.length >= 0.9, `>=90% of live shows with a synopsis are tagged (${covered}/${live.length})`);
const empty = entries.filter(([, v]) => v.length === 0).length;
genreAssert(empty / entries.length < 0.1, `<10% of tagged shows have no genre (${empty}/${entries.length})`);

const { cities } = read('public/data/onboarding-cities.json');
assert(cities.some(c => c.id === 'nyc') && cities.some(c => c.id === 'london'), 'nyc and london present');
assert(new Set(cities.map(c => c.id)).size === cities.length, 'city ids are unique');
const chi = cities.filter(c => /^Chicago\b/.test(c.name));
assert(chi.length === 1 && chi[0].tag === 'Local shows + tours', 'exactly one Chicago, tagged Local shows + tours');
assert(cities.filter(c => c.kind === 'tour').every(c => c.tag), 'tour cities carry a tag');

const { hits, fallback, minCityHits, want = {} } = read('public/data/onboarding-hits.json');
// Touring-city lists name tour ids, which the mobile feed leaves out; they must be real scheduled tours (BRO-6734).
const tourIds = new Set(Object.keys(read('data/tour-schedules.json').tours));
const cityKind = new Map(cities.map(c => [c.id, c.kind]));
for (const city of Object.keys(hits)) {
  const rows = hits[city] || [];
  const home = city === 'nyc' || city === 'london';
  const touring = cityKind.get(city) === 'tour';
  assert(rows.length >= (home ? 10 : touring ? 8 : minCityHits), `${city}: enough hits (${rows.length})`);
  assert(rows.every(r => (ids.has(r.showId) || tourIds.has(r.showId)) && r.poster && r.productions.length >= 1), `${city}: every hit maps to a real show or tour with a poster and a production`);
  if (touring) {
    // No touring-city list may hand out a New York production (the BRO-6734 bug).
    const nycOnly = rows.filter(r => { const m = mobile.find(s => s.id === r.showId); return m && (m.cat === undefined || m.cat === 'broadway' || m.cat === 'off-broadway'); });
    assert(nycOnly.length === 0, `${city}: no New York production in the Seen list (${nycOnly.map(r => r.showId).join(', ')})`);
    continue;
  }
  assert(rows.every((r, i) => i === 0 || rows[i - 1].days >= r.days), `${city}: sorted by days played`);
  if (!home) assert(rows.every(r => r.productions.every(p => p.closed)), `${city}: regional runs all have a closing date (no stale open rows counted to today)`);
}
for (const [city, rows] of Object.entries(want)) {
  assert(cityKind.get(city) === 'tour', `want: ${city} is a touring city`);
  assert(rows.every(r => (ids.has(r.showId) || tourIds.has(r.showId)) && r.poster && r.title), `want ${city}: every row is a real show or tour with a poster`);
  assert(rows.every(r => !mobile.some(s => s.id === r.showId && (s.cat === undefined || s.cat === 'broadway'))), `want ${city}: no Broadway production`);
}
// Tours added after the last audit-tour-art.js run fall back to Broadway art (BRO-6914 item 4): flag them.
try {
  const audited = read('src/config/onboarding-tour-art.json'), tourDefs = read('data/shows.json').shows.filter(x => x.category === 'tour');
  const unaudited = tourDefs.filter(x => !(x.id in audited) && x.status !== 'closed').map(x => x.id);
  if (unaudited.length) console.warn(`::warning::tours not yet art-audited (run node scripts/audit-tour-art.js): ${unaudited.join(', ')}`);
} catch { /* shows.json is gitignored and may be absent */ }
const tourCities = cities.filter(c => c.kind === 'tour');
assert(tourCities.every(c => typeof c.stops === 'number'), 'every touring city carries its stop count');
assert(tourCities.filter(c => hits[c.id]).length >= tourCities.length * 0.9, '>=90% of touring cities have their own Seen list');

// Every city either has its own list or names the home list it falls back to (BRO-6647); no city is left without one.
const own = new Set(Object.keys(hits));
const lacking = cities.filter(c => c.kind !== 'home' && (c.kind === 'uk-regional' || /^Chicago\b/.test(c.name)));
assert(lacking.every(c => own.has(c.id) || (fallback[c.id] && hits[fallback[c.id]])), 'Chicago and every UK regional city has its own list or a valid fallback');
assert(Object.keys(fallback).every(id => !own.has(id) && cities.some(c => c.id === id)), 'fallback only names cities without their own list');
const chiId = chi[0].id;
assert(own.has(chiId) || fallback[chiId] === 'nyc', 'Chicago has its own list or falls back to nyc');
assert(typeof minCityHits === 'number' && minCityHits >= 3, 'threshold recorded in the file');

if (failed) process.exit(1);
console.log('onboarding data OK');
