/**
 * Custom parser for Evening Standard Theatre Awards Wikipedia pages.
 *
 * ES has per-category pages (DD-style — each award gets its own URL) BUT the
 * table structure is different from DD:
 *   - Year is expressed as a CEREMONY ORDINAL ("1st", "2nd", ... "70th") in
 *     a dedicated row, not as a year in each data row
 *   - Each winner spans 2 rows: a ceremony-ordinal row (1 cell) followed by
 *     a winner row (Play | Writer  OR  Performer | Work)
 *   - Some ceremonies have multiple winners (ties) → multiple winner rows
 *     before the next ordinal row
 *
 * Ceremony ordinal → year: ES launched 1955 (1st ceremony). Year = 1954 + N.
 * Ceremonies have run yearly except for a few skipped years (pandemic, etc.)
 * — Wikipedia displays the actual year in the ordinal cell text sometimes
 * ("70th (2024)") so we extract the explicit year when present.
 *
 * Per-category SHOW column index (in the winner row, after the optional
 * performer name):
 *   - Best Play / Best Musical: Show is column 0 (the play IS the recipient)
 *   - Best Actor / Best Actress: Show is column 1 (col 0 = performer name,
 *     col 1 = work/play)
 *
 * Usage:
 *   const { fetchESPage, extractCategoryEntries } = require('./evening-standard-parser');
 *   const html = await fetchESPage('Best_Play');
 *   const entries = extractCategoryEntries(html, 'Best Play', 1990);
 */

const https = require('https');
const { JSDOM } = require('jsdom');

const ES_BASE_URL = 'https://en.wikipedia.org/wiki/Evening_Standard_Theatre_Award_for_';
const FIRST_CEREMONY_YEAR = 1955; // 1st ceremony was in 1955

const SHOW_COL_BY_CATEGORY = {
  'Best Play': 0,
  'Best Musical': 0,
  'Best Actor': 1,
  'Best Actress': 1,
};

function fetchESPage(slug) {
  const url = ES_BASE_URL + slug;
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'BroadwayScorecard/1.0 (data ingestion)' } }, (res) => {
        if (res.statusCode === 404) {
          reject(new Error(`HTTP 404 on ${url}`));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} on ${url}`));
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

/** "1st" → 1, "23rd" → 23. Returns NaN if no ordinal. */
function parseOrdinal(s) {
  if (!s) return NaN;
  const m = s.match(/(\d+)(?:st|nd|rd|th)/i);
  return m ? parseInt(m[1], 10) : NaN;
}

/** Returns the explicit year in a ceremony cell if present, else null.
 *  E.g. "70th (2024)" → 2024, "1955" → 1955. */
function parseExplicitYear(s) {
  if (!s) return null;
  // Explicit (YYYY) parenthetical takes precedence
  const paren = s.match(/\((\d{4})\)/);
  if (paren) return parseInt(paren[1], 10);
  // Standalone 4-digit year (e.g. Best Actor uses "1955" directly)
  const standalone = s.match(/^\s*(\d{4})\s*$/);
  if (standalone) {
    const y = parseInt(standalone[1], 10);
    if (y >= 1900 && y <= 2099) return y;
  }
  return null;
}

/**
 * Extract winner entries for an Evening Standard category.
 *
 * @param {string} html
 * @param {string} category - one of: 'Best Play', 'Best Musical', 'Best Actor', 'Best Actress'
 * @param {number} minYear
 * @returns {Array<{year:number, winner:string|null, nominees:string[], winners?:string[]}>}
 */
function extractCategoryEntries(html, category, minYear = 1990) {
  const showCol = SHOW_COL_BY_CATEGORY[category];
  if (showCol === undefined) throw new Error(`Unknown ES category: ${category}`);

  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const tables = doc.querySelectorAll('table.wikitable');

  // year → { winners: [...], nominees: [...] }. Winner rows are marked with
  // <b> in the show cell (modern multi-row tables); single-row tables
  // (pre-2010-ish) treat the row's show as the winner.
  const byYear = new Map();

  function ensureYear(y) {
    if (!byYear.has(y)) byYear.set(y, { winners: [], nominees: [] });
    return byYear.get(y);
  }

  function extractWinner(cell) {
    return cell.textContent.replace(/\[\s*\d+\s*\]/g, '').trim();
  }
  function isWinnerCell(cell) {
    // Modern Wikipedia tables wrap the winner show in <b>. Some pages use
    // background highlight too — accept either.
    if (cell.querySelector('b, strong')) return true;
    const styles = (cell.getAttribute('style') || '');
    if (/background|#[a-f0-9]{3,6}/i.test(styles)) return true;
    return false;
  }

  for (const table of tables) {
    const rows = table.querySelectorAll('tbody > tr');
    let currentYear = null;
    let isFirstDataRowAfterHeader = false;
    for (const row of rows) {
      const cells = Array.from(row.children).filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
      if (cells.length === 0) continue;

      // Header row?
      const firstText = cells[0].textContent.trim();
      if (/^(Ceremony|Year|Play|Actor|Actress|Work|Writer|Director|Show)$/i.test(firstText)) continue;

      // Ceremony/Year header cell (1 cell with ordinal OR standalone year)?
      const ord = parseOrdinal(firstText);
      const explicitYear = parseExplicitYear(firstText);
      const yearFromHeader = explicitYear ?? (Number.isNaN(ord) ? null : FIRST_CEREMONY_YEAR + ord - 1);
      if (yearFromHeader != null && cells.length === 1) {
        currentYear = yearFromHeader;
        isFirstDataRowAfterHeader = true;
        continue;
      }

      // Rowspan-combined first cell: cell 0 is ordinal/year AND cells 1+ are
      // data. Treat as new ceremony + winner row.
      if (yearFromHeader != null && cells.length >= 2) {
        currentYear = yearFromHeader;
        const winnerCells = cells.slice(1);
        const showCell = winnerCells[showCol] || winnerCells[0];
        if (showCell && currentYear >= minYear) {
          const name = extractWinner(showCell);
          if (name && !/^no award$/i.test(name)) {
            const y = ensureYear(currentYear);
            // First row after ordinal — assume winner (most pre-2010 tables
            // have only one row per ceremony, the winner). Bold check still
            // applies if present.
            y.winners.push(name);
            y.nominees.push(name);
          }
        }
        isFirstDataRowAfterHeader = false;
        continue;
      }

      // Data row (under a previously-set ordinal/year)
      if (currentYear == null) continue;
      if (currentYear < minYear) {
        isFirstDataRowAfterHeader = false;
        continue;
      }
      const showCell = cells[showCol];
      if (!showCell) continue;
      const name = extractWinner(showCell);
      if (!name || /^no award$/i.test(name)) {
        isFirstDataRowAfterHeader = false;
        continue;
      }
      const y = ensureYear(currentYear);
      // If this row has bold markup on the show cell → winner. Otherwise
      // nominee. For older tables that don't use bold (one entry per
      // ceremony), the FIRST data row under the ordinal is the winner.
      const looksLikeWinner = isWinnerCell(showCell) || (isFirstDataRowAfterHeader && cells.length === 2);
      if (looksLikeWinner) y.winners.push(name);
      y.nominees.push(name);
      isFirstDataRowAfterHeader = false;
    }
  }

  const entries = [];
  for (const [year, { winners, nominees }] of Array.from(byYear.entries()).sort((a, b) => a[0] - b[0])) {
    if (winners.length === 0 && nominees.length === 0) {
      entries.push({ year, winner: null, nominees: [], noAward: true });
      continue;
    }
    // Dedupe
    const uniqWinners = Array.from(new Set(winners));
    const uniqNominees = Array.from(new Set(nominees));
    if (uniqWinners.length === 1) {
      entries.push({ year, winner: uniqWinners[0], nominees: uniqNominees });
    } else if (uniqWinners.length > 1) {
      entries.push({ year, winner: uniqWinners[0], winners: uniqWinners, nominees: uniqNominees });
    } else {
      // No identified winner but we have nominees — pick the first as winner.
      entries.push({ year, winner: uniqNominees[0], nominees: uniqNominees });
    }
  }
  return entries;
}

module.exports = {
  fetchESPage,
  extractCategoryEntries,
  parseOrdinal,
  parseExplicitYear,
  FIRST_CEREMONY_YEAR,
  SHOW_COL_BY_CATEGORY,
};
