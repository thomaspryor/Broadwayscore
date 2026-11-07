#!/usr/bin/env node
/**
 * backfill-genre.js — one-time + re-runnable backfill of the `genre` field and
 * the off-west-end category for non-theatrical London shows (dance/magic/comedy/
 * cabaret/concert/circus). Mirrors what discover-new-shows.js now does for new
 * shows. See src/lib/genre.ts for the policy.
 *
 * For each West End / Off-West End show:
 *   1. If it has no `genre`, run the conservative classifier; set a non-theatrical
 *      genre only when a venue/title signal is unambiguous.
 *   2. If it has a non-theatrical genre but category 'west-end', flip category to
 *      'off-west-end' so market counts match where it renders (routing already
 *      keys off genre).
 *
 * Usage: node scripts/backfill-genre.js [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { classifyGenre, isNonTheatricalGenre, applyGenreCategoryOverride } = require('./lib/genre-classification');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-genre.js — one-time + re-runnable backfill of the 'genre' field and.

Usage:
  node scripts/backfill-genre.js [options]
  node scripts/backfill-genre.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const dryRun = process.argv.includes('--dry-run');

const data = loadShows();
const shows = data.shows;

let genreSet = 0;
let categoryFixed = 0;
const changes = [];

for (const show of shows) {
  if (show.category !== 'west-end' && show.category !== 'off-west-end') continue;

  if (!show.genre) {
    const g = classifyGenre(show);
    if (g && isNonTheatricalGenre(g)) {
      changes.push(`  genre: ${show.id} → ${g} (venue: ${show.venue})`);
      show.genre = g;
      genreSet++;
    }
  }

  const fixedCategory = applyGenreCategoryOverride(show.category, show.genre);
  if (fixedCategory !== show.category) {
    changes.push(`  category: ${show.id} (genre ${show.genre}) west-end → off-west-end`);
    show.category = fixedCategory;
    categoryFixed++;
  }
}

console.log(changes.join('\n') || '  (no changes)');
console.log(`\nGenre set: ${genreSet}, Category fixed: ${categoryFixed}`);

if (!dryRun && (genreSet > 0 || categoryFixed > 0)) {
  saveShows(data);
  console.log('Wrote shows.json');
} else if (dryRun) {
  console.log('(dry run — no changes written)');
}
