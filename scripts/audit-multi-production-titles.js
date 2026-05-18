#!/usr/bin/env node
/**
 * Audit shows.json for same-title collisions across productions.
 *
 * Output: data/audit/multi-production-titles.json keyed by normalizeTitle()
 * output → array of {showId, openingDate, market, venue, status}, restricted
 * to normalized titles shared by 2+ shows. Fixture corpus for the same-title
 * disambiguation sprint.
 */

const fs = require('fs');
const path = require('path');
const { normalizeTitle } = require('./lib/title-match.js');

const SHOWS = require('../data/shows.json').shows;
const OUT_DIR = path.join(__dirname, '..', 'data', 'audit');
const OUT_PATH = path.join(OUT_DIR, 'multi-production-titles.json');

const byNorm = {};
for (const s of SHOWS) {
  if (!s.title) continue;
  const n = normalizeTitle(s.title);
  if (!n) continue;
  (byNorm[n] ||= []).push({
    showId: s.id,
    openingDate: s.openingDate || null,
    market: s.market || null,
    venue: s.venue || null,
    status: s.status || null,
  });
}

const collisions = Object.fromEntries(
  Object.entries(byNorm).filter(([, arr]) => arr.length >= 2)
);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(collisions, null, 2) + '\n');

const groups = Object.entries(collisions);
const totalShows = groups.reduce((n, [, arr]) => n + arr.length, 0);
const top = groups.sort((a, b) => b[1].length - a[1].length).slice(0, 5);
console.log(`collision groups: ${groups.length}  shows in collisions: ${totalShows}`);
console.log('top 5:');
for (const [t, arr] of top) console.log(`  ${t} (${arr.length}): ${arr.map(s => s.showId).join(', ')}`);
