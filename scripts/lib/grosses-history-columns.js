/**
 * Resolves scripts/backfill-grosses-history.ts's Playbill grosses table
 * columns from the live header row instead of assuming a fixed layout
 * (BRO-2375 — same column-drift class as #118 / BRO-47's scrape-alltime.ts
 * fix). assertTableSchema's expectedHeaders check only guarantees the
 * labels are present somewhere in the header row, not that an
 * inserted/reordered column hasn't shifted them off cells[0]/[1]/[3]/[4]/
 * [5]/[6] — the positions the row-extraction code used to assume.
 *
 * Extracted to a plain module (rather than inlined in the Playwright
 * `page.$$eval` callback) because `$$eval` serializes its callback to run
 * in-page — it can't close over this file's `findColumnIndex` import, so
 * indices must be resolved here in Node and passed into `$$eval` as a
 * plain-data argument.
 */
const { findColumnIndex } = require('./table-schema-assertion');

const LEGACY_INDICES = {
  showIdx: 0, grossIdx: 1, atpIdx: 3, seatsIdx: 4, perfsIdx: 5, capIdx: 6,
};

/**
 * @param {string[]} headerCells - header cell text, in document order
 * @returns {typeof LEGACY_INDICES}
 */
function resolveGrossesHistoryColumns(headerCells) {
  if (!headerCells || headerCells.length === 0) return { ...LEGACY_INDICES };

  const resolve = (label, fallback) => {
    const found = findColumnIndex(headerCells, label);
    return found !== -1 ? found : fallback;
  };

  return {
    showIdx: resolve('Show', LEGACY_INDICES.showIdx),
    grossIdx: resolve('This Week Gross', LEGACY_INDICES.grossIdx),
    atpIdx: resolve('Avg Ticket', LEGACY_INDICES.atpIdx),
    seatsIdx: resolve('Seats Sold', LEGACY_INDICES.seatsIdx),
    perfsIdx: resolve('Perfs', LEGACY_INDICES.perfsIdx),
    capIdx: resolve('% Cap', LEGACY_INDICES.capIdx),
  };
}

module.exports = { resolveGrossesHistoryColumns, LEGACY_INDICES };
