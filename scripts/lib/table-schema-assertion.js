/**
 * Fails loud when a scraped HTML table's structure has drifted from what a
 * scraper expects, instead of silently dropping every row.
 *
 * Root cause this guards against (task #118): BroadwayWorld's cumulative
 * grosses table dropped from 7 to 5 columns in March 2026. scrape-alltime.ts
 * hardcoded cells[6] + a `cells.length < 6` guard, so every row fell below
 * the guard and the cron logged "Found 0 shows" for two months (fixed in
 * 09c841f07c). A per-row length guard alone can't distinguish "site changed
 * schema" from "site is temporarily down" — both look like 0 matched rows
 * after all rows are silently dropped one by one. Calling this BEFORE the
 * row loop turns a silent schema drift into a loud, specific, immediate
 * failure.
 */

class TableSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TableSchemaError';
  }
}

function normalizeHeaderText(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @param {string[][]} rows - cell-text arrays for the table's rows, in
 *   document order (header row included if the table has one). The first
 *   row with at least one non-empty cell is treated as the header/schema row.
 * @param {object} opts
 * @param {number} opts.minCells - minimum cell count the header row must have
 * @param {string[]} [opts.expectedHeaders] - header label substrings that
 *   must all appear somewhere in the header row text (case-insensitive,
 *   whitespace-normalized). Omit to skip label checking (cell-count only).
 * @throws {TableSchemaError} when the table doesn't match the expected schema
 * @returns {true}
 */
function assertTableSchema(rows, { minCells, expectedHeaders = [] } = {}) {
  if (typeof minCells !== 'number') {
    throw new TableSchemaError('assertTableSchema: minCells is required');
  }

  const headerRow = Array.isArray(rows)
    ? rows.find(r => Array.isArray(r) && r.some(c => String(c || '').trim() !== ''))
    : null;

  if (!headerRow) {
    throw new TableSchemaError(
      'assertTableSchema: no rows to inspect — table missing or page structure changed'
    );
  }

  if (headerRow.length < minCells) {
    throw new TableSchemaError(
      `assertTableSchema: header row has ${headerRow.length} cells, expected >= ${minCells}. ` +
      `Table schema likely changed. Row: ${JSON.stringify(headerRow)}`
    );
  }

  if (expectedHeaders.length > 0) {
    const headerText = normalizeHeaderText(headerRow.join(' | '));
    const missing = expectedHeaders.filter(h => !headerText.includes(normalizeHeaderText(h)));
    if (missing.length > 0) {
      throw new TableSchemaError(
        `assertTableSchema: expected header label(s) missing: ${missing.join(', ')}. ` +
        `Header row: ${JSON.stringify(headerRow)}`
      );
    }
  }

  return true;
}

/**
 * Finds a header column's index by label instead of assuming a fixed
 * position (task BRO-47 follow-up to #118: a fixed-position schema check
 * alone still breaks if a source inserts/reorders a column between two
 * that a scraper already reads by index — the schema assertion passes
 * because all expected labels are still present, but `cells[N]` now reads
 * the wrong data). Case-insensitive, whitespace-normalized.
 *
 * Tries an exact match first, falling back to substring only if no header
 * cell matches exactly — a pure substring match would resolve a label like
 * "Gross" to a future "Weekly Gross" column ahead of the real "Gross"
 * column, silently reintroducing the same wrong-cell class of bug this
 * function exists to prevent. Returns -1 if nothing matches either way.
 *
 * @param {string[]} headerRow - header cell text, in document order
 * @param {string} label - text to match against each header cell
 * @returns {number}
 */
function findColumnIndex(headerRow, label) {
  const target = normalizeHeaderText(label);
  const exact = headerRow.findIndex(h => normalizeHeaderText(h) === target);
  if (exact !== -1) return exact;
  return headerRow.findIndex(h => normalizeHeaderText(h).includes(target));
}

module.exports = { assertTableSchema, TableSchemaError, findColumnIndex };
