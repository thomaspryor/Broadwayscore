#!/usr/bin/env node
/**
 * Generate public/data/stats-canon.json — canonical Tony data for the
 * Show Stats ("My Scorecard") feature on iOS and web.
 *
 * Contents:
 *   - ceremonies: every Tony ceremony number + date (1947–present). These are
 *     the season boundaries for the stats scope pill: a theater season runs
 *     from the day after one ceremony through the day of the next
 *     (design-ios-show-stats.md §5.7).
 *   - bestMusical / bestPlay: show-level winners with title + poster so the
 *     canon checklists can render entries that predate mobile-shows.json.
 *
 * Sources: data/tony-ceremony-dates.json (checked-in, Wikipedia-derived,
 * cross-checked against src/lib/tony-cutoffs.ts), data/tony-nominations.json,
 * data/shows.json (title/poster join).
 *
 * Run: node scripts/generate-stats-canon.js
 * Wired into scripts/generate-mobile-artifacts.sh.
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const outputPath = path.join(__dirname, '../public/data/stats-canon.json');

const SCHEMA_VERSION = 1;
const WINNER_CATEGORIES = { 'Best Musical': 'bestMusical', 'Best Play': 'bestPlay' };

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
}

function main() {
  const ceremonies = loadJson('tony-ceremony-dates.json').ceremonies;
  const nominations = loadJson('tony-nominations.json').nominations;
  const showsRaw = loadJson('shows.json');
  const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
  const showsById = new Map(shows.map((s) => [s.id, s]));
  const ceremonyByNumber = new Map(ceremonies.map((c) => [c.ceremony, c]));

  // Ceremony table invariants (the season-boundary math depends on these)
  const seenYears = new Set();
  ceremonies.forEach((c, i) => {
    if (c.ceremony !== i + 1) throw new Error(`ceremonies not contiguous at index ${i}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date)) throw new Error(`bad date for ceremony ${c.ceremony}: ${c.date}`);
    if (i > 0 && c.date <= ceremonies[i - 1].date) throw new Error(`dates not increasing at ceremony ${c.ceremony}`);
    // One ceremony per calendar year — tony-cutoffs.ts derives ceremonyDate by year
    const year = c.date.slice(0, 4);
    if (seenYears.has(year)) throw new Error(`two ceremonies in ${year} — breaks year-keyed derivation in tony-cutoffs.ts`);
    seenYears.add(year);
  });

  const winners = { bestMusical: [], bestPlay: [] };
  for (const nom of nominations) {
    const key = WINNER_CATEGORIES[nom.category];
    if (!key || !nom.won || nom.name !== '(show-level)') continue;
    const show = showsById.get(nom.showId);
    if (!show) throw new Error(`winner ${nom.showId} (${nom.season} ${nom.category}) missing from shows.json`);
    if (!ceremonyByNumber.has(nom.ceremony)) throw new Error(`winner ${nom.showId} references unknown ceremony ${nom.ceremony}`);
    const entry = {
      ceremony: nom.ceremony,
      season: nom.season,
      id: nom.showId,
      t: show.title,
    };
    if (show.images?.poster) entry.img = show.images.poster;
    else if (show.images?.thumbnail) entry.img = show.images.thumbnail;
    winners[key].push(entry);
  }
  winners.bestMusical.sort((a, b) => a.ceremony - b.ceremony);
  winners.bestPlay.sort((a, b) => a.ceremony - b.ceremony);

  if (winners.bestMusical.length < 40 || winners.bestPlay.length < 40) {
    throw new Error(`suspiciously few winners: BM=${winners.bestMusical.length} BP=${winners.bestPlay.length}`);
  }

  const out = {
    _v: SCHEMA_VERSION,
    ceremonies,
    bestMusical: winners.bestMusical,
    bestPlay: winners.bestPlay,
  };
  fs.writeFileSync(outputPath, JSON.stringify(out) + '\n');
  const kb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(`✓ stats-canon.json: ${ceremonies.length} ceremonies, ${winners.bestMusical.length} Best Musical + ${winners.bestPlay.length} Best Play winners (${kb} KB)`);
}

main();
