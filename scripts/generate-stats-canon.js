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

  // Ceremony number is DERIVED from the season label + ceremony dates, never
  // taken from tony-nominations.json: its ceremony field runs one too high for
  // post-COVID seasons (no 2020 ceremony; e.g. A Strange Loop's 2021-22 win is
  // tagged 76 there but happened at the 75th, 2022-06-12). Rule: a season
  // "A-B" is honored at the first ceremony dated on/after Jan 1 of its end
  // year — which also lands 2019-20 correctly on the 74th (held Sept 2021).
  const ceremonyForSeason = (season) => {
    const endYear = Number(season.slice(0, 4)) + 1;
    const hit = ceremonies.find((c) => c.date >= `${endYear}-01-01`);
    if (!hit) throw new Error(`no ceremony on/after ${endYear} for season ${season}`);
    return hit.ceremony;
  };

  const winners = { bestMusical: [], bestPlay: [] };
  for (const nom of nominations) {
    const key = WINNER_CATEGORIES[nom.category];
    if (!key || !nom.won || nom.name !== '(show-level)') continue;
    const show = showsById.get(nom.showId);
    if (!show) throw new Error(`winner ${nom.showId} (${nom.season} ${nom.category}) missing from shows.json`);
    const ceremony = ceremonyForSeason(nom.season);
    if (!ceremonyByNumber.has(ceremony)) throw new Error(`winner ${nom.showId} derived unknown ceremony ${ceremony}`);
    const entry = {
      ceremony,
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

  // Freshness guard: the newest ceremony that has already happened (date <= today)
  // must have a winner in both categories. Catches the case where tony-nominations.json
  // has rows for the latest season but nobody has backfilled won:true yet (#561).
  const todayStr = new Date().toISOString().slice(0, 10);
  const heldCeremonies = ceremonies.filter((c) => c.date <= todayStr);
  const newestHeld = heldCeremonies[heldCeremonies.length - 1];
  if (newestHeld) {
    const hasMusical = winners.bestMusical.some((w) => w.ceremony === newestHeld.ceremony);
    const hasPlay = winners.bestPlay.some((w) => w.ceremony === newestHeld.ceremony);
    if (!hasMusical || !hasPlay) {
      const missing = [!hasMusical && 'Best Musical', !hasPlay && 'Best Play'].filter(Boolean).join(' and ');
      throw new Error(
        `freshness guard: newest ceremony ${newestHeld.ceremony} (${newestHeld.date}) has already happened but is missing its ${missing} winner — backfill won:true for that season in data/tony-nominations.json`
      );
    }
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
