/**
 * Parses Wikipedia's New York Drama Critics' Circle combined wikitable
 * (Year / Show / Author(s) / Nominated for), used for pre-2010 winners.
 * Extracted from scripts/scrape-nydcc.js so this logic is require()-able
 * from a plain Node test.
 *
 * Column positions are resolved by header label (findColumnIndex) rather
 * than assumed by fixed index (BRO-2375 — same column-drift class as #118 /
 * BRO-47's scrape-alltime.ts fix): assertTableSchema's `minCells: 4` check
 * only guarantees the row still has 4+ cells, not that Year/Show/"Nominated
 * for" are still at cells[0]/[1]/[3] if Wikipedia inserts or reorders a
 * column (e.g. an "Author(s)" column moving).
 */
const { JSDOM } = require('jsdom');
const { assertTableSchema, TableSchemaError, findColumnIndex } = require('./table-schema-assertion');

/**
 * @param {string} tableOuterHtml - the `<table>...</table>` markup for a
 *   single wikitable
 * @param {object} opts
 * @param {number} opts.minYear - years before this are dropped
 * @param {(headingText: string) => string | null} opts.categoryForHeading -
 *   resolves a "Nominated for" cell's text to an output category, or null
 * @param {(raw: string) => string | null} opts.cleanTitle - normalizes a
 *   raw title string, or null if it's not a usable title
 * @returns {{ error: string | null, entries: {category: string, year: number, title: string}[] }}
 */
function parseNydccLegacyTable(tableOuterHtml, { minYear, categoryForHeading, cleanTitle }) {
  const dom = new JSDOM(tableOuterHtml);
  const table = dom.window.document.querySelector('table');
  const rows = table ? Array.from(table.querySelectorAll('tr')) : [];
  const headerCells = Array.from(rows[0]?.children || []).map((c) => (c.textContent || '').trim());

  try {
    assertTableSchema([headerCells], { minCells: 4 });
  } catch (err) {
    if (err instanceof TableSchemaError) return { error: err.message, entries: [] };
    throw err;
  }

  const yearIdx = findColumnIndex(headerCells, 'Year');
  const titleIdx = findColumnIndex(headerCells, 'Show');
  // The caller identifies this table by EITHER "Nominated for" or "Category"
  // in the header text (see scrape-nydcc.js's own regex) — match both here
  // so a table using the "Category" spelling isn't silently dropped once it
  // reaches this function.
  const catIdx = findColumnIndex(headerCells, 'Nominated for') !== -1
    ? findColumnIndex(headerCells, 'Nominated for')
    : findColumnIndex(headerCells, 'Category');

  // All three columns are required to parse a row — if any one isn't found
  // by label, cells[-1] below would throw rather than silently misreading
  // (BRO-2375: a missing label must fail loud, the same way assertTableSchema
  // does, not partially process with an out-of-bounds index).
  if (yearIdx === -1 || titleIdx === -1 || catIdx === -1) {
    return { error: `required column(s) not found by label (year=${yearIdx}, show=${titleIdx}, category=${catIdx})`, entries: [] };
  }
  const maxIdx = Math.max(yearIdx, titleIdx, catIdx);

  const entries = [];

  for (const row of rows) {
    const cells = Array.from(row.children).filter((el) => el.tagName === 'TD' || el.tagName === 'TH');
    if (cells.length <= maxIdx) continue;

    const yearMatch = (cells[yearIdx].textContent || '').trim().match(/^([12]\d{3})/);
    if (!yearMatch) continue;
    const year = parseInt(yearMatch[1], 10);
    if (year < minYear) continue;

    const italic = cells[titleIdx].querySelector('i');
    const title = cleanTitle(italic ? italic.textContent : cells[titleIdx].textContent);
    if (!title) continue;

    const cat = categoryForHeading((cells[catIdx].textContent || '').trim());
    if (!cat) continue;

    entries.push({ category: cat, year, title });
  }

  return { error: null, entries };
}

module.exports = { parseNydccLegacyTable };
