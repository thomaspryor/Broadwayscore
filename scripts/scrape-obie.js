#!/usr/bin/env node
/**
 * Scrape Obie Award (notable) winners from Wikipedia's main Obie_Award article.
 *
 * IMPORTANT LIMITATION: Wikipedia does not have per-category Obie Award pages
 * (unlike Drama Desk / OCC / Drama League). The Obie_Award article has a
 * "Notable winners" section with Year | Recipients tables (2000s, 2010s).
 * Each row is "Person (Category - Show Title); ..." — individual performance
 * citations, NOT a complete nominees list.
 *
 * As a result, obie.json contains WINNERS ONLY (no nominatedFor), and only
 * for shows mentioned in the notable-winners tables. Complete OBIE data would
 * require a separate archive source (Village Voice archive is offline).
 *
 * Categories emitted: Best New American Play, Best New Musical, Best Direction,
 * Best Performance, Best Design, Best Playwriting, Special Citation
 *
 * Usage:
 *   node scripts/scrape-obie.js              # diff vs baseline
 *   node scripts/scrape-obie.js --write      # write data/precursors/obie.json
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { writePrecursorJson, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');
const { assertTableSchema, TableSchemaError } = require('./lib/table-schema-assertion');

const PAGE = 'Obie_Award';
const USER_AGENT = 'BroadwayScorecardBot/1.0 (broadway-scorecard project; precursor-awards-scraper)';

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=2000').split('=')[1],
  10,
);
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

// Map raw category text → canonical obie.json category key.
// Obie Award category names varied year-to-year; these patterns catch the main variants.
function canonicalizeCategory(raw) {
  const c = (raw || '').toLowerCase();
  if (/best new american (play|theater|theatre)|playwriting award|playwright/.test(c)) return 'Best New American Play';
  if (/musical theatre|best new musical|best new american theatre work/.test(c)) return 'Best New Musical';
  if (/directing award|direction award/.test(c)) return 'Best Direction';
  if (/\bperformance award\b|\bperformance\b/.test(c)) return 'Best Performance';
  if (/design award|lighting design|set design|scenic design|costume design|sound design/.test(c)) return 'Best Design';
  if (/special citation|special achievement/.test(c)) return 'Special Citation';
  if (/sustained excellence/.test(c)) return null; // individual career award — no show
  if (/lifetime achievement|ross wetzsteon/.test(c)) return null;
  if (/grant|fellowship|obie/.test(c)) return null;
  return 'Special Citation'; // catch-all for unknown non-null
}

function cleanTitle(raw) {
  if (!raw) return null;
  const t = raw.trim()
    .replace(/\s*\[\d+\]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > 1 ? t : null;
}

/**
 * Parse a recipient cell like:
 *   "Sam Gold (Directing Award - Circle Mirror Transformation, The Alien);
 *    Reed Birney (Performance Award - Circle Mirror Transformation)"
 * Returns [{category, show}] where show may be null.
 */
function parseRecipients(text) {
  const results = [];
  // Split on semicolons that are NOT inside parentheses
  const parts = text.split(/;\s*/);
  for (const part of parts) {
    const m = part.match(/\(([^)]+)\)\s*$/);
    if (!m) continue;
    const inner = m[1]; // "Directing Award - Circle Mirror Transformation, The Alien"
    const dashIdx = inner.indexOf(' - ');
    if (dashIdx < 0) {
      // No dash → category-only, no show title
      const cat = canonicalizeCategory(inner);
      if (cat) results.push({ category: cat, show: null });
      continue;
    }
    const catRaw = inner.slice(0, dashIdx).trim();
    const showRaw = inner.slice(dashIdx + 3).trim();
    const category = canonicalizeCategory(catRaw);
    if (!category) continue;
    // showRaw may contain multiple show titles separated by commas: "Circle Mirror Transformation, The Alien"
    // Heuristic: if comma is present, take the first title (the primary production).
    const showTitle = cleanTitle(showRaw.split(/,\s+(?=[A-Z])/)[0]);
    if (showTitle) results.push({ category, show: showTitle });
  }
  return results;
}

async function main() {
  const url = `https://en.wikipedia.org/wiki/${PAGE}`;
  process.stdout.write(`Fetching ${PAGE}... `);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  console.log(`${html.length} bytes`);

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Obie "Notable winners" tables: wikitable with Year | Recipients columns.
  // The article has 2 such tables (2000s and 2010s); a 3rd table (2020s) may exist.
  const result = {};
  const seenPerCatYear = {}; // deduplicate

  const tables = Array.from(doc.querySelectorAll('table.wikitable'));
  for (const t of tables) {
    const headerCells = Array.from(t.querySelectorAll('tr')[0]?.querySelectorAll('th, td') || [])
      .map((c) => (c.textContent || '').trim());

    // Identify AND schema-guard this table in one call (task #1331) — a prior
    // version derived minCells from indices found in this same headerCells
    // array, which is tautological (can never fail). Fixed expectedHeaders
    // here actually gates on the labels this table must carry.
    try {
      assertTableSchema([headerCells], { minCells: 2, expectedHeaders: ['Year', 'Recipient'] });
    } catch (err) {
      if (err instanceof TableSchemaError) continue; // not the table we want
      throw err;
    }

    const headers = headerCells.map((c) => c.toLowerCase());
    const yearIdx = headers.indexOf('year');
    const recIdx = headers.findIndex((h) => h.includes('recipient'));

    for (const row of t.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < Math.max(yearIdx, recIdx) + 1) continue;
      const yearMatch = (cells[yearIdx]?.textContent || '').trim().match(/^([12]\d{3})/);
      if (!yearMatch) continue;
      const year = parseInt(yearMatch[1], 10);
      if (year < MIN_YEAR) continue;

      const recipientText = (cells[recIdx]?.textContent || '').trim();
      const entries = parseRecipients(recipientText);

      for (const { category, show } of entries) {
        if (!show) continue;
        if (!result[category]) {
          result[category] = [];
          seenPerCatYear[category] = new Set();
        }
        const key = `${year}::${show.toLowerCase()}`;
        if (seenPerCatYear[category].has(key)) continue;
        seenPerCatYear[category].add(key);
        result[category].push({ year, winner: show });
      }
    }
  }

  for (const cat of Object.keys(result)) {
    result[cat].sort((a, b) => a.year - b.year);
  }

  const totalEntries = Object.values(result).reduce((s, arr) => s + arr.length, 0);
  console.log(`\nCategories: ${Object.keys(result).length}, total winner entries: ${totalEntries}`);
  for (const [cat, entries] of Object.entries(result)) {
    console.log(`  ${cat}: ${entries.length} entries`);
  }

  const fp = path.join(PRECURSORS_DIR, 'obie.json');
  if (fs.existsSync(fp)) {
    const baseline = JSON.parse(fs.readFileSync(fp, 'utf8')).data;
    console.log('\nDiff vs baseline:');
    for (const cat of Object.keys(result)) {
      const baseYears = new Set((baseline[cat] || []).map((e) => e.year));
      const newYears = new Set(result[cat].map((e) => e.year));
      const added = [...newYears].filter((y) => !baseYears.has(y)).sort();
      const removed = [...baseYears].filter((y) => !newYears.has(y)).sort();
      console.log(`  ${cat}: +${added.join(',') || '∅'} / -${removed.join(',') || '∅'}`);
    }
  }

  const out = writePrecursorJson('obie', result, {
    force: FORCE,
    dryRun: !WRITE,
    meta: { sourcePage: PAGE, minYear: MIN_YEAR, note: 'Notable winners only (no nominees) — Wikipedia does not have per-category Obie Award pages. See script header for full limitation notes.' },
  });
  console.log(out.written
    ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})`
    : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
