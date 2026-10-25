/**
 * Parses BroadwayWorld's cumulative grosses HTML table. Extracted from
 * scripts/scrape-alltime.ts (task BRO-47) so this logic is require()-able
 * from a plain Node test — the .ts file itself can't be require()'d
 * directly because its `import { Browser, Page } from 'playwright'` type-only
 * imports aren't erasable without a real TS transform.
 *
 * Column positions are resolved by header label (findColumnIndex) rather
 * than assumed by fixed index, so an inserted/reordered/appended column
 * doesn't silently misassign a value to the wrong field the way BWW's
 * March 2026 7→5 column change did (root cause of task #118).
 */
const cheerio = require('cheerio');
const { assertTableSchema, TableSchemaError, findColumnIndex } = require('./table-schema-assertion');

// Verified live 2026-08-12: <thead><th> = Show / Gross / Avg. Tix / Seats Sold / Total Perf.
const TABLE_SCHEMA = { minCells: 5, expectedHeaders: ['Show', 'Gross', 'Avg. Tix', 'Seats Sold', 'Total Perf'] };

function extractHeaderCells($) {
  let headerCells = $('table thead th').map((_i, el) => $(el).text().trim()).get();
  if (headerCells.length === 0) {
    headerCells = $('table tr').first().find('th, td').map((_i, el) => $(el).text().trim()).get();
  }
  return headerCells;
}

/**
 * @param {string} html
 * @returns {{showTitle: string, gross: string, attendance: string, performances: string}[]}
 */
function parseAllTimeHtml(html) {
  const $ = cheerio.load(html);
  const headerCells = extractHeaderCells($);

  try {
    assertTableSchema([headerCells], TABLE_SCHEMA);
  } catch (err) {
    if (err instanceof TableSchemaError) {
      console.error(`::error::scrape-alltime: ${err.message}`);
      return [];
    }
    throw err;
  }

  const showIdx = findColumnIndex(headerCells, 'Show');
  const grossIdx = findColumnIndex(headerCells, 'Gross');
  const attendanceIdx = findColumnIndex(headerCells, 'Seats Sold');
  const performancesIdx = findColumnIndex(headerCells, 'Total Perf');
  const maxIdx = Math.max(showIdx, grossIdx, attendanceIdx, performancesIdx);

  const rows = [];
  $('table tr').each((_i, rowEl) => {
    const cells = $(rowEl).find('td');
    if (cells.length <= maxIdx) return;

    const showTheater = $(cells[showIdx]).text().trim();
    const lines = showTheater.split('\n').map(s => s.trim()).filter(Boolean);
    const showTitle = lines[0] || '';
    const gross = $(cells[grossIdx]).text().trim();
    if (!showTitle || !gross.includes('$')) return;

    rows.push({
      showTitle,
      gross,
      attendance: $(cells[attendanceIdx]).text().trim(),
      performances: $(cells[performancesIdx]).text().trim(),
    });
  });

  return rows;
}

module.exports = { parseAllTimeHtml, TABLE_SCHEMA, extractHeaderCells };
