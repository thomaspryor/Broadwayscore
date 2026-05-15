#!/usr/bin/env node
/**
 * Scrape the Pulitzer Prize for Drama winners + finalists from Wikipedia.
 *
 * Single page (https://en.wikipedia.org/wiki/Pulitzer_Prize_for_Drama) holds a
 * master wikitable with one row per ceremony year, columns: Year | Winner |
 * Author | Finalists (italic titles, comma- or break-separated). The Pulitzer
 * site itself surfaces finalists only as flat text per year, so Wikipedia is
 * the highest-fidelity source.
 *
 * Special cases:
 *   - "No award" years (1917, 1942, etc.) are skipped.
 *   - The "Drama" category is the only one we care about — the page is dedicated
 *     to it so no filtering needed.
 *
 * Usage:
 *   node scripts/scrape-pulitzer.js              # diff vs baseline
 *   node scripts/scrape-pulitzer.js --write      # commit data/precursors/pulitzer.json
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { writePrecursorJson, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');

const PAGE = 'Pulitzer_Prize_for_Drama';
const USER_AGENT = 'BroadwayScorecardBot/1.0 (broadway-scorecard project; precursor-awards-scraper)';

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=2014').split('=')[1],
  10,
);
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

function cellTitles(cell) {
  const out = [];
  for (const i of cell.querySelectorAll('i')) {
    const raw = (i.textContent || '').trim();
    if (!raw || raw.length < 2) continue;
    const cleaned = raw
      .replace(/\s*\((?:musical|play|opera)\)\s*$/i, '')
      .replace(/[‡†*]+$/, '')
      .trim();
    if (cleaned) out.push(cleaned);
  }
  return out;
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

  // The main table is the longest wikitable that has a year-like first column.
  const tables = Array.from(doc.querySelectorAll('table.wikitable'));
  const ranked = tables
    .map((t) => {
      const rows = Array.from(t.querySelectorAll('tr'));
      const yearRows = rows.filter((r) => /\b(19|20)\d{2}\b/.test((r.querySelector('th,td')?.textContent) || ''));
      return { t, score: yearRows.length };
    })
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0 || ranked[0].score === 0) throw new Error('No year-prefixed wikitable found');
  const mainTable = ranked[0].t;

  const entries = [];
  let currentYear = null;
  let rowsLeftForYear = 0;
  for (const row of mainTable.querySelectorAll('tr')) {
    const cells = Array.from(row.children).filter((el) => el.tagName === 'TD' || el.tagName === 'TH');
    if (cells.length === 0) continue;

    const first = cells[0];
    const yearMatch = (first.textContent || '').match(/^\s*([12]\d{3})/);
    let workingCells = cells;
    if (yearMatch) {
      currentYear = parseInt(yearMatch[1], 10);
      const rs = parseInt(first.getAttribute('rowspan') || '1', 10);
      rowsLeftForYear = rs > 1 ? rs : 1;
      workingCells = cells.slice(1);
    } else if (rowsLeftForYear > 0 && currentYear) {
      // continuation row
    } else {
      continue;
    }

    if (!currentYear || currentYear < MIN_YEAR) {
      rowsLeftForYear = Math.max(0, rowsLeftForYear - 1);
      continue;
    }

    // First italic in the row = winner, all subsequent = finalists (unless
    // "No award" row).
    const text = row.textContent || '';
    if (/no award|not awarded/i.test(text) && !text.match(/finalist/i)) {
      rowsLeftForYear = Math.max(0, rowsLeftForYear - 1);
      continue;
    }

    const allTitles = [];
    for (const c of workingCells) allTitles.push(...cellTitles(c));
    if (allTitles.length === 0) {
      rowsLeftForYear = Math.max(0, rowsLeftForYear - 1);
      continue;
    }

    // Year already recorded? Append finalists.
    let entry = entries.find((e) => e.year === currentYear);
    if (!entry) {
      entry = { year: currentYear, winner: allTitles[0], finalists: [] };
      entries.push(entry);
      for (const t of allTitles.slice(1)) {
        if (t.toLowerCase() !== entry.winner.toLowerCase() && !entry.finalists.some((f) => f.toLowerCase() === t.toLowerCase())) {
          entry.finalists.push(t);
        }
      }
    } else {
      for (const t of allTitles) {
        if (t.toLowerCase() === entry.winner.toLowerCase()) continue;
        if (!entry.finalists.some((f) => f.toLowerCase() === t.toLowerCase())) entry.finalists.push(t);
      }
    }
    rowsLeftForYear = Math.max(0, rowsLeftForYear - 1);
  }

  entries.sort((a, b) => a.year - b.year);
  console.log(`  ${entries.length} year entries (${entries.filter((e) => e.finalists.length > 0).length} with finalists)`);

  const fp = path.join(PRECURSORS_DIR, 'pulitzer.json');
  if (fs.existsSync(fp)) {
    const baseline = JSON.parse(fs.readFileSync(fp, 'utf8')).data;
    const baseYears = new Set(baseline.map((e) => e.year));
    const newYears = new Set(entries.map((e) => e.year));
    const added = [...newYears].filter((y) => !baseYears.has(y)).sort();
    const removed = [...baseYears].filter((y) => !newYears.has(y)).sort();
    console.log(`\nDiff vs baseline: +${added.join(',') || '∅'} / -${removed.join(',') || '∅'}`);
  }

  const out = writePrecursorJson('pulitzer', entries, {
    force: FORCE,
    dryRun: !WRITE,
    meta: { sourcePage: PAGE, minYear: MIN_YEAR },
  });
  console.log(out.written ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})` : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
