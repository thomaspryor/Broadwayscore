#!/usr/bin/env node
/**
 * Scrape New York Drama Critics' Circle winners from Wikipedia.
 *
 * NYDCC doesn't publish nominee lists, only annual winners across three
 * categories: Best Play, Best Musical, Best Foreign Play. Some years skip
 * a category (Best Musical was not awarded in 2018, 2021, 2023, 2026).
 *
 * Source: https://en.wikipedia.org/wiki/New_York_Drama_Critics%27_Circle —
 * one page with three section-anchored wikitables.
 *
 * Usage:
 *   node scripts/scrape-nydcc.js              # diff vs baseline
 *   node scripts/scrape-nydcc.js --write      # commit data/precursors/nydcc.json
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { writePrecursorJson, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');
const { assertTableSchema, TableSchemaError } = require('./lib/table-schema-assertion');

const PAGE = 'New_York_Drama_Critics%27_Circle';
const USER_AGENT = 'BroadwayScorecardBot/1.0 (broadway-scorecard project; precursor-awards-scraper)';

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=2014').split('=')[1],
  10,
);
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

// Years the Circle voted to give no award in a category. Wikipedia omits
// these years from the list, so we inject noAward:true entries explicitly.
// Verified against Wikipedia + NYDCC annual reports.
const KNOWN_NO_AWARD_YEARS = {
  'Best Musical': [2018, 2021, 2023],
  'Best Foreign Play': [],
  'Best Play': [2021],
};

// Map Wikipedia section heading text → output category name. Match is
// substring + case-insensitive so heading variants like "Best Play (1936–"
// still resolve.
const SECTION_TO_CATEGORY = [
  { match: /best american play|best play(?:\s*\()?/i, category: 'Best Play' },
  { match: /best foreign play/i, category: 'Best Foreign Play' },
  { match: /best musical/i, category: 'Best Musical' },
];

function categoryForHeading(text) {
  const norm = (text || '').toLowerCase();
  for (const { match, category } of SECTION_TO_CATEGORY) {
    if (match.test(norm)) return category;
  }
  return null;
}

function cleanTitle(raw) {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/\s*\((?:musical|play|opera|ballet)\)\s*$/i, '')
    .replace(/\s*[‡†*≠]+\s*$/, '')
    .replace(/\s*\[\d+\]\s*$/, '')
    .trim();
  return cleaned.length > 1 ? cleaned : null;
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

  // Wikipedia's NYDCCC article uses a combined wikitable for pre-2010 winners
  // and bulleted lists (<ul><li>YEAR: Title – Author</li>...) under H3 section
  // headings for 2010+ winners. The per-category H3 sections are: Best Play,
  // Best American Play, Best Musical, Best Foreign Play. Walk H3/UL in document
  // order, take the FIRST year-prefixed UL after each matching heading.

  const result = { 'Best Play': [], 'Best Foreign Play': [], 'Best Musical': [] };
  const seenByCategory = { 'Best Play': new Set(), 'Best Foreign Play': new Set(), 'Best Musical': new Set() };
  const populatedFromUl = new Set();

  const headingOrUl = doc.querySelectorAll('h3, ul');
  let currentCat = null;
  for (const node of headingOrUl) {
    if (node.tagName === 'H3') {
      const txt = (node.textContent || '').trim();
      currentCat = categoryForHeading(txt);
    } else if (node.tagName === 'UL' && currentCat && !populatedFromUl.has(currentCat)) {
      // Only take the FIRST year-prefixed UL per section — subsequent ULs
      // contain references, related links, or runners-up.
      let added = 0;
      for (const li of node.querySelectorAll('li')) {
        const liText = (li.textContent || '').trim();
        const m = liText.match(/^([12]\d{3}):\s*(.+)/s);
        if (!m) continue;
        const year = parseInt(m[1], 10);
        if (year < MIN_YEAR) continue;
        // Title is up to ' – ' / ' - ' (author separator).
        let titleRaw = m[2];
        const splitIdx = titleRaw.search(/\s[–-]\s/);
        if (splitIdx > 0) titleRaw = titleRaw.slice(0, splitIdx);
        // Prefer <i> for the title if present (cleaner — no author suffix).
        const italic = li.querySelector('i');
        const title = cleanTitle(italic ? italic.textContent : titleRaw);
        if (!title) continue;
        if (seenByCategory[currentCat].has(year)) continue;
        seenByCategory[currentCat].add(year);
        // Detect "no award given" marker (Wikipedia uses "No award given" or
        // "Not awarded" as the show title for years the Circle voted to abstain).
        if (/^no award|^not awarded/i.test(title)) {
          result[currentCat].push({ year, noAward: true });
        } else {
          result[currentCat].push({ year, winner: title });
        }
        added++;
      }
      if (added > 0) populatedFromUl.add(currentCat);
    }
  }

  // Fallback: also parse the pre-2010 combined wikitable (columns Year, Show,
  // Author(s), Nominated for) for any years not yet captured. The UL data
  // covers 2010+; the table covers 1936-2009. With MIN_YEAR=2014 the table
  // pass is a no-op, but the code path stays here for future use.
  const tables = Array.from(doc.querySelectorAll('table.wikitable'));
  for (const t of tables) {
    const headerCells = Array.from(t.querySelectorAll('tr')[0]?.children || [])
      .map((c) => (c.textContent || '').trim());
    const headerText = headerCells.map((c) => c.toLowerCase()).join('|');
    if (!/nominated for|category/i.test(headerText) || !/year/i.test(headerText)) continue;
    // Found the right table by header content — assert its column count hasn't
    // drifted before trusting the fixed cells[0]/[1]/[3] indices below (task #1331).
    try {
      assertTableSchema([headerCells], { minCells: 4 });
    } catch (err) {
      if (err instanceof TableSchemaError) {
        console.error(`::error::scrape-nydcc: ${err.message}`);
        continue;
      }
      throw err;
    }
    for (const row of t.querySelectorAll('tr')) {
      const cells = Array.from(row.children).filter((el) => el.tagName === 'TD' || el.tagName === 'TH');
      if (cells.length < 4) continue;
      const yearMatch = (cells[0].textContent || '').trim().match(/^([12]\d{3})/);
      if (!yearMatch) continue;
      const year = parseInt(yearMatch[1], 10);
      if (year < MIN_YEAR) continue;
      const italic = cells[1].querySelector('i');
      const title = cleanTitle(italic ? italic.textContent : cells[1].textContent);
      if (!title) continue;
      const cat = categoryForHeading((cells[3].textContent || '').trim());
      if (!cat || !result[cat]) continue;
      if (seenByCategory[cat].has(year)) continue;
      seenByCategory[cat].add(year);
      if (/^no award|^not awarded/i.test(title)) {
        result[cat].push({ year, noAward: true });
      } else {
        result[cat].push({ year, winner: title });
      }
    }
    break;
  }

  // Inject known noAward years (Wikipedia omits them from the winner list).
  for (const [cat, years] of Object.entries(KNOWN_NO_AWARD_YEARS)) {
    if (!result[cat]) continue;
    for (const year of years) {
      if (year < MIN_YEAR) continue;
      if (!seenByCategory[cat]?.has(year)) {
        result[cat].push({ year, noAward: true });
        seenByCategory[cat]?.add(year);
      }
    }
  }

  for (const cat of Object.keys(result)) result[cat].sort((a, b) => a.year - b.year);

  for (const [cat, entries] of Object.entries(result)) {
    console.log(`  ${cat}: ${entries.length} winners`);
  }

  const fp = path.join(PRECURSORS_DIR, 'nydcc.json');
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

  const out = writePrecursorJson('nydcc', result, {
    force: FORCE,
    dryRun: !WRITE,
    meta: { sourcePage: PAGE, minYear: MIN_YEAR },
  });
  console.log(out.written ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})` : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
