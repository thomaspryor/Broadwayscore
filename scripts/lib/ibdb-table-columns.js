/**
 * Resolves scripts/scrape-ibdb.ts's per-table title column from that
 * table's own header row instead of always assuming cells[0] (BRO-2375 —
 * same column-drift class as #118). scrape-ibdb.ts's TABLE_SCHEMA only
 * checks `minCells: 2` (no expectedHeaders — the IBDB statistics page's
 * exact table layout isn't pinned down the way BWW's is), so it never
 * validated that the title stayed in the first column; gross/performances/
 * attendance were already found by content-sniffing (`.includes('$')`,
 * digit-run regexes), not position, so only the title extraction needed
 * this fix.
 */
const { findColumnIndex } = require('./table-schema-assertion');

/**
 * @param {string[][]} headerRows - one header-cell-text array per table, in
 *   document order (matches `document.querySelectorAll('table')` order)
 * @returns {number[]} title column index per table, falling back to 0 when
 *   no header cell matches a title-ish label
 */
function resolveIbdbTitleIndices(headerRows) {
  if (!Array.isArray(headerRows)) return [];
  return headerRows.map((headerCells) => {
    if (!headerCells || headerCells.length === 0) return 0;
    // Try an EXACT match on either label before falling back to either
    // label's substring match — checking 'Show' then 'Title' independently
    // (each trying exact-then-substring before moving to the next label)
    // let a loose substring hit on 'Show' (e.g. "Shows Played") win over an
    // exact "Title" header elsewhere in the same row.
    const normalized = headerCells.map((h) => String(h || '').trim().toLowerCase());
    const exact = normalized.findIndex((h) => h === 'show' || h === 'title');
    if (exact !== -1) return exact;
    const found = findColumnIndex(headerCells, 'Show');
    if (found !== -1) return found;
    const titleFound = findColumnIndex(headerCells, 'Title');
    return titleFound !== -1 ? titleFound : 0;
  });
}

module.exports = { resolveIbdbTitleIndices };
