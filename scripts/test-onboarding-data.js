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

const mobile = read('public/data/mobile-shows.json').shows;
const ids = new Set(mobile.map(s => s.id));

const tags = read('src/config/genre-tags.json');
const entries = Object.entries(tags);
assert(entries.every(([, v]) => Array.isArray(v) && v.length <= 3 && v.every(g => GENRES.includes(g))), 'every tag is a known genre, max 3 per show');
const live = mobile.filter(s => ['open', 'previews', 'upcoming'].includes(s.st) && s.syn);
const covered = live.filter(s => s.id in tags).length;
assert(covered / live.length >= 0.9, `>=90% of live shows with a synopsis are tagged (${covered}/${live.length})`);
const empty = entries.filter(([, v]) => v.length === 0).length;
assert(empty / entries.length < 0.1, `<10% of tagged shows have no genre (${empty}/${entries.length})`);

const { cities } = read('public/data/onboarding-cities.json');
assert(cities.some(c => c.id === 'nyc') && cities.some(c => c.id === 'london'), 'nyc and london present');
assert(new Set(cities.map(c => c.id)).size === cities.length, 'city ids are unique');
const chi = cities.filter(c => /^Chicago\b/.test(c.name));
assert(chi.length === 1 && chi[0].tag === 'Local shows + tours', 'exactly one Chicago, tagged Local shows + tours');
assert(cities.filter(c => c.kind === 'tour').every(c => c.tag), 'tour cities carry a tag');

const { hits, fallback, minCityHits } = read('public/data/onboarding-hits.json');
for (const city of Object.keys(hits)) {
  const rows = hits[city] || [];
  const home = city === 'nyc' || city === 'london';
  assert(rows.length >= (home ? 10 : minCityHits), `${city}: enough hits (${rows.length}, min ${home ? 10 : minCityHits})`);
  assert(rows.every(r => ids.has(r.showId) && r.poster && r.productions.length >= 1), `${city}: every hit maps to a real show with a poster and a production`);
  assert(rows.every((r, i) => i === 0 || rows[i - 1].days >= r.days), `${city}: sorted by days played`);
}

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
