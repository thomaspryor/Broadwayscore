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

// Highlight colors Wikipedia uses to mark winner rows on award category
// tables. Extended 2026-05-16 after audit found 2022+ Drama Desk Musical
// rows using #DCEEFF (light cyan) which wasn't in the original list. The
// safer move would be "any non-white background" but that risks tagging
// non-winner highlights (year-rowspan banners, in-memoriam shading, etc.)
// as winners. Explicit allowlist is the conservative choice.
const HIGHLIGHT_COLORS = [
  // Original list (Tony-style highlights)
  '#b0c4de', '#faeb86', '#fae7b5', '#eedd82', '#f5f5dc',
  '#fffacd', '#fff8dc', '#ffffcc', '#ffe4b5',
  // Drama Desk / Outer Critics / Drama League winner-row backgrounds (2020s)
  '#dceeff', '#cce5ff', '#d1e7dd', '#e7f3ff', '#cfe2ff',
  // Pulitzer / older pages
  '#ffd', '#ffdead', '#ffefd5',
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
    /lightsteelblue|gold|khaki|cornsilk|honeydew|lavender/.test(val);
}

function isWinnerCell(cell, rowBgHighlight) {
  // Winner detection precedence:
  //   1. row-level highlight background (most pages mark the winner row this way)
  //   2. bold + italic markup on the title (both <b><i> AND <i><b> orderings —
  //      Wikipedia's source-editor and visual-editor produce different orderings)
  //   3. dagger ‡ glyph immediately after the title
  if (rowBgHighlight) return true;
  // Both nesting orderings of bold+italic count. Real-world examples:
  //   <b><i><a>Title</a></i></b>  (Tony-style, older pages)
  //   <i><b><a>Title</a></b></i>  (Drama Desk 2020s)
  if (cell.querySelector('b > i, b a > i, b > a > i')) return true;
  if (cell.querySelector('i > b, i a > b, i > a > b')) return true;
  // Additional fallback: a single <i> whose <b> ancestor is below the cell
  // (handles cases where the bolding is on a wrapper inside the <i>).
  const italics = cell.querySelectorAll('i');
  for (const i of italics) {
    if (i.querySelector('b')) return true;
  }
  const text = cell.textContent || '';
  if (/[‡†]/.test(text) && italics.length === 1) return true;
  return false;
}

function cellShowTitles(cell) {
  const titles = [];
  const cleanOne = (raw) => {
    if (!raw || raw.length < 2) return null;
    const cleaned = raw
      .replace(/\s*\((?:musical|play|opera|ballet|revival)\)\s*$/i, '')
      .replace(/\s*[‡†*]+\s*$/, '')
      .replace(/\s*\[\d+\]\s*$/, '')  // strip trailing Wikipedia citation
      .trim();
    if (!cleaned) return null;
    if (/^(?:year|production|musical|play|nominee|winner)s?$/i.test(cleaned)) return null;
    return cleaned;
  };
  for (const i of cell.querySelectorAll('i')) {
    const c = cleanOne((i.textContent || '').trim());
    if (c) titles.push(c);
  }
  // Bold-only title fallback: some Wikipedia revival rows mark the winner as
  // <b><a>Title</a></b> (no <i>). Catch these by looking at <b> elements that
  // don't have an <i> ancestor (to avoid double-counting italicized bold).
  if (titles.length === 0) {
    for (const b of cell.querySelectorAll('b')) {
      // skip if inside an <i> (already handled) or if it wraps an <i> (also handled)
      if (b.closest('i')) continue;
      if (b.querySelector('i')) continue;
      const c = cleanOne((b.textContent || '').trim());
      if (c) titles.push(c);
    }
  }
  return titles;
}

function parseFourDigitYear(text) {
  // Match a 4-digit year at a word boundary. Wikipedia year cells often have
  // post-year markup like <sup>[94]</sup> for citations — the textContent ends
  // up as "2024[94][95]\n" so we need to allow `[` after the year too. Earlier
  // versions of this regex required a specific terminator and silently dropped
  // years 2024 + 2025 on the 2020s Drama Desk Musical table.
  const m = (text || '').match(/(?:^|\s|\[)([12]\d{3})(?:[^\d]|$)/);
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

  // Wikipedia award category pages usually split history into per-decade
  // tables (1970s, 1980s, 1990s, ...). Parse EVERY wikitable that has a
  // year-prefixed first column — picking only the first table would lose
  // 80%+ of years on modern pages.
  const yearTables = tables.filter((t) => {
    const rows = Array.from(t.querySelectorAll('tr')).slice(1, 6);
    return rows.some((r) => parseFourDigitYear((r.querySelector('th,td')?.textContent) || ''));
  });
  if (yearTables.length === 0) return [];

  const byYear = new Map();
  function ensureYear(y) {
    if (!byYear.has(y)) byYear.set(y, { year: y, winner: null, nomineeSet: new Map() });
    return byYear.get(y);
  }

  for (const yearTable of yearTables) {
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
  } // end for (const yearTable of yearTables)

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
