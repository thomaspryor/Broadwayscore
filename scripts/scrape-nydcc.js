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

const PAGE = 'New_York_Drama_Critics%27_Circle';
const USER_AGENT = 'BroadwayScorecardBot/1.0 (broadway-scorecard project; precursor-awards-scraper)';

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=2014').split('=')[1],
  10,
);
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

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

function parseWinnersTable(table) {
  // Each row is one ceremony: first cell year, later cell italic title.
  const winners = [];
  for (const row of table.querySelectorAll('tr')) {
    const cells = Array.from(row.children).filter((el) => el.tagName === 'TD' || el.tagName === 'TH');
    if (cells.length < 2) continue;
    const yearMatch = (cells[0].textContent || '').match(/([12]\d{3})/);
    if (!yearMatch) continue;
    const year = parseInt(yearMatch[1], 10);
    // Find the first italic title across remaining cells. NYDCC tables
    // sometimes split title/author/etc. across multiple columns.
    let title = null;
    for (const c of cells.slice(1)) {
      const i = c.querySelector('i');
      if (i && i.textContent && i.textContent.trim().length > 1) {
        title = i.textContent.trim().replace(/\s*\((?:musical|play|opera)\)\s*$/i, '').replace(/[‡†]+$/, '').trim();
        break;
      }
    }
    if (!title) continue;
    winners.push({ year, winner: title });
  }
  return winners;
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

  // Walk headings (h2/h3/h4) in document order; for each heading that maps
  // to one of our categories, scan forward to the next sibling .wikitable.
  const result = { 'Best Play': [], 'Best Foreign Play': [], 'Best Musical': [] };
  const seenForCategory = new Set();

  const walker = doc.querySelectorAll('h2, h3, h4, table.wikitable');
  let pendingCategory = null;
  for (const node of walker) {
    if (node.tagName === 'TABLE') {
      if (!pendingCategory) continue;
      if (seenForCategory.has(pendingCategory)) continue;
      const winners = parseWinnersTable(node)
        .filter((w) => w.year >= MIN_YEAR);
      if (winners.length > 0) {
        // De-dupe by year (later years should never overwrite earlier — first wins).
        const have = new Set(result[pendingCategory].map((e) => e.year));
        for (const w of winners) if (!have.has(w.year)) { result[pendingCategory].push(w); have.add(w.year); }
        result[pendingCategory].sort((a, b) => a.year - b.year);
        seenForCategory.add(pendingCategory);
        pendingCategory = null;
      }
      continue;
    }
    // Heading
    const text = (node.textContent || '').trim();
    const cat = categoryForHeading(text);
    if (cat && !seenForCategory.has(cat)) {
      pendingCategory = cat;
    }
  }

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
