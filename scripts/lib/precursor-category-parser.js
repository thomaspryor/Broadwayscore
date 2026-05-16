/**
 * Parser for Wikipedia per-category award pages used by the Drama Desk,
 * Outer Critics Circle, and Drama League scrapers.
 *
 * These pages share a layout: one master `<table class="wikitable">` with
 * one row per ceremony year (or one row per nominee with the year `rowspan`'d
 * across them). Show titles appear in `<i>` italics. Winners are flagged
 * either by a `<b>` ancestor in the nominee cell or by a known highlight
 * background color on the row.
 */

const { JSDOM } = require('jsdom');

const USER_AGENT = 'BroadwayScorecardBot/1.0 (broadway-scorecard project; precursor-awards-scraper)';

const HIGHLIGHT_COLORS = [
  '#b0c4de', '#faeb86', '#fae7b5', '#eedd82', '#f5f5dc',
  '#fffacd', '#fff8dc', '#ffffcc', '#ffe4b5',
];

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

function bgIsHighlight(styleAttr) {
  if (!styleAttr) return false;
  const m = styleAttr.toLowerCase().match(/background(?:-color)?\s*:\s*([^;]+)/);
  if (!m) return false;
  const val = m[1].trim().toLowerCase();
  return HIGHLIGHT_COLORS.some((c) => val.includes(c)) ||
    /lightsteelblue|gold|khaki|cornsilk/.test(val);
}

function isWinnerCell(cell, rowBgHighlight) {
  // Winner detection precedence:
  //   1. row-level highlight background (some pages mark the entire winner row)
  //   2. <b> wrapping the <i> (Tony-style bold winner)
  //   3. dagger ‡ glyph immediately after the title
  if (rowBgHighlight) return true;
  if (cell.querySelector('b > i, b a > i, b > a > i')) return true;
  const text = cell.textContent || '';
  if (/[‡†]/.test(text) && cell.querySelectorAll('i').length === 1) return true;
  return false;
}

function cellShowTitles(cell) {
  const titles = [];
  for (const i of cell.querySelectorAll('i')) {
    const raw = (i.textContent || '').trim();
    if (!raw || raw.length < 2) continue;
    const cleaned = raw
      .replace(/\s*\((?:musical|play|opera|ballet|revival)\)\s*$/i, '')
      .replace(/\s*[‡†*]+\s*$/, '')
      .trim();
    if (!cleaned) continue;
    if (/^(?:year|production|musical|play|nominee|winner)s?$/i.test(cleaned)) continue;
    titles.push(cleaned);
  }
  return titles;
}

function parseFourDigitYear(text) {
  const m = (text || '').match(/(?:^|\s|\[)([12]\d{3})(?:\s|\]|–|-|:|$)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Parse a Wikipedia per-category award page and return entries shaped like:
 *   [{ year, winner, nominees: [...] }, ...]
 *
 * Handles the two common Wikipedia layouts:
 *   A) Per-year rows: `<tr><td rowspan>YEAR</td><td>WINNER ‡</td><td>NOMINEES…</td></tr>`
 *      (winner cell + nominee list cell)
 *   B) One row per nominee, year `rowspan`d down the first column.
 */
function parseCategoryPage(html, opts = {}) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const tables = Array.from(doc.querySelectorAll('table.wikitable'));
  if (tables.length === 0) return [];

  // The main award table is usually the first wikitable that has a year-like
  // first column. Pick the first whose body rows look year-prefixed.
  const yearTable = tables.find((t) => {
    const rows = Array.from(t.querySelectorAll('tr')).slice(1, 6);
    return rows.some((r) => parseFourDigitYear((r.querySelector('th,td')?.textContent) || ''));
  }) || tables[0];

  const byYear = new Map();
  function ensureYear(y) {
    if (!byYear.has(y)) byYear.set(y, { year: y, winner: null, nomineeSet: new Map() });
    return byYear.get(y);
  }

  let currentYear = null;
  let rowsLeftForYear = 0;
  let currentWinnerSeen = false;

  const rows = Array.from(yearTable.querySelectorAll('tr'));
  for (const row of rows) {
    const cells = Array.from(row.children).filter((el) => el.tagName === 'TD' || el.tagName === 'TH');
    if (cells.length === 0) continue;

    const rowBgHighlight = bgIsHighlight(row.getAttribute('style')) ||
      Array.from(cells).some((c) => bgIsHighlight(c.getAttribute('style')));

    // Year detection: first cell text starts with a 4-digit year.
    // If the cell has rowspan, the next N rows belong to the same year.
    let firstCell = cells[0];
    let nomineeCells = cells.slice(1);
    const yearFromCell = parseFourDigitYear(firstCell.textContent || '');
    if (yearFromCell) {
      currentYear = yearFromCell;
      const rs = parseInt(firstCell.getAttribute('rowspan') || '1', 10);
      rowsLeftForYear = rs > 1 ? rs : 1;
      currentWinnerSeen = false;
    } else if (rowsLeftForYear > 0 && currentYear) {
      // Continuation row for the rowspan'd year. The "first cell" here is
      // actually a nominee cell.
      nomineeCells = cells;
    } else {
      continue;
    }

    if (!currentYear) continue;
    if (currentYear < (opts.minYear || 1970)) {
      rowsLeftForYear = Math.max(0, rowsLeftForYear - 1);
      continue;
    }

    const yearEntry = ensureYear(currentYear);

    for (const cell of nomineeCells) {
      const titles = cellShowTitles(cell);
      if (titles.length === 0) continue;
      const cellIsWinner = isWinnerCell(cell, rowBgHighlight);
      for (const t of titles) {
        const key = t.toLowerCase();
        if (!yearEntry.nomineeSet.has(key)) {
          yearEntry.nomineeSet.set(key, t);
        }
        if (cellIsWinner && !currentWinnerSeen) {
          // The first bolded title in the year wins (Wikipedia convention).
          yearEntry.winner = t;
          currentWinnerSeen = true;
        }
      }
    }

    rowsLeftForYear = Math.max(0, rowsLeftForYear - 1);
  }

  return Array.from(byYear.values())
    .map(({ year, winner, nomineeSet }) => {
      const nominees = Array.from(nomineeSet.values());
      // Ensure winner is in nominees (Wikipedia layouts sometimes list the
      // winner only in the "winner" cell separate from the nominee list).
      if (winner && !nominees.some((n) => n.toLowerCase() === winner.toLowerCase())) {
        nominees.unshift(winner);
      }
      return { year, winner, nominees };
    })
    .sort((a, b) => a.year - b.year);
}

module.exports = { fetchHtml, parseCategoryPage, bgIsHighlight };
