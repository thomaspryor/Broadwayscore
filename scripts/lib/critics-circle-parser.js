/**
 * Custom parser for Critics' Circle Theatre Awards.
 *
 * Critics' Circle does NOT have per-category Wikipedia pages — every URL
 * like `Critics'_Circle_Theatre_Award_for_Best_Actor` redirects to the same
 * combined page (`Critics'_Circle_Theatre_Award`) with section anchors.
 *
 * The combined page has 44 wikitables organized by category → decade.
 * Per-category section structure:
 *   <h3 id="Best_New_Play"> ... <table>1980s</table> <table>1990s</table> ...
 *   <h3 id="Best_Actor">    ... <table>1980s</table> <table>1990s</table> ...
 *
 * Row format differs by category:
 *   - "Best New Play":            Year | Play (recipient) | Writer | Ref
 *   - "Best Actor"/"Best Actress": Year | Performer name  | Work   | Ref
 *   - "Best Director":            Year | Director name   | Work   | Ref
 *   - "Most Promising Playwright": Year | Playwright name | Work  | Ref
 *
 * The SHOW column is index 1 for Best New Play (the play IS the recipient)
 * and index 2 for the others (the recipient is a person, the work is the show).
 *
 * Critics' Circle is winner-only — no nominee lists are published.
 *
 * Usage:
 *   const { fetchCCPage, extractCategoryEntries } = require('./critics-circle-parser');
 *   const html = await fetchCCPage();
 *   const entries = extractCategoryEntries(html, 'Best New Play', 1990);
 *   // → [{ year: 1990, winner: 'Racing Demon', nominees: ['Racing Demon'] }, ...]
 */

const https = require('https');
const { JSDOM } = require('jsdom');

const CC_URL = 'https://en.wikipedia.org/wiki/Critics%27_Circle_Theatre_Award';

/** Section anchor → which column index holds the SHOW title. */
const SHOW_COLUMN_BY_CATEGORY = {
  'Best New Play': 1,            // recipient = the play
  'Best Actor': 2,                // recipient = person, work = play
  'Best Actress': 2,
  'Best Director': 2,
  'Most Promising Playwright': 2, // recipient = playwright, work = breakout play
};

/** Section heading IDs as Wikipedia normalizes them (spaces → underscores). */
const SECTION_ID_BY_CATEGORY = {
  'Best New Play': 'Best_New_Play',
  'Best Actor': 'Best_Actor',
  'Best Actress': 'Best_Actress',
  'Best Director': 'Best_Director',
  'Most Promising Playwright': 'Most_Promising_Playwright',
};

function fetchCCPage() {
  return new Promise((resolve, reject) => {
    https
      .get(CC_URL, { headers: { 'User-Agent': 'BroadwayScorecard/1.0 (data ingestion)' } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} on ${CC_URL}`));
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

/**
 * Extract winner entries for a single Critics' Circle category.
 * @param {string} html  Combined CC page HTML
 * @param {string} category  Section name (e.g. 'Best New Play')
 * @param {number} minYear  Filter out entries before this year
 * @returns {Array<{year:number, winner:string, nominees:string[]}>}
 */
function extractCategoryEntries(html, category, minYear = 1990) {
  const sectionId = SECTION_ID_BY_CATEGORY[category];
  const showCol = SHOW_COLUMN_BY_CATEGORY[category];
  if (!sectionId || showCol === undefined) {
    throw new Error(`Unknown CC category: ${category}`);
  }

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Find the H3 anchor (Wikipedia wraps section IDs in a span or directly on the h3)
  const anchor = doc.getElementById(sectionId);
  if (!anchor) {
    throw new Error(`Section anchor not found: ${sectionId}`);
  }

  // Wikipedia 2024+ wraps section headings in <div class="mw-heading mw-heading3">
  // containing the H3. Tables are siblings of the WRAPPER div, not the H3 itself.
  let h3wrapper = anchor.parentElement;
  while (h3wrapper && !(h3wrapper.className || '').includes('mw-heading')) {
    h3wrapper = h3wrapper.parentElement;
  }
  if (!h3wrapper) {
    throw new Error(`No mw-heading wrapper for ${sectionId}`);
  }

  // Walk siblings until we hit the next heading div (next category or section).
  const tables = [];
  let cursor = h3wrapper.nextElementSibling;
  while (cursor) {
    const cls = cursor.className || '';
    const isNextHeading = cls.includes('mw-heading') && cursor.querySelector('h2, h3');
    if (isNextHeading) break;
    if (cursor.tagName === 'TABLE' && cls.includes('wikitable')) {
      tables.push(cursor);
    } else if (cursor.tagName === 'DIV') {
      const nested = cursor.querySelectorAll('table.wikitable');
      for (const t of nested) tables.push(t);
    }
    cursor = cursor.nextElementSibling;
  }

  const entries = [];
  for (const table of tables) {
    const rows = table.querySelectorAll('tbody > tr');
    for (const row of rows) {
      // Wikipedia uses <th> for the year and <td> for data cells. Collect
      // all cells in DOM order so column indices match the visible table.
      const cells = Array.from(row.children).filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
      if (cells.length < 2) continue;
      const yearText = cells[0]?.textContent?.trim() || '';
      const yearMatch = yearText.match(/(\d{4})/);
      if (!yearMatch) continue; // header row (no year)
      const year = parseInt(yearMatch[1], 10);
      if (year < minYear) continue;
      const showCell = cells[showCol];
      if (!showCell) continue;
      const winner = (showCell.textContent || '')
        .replace(/\[\s*\d+\s*\]/g, '') // strip [12] reference markers
        .trim();
      if (!winner || /^no award$/i.test(winner)) {
        entries.push({ year, winner: null, nominees: [], noAward: true });
        continue;
      }
      // Critics' Circle occasionally awards multiple works in one year
      // (e.g. "Blues for an Alabama Sky and Othello" — two distinct plays
      // sharing the Best Actor win). Wikipedia stores this as one cell
      // joined by " and " or ", X, Y and Z". Try to split for attribution.
      //
      // BUT many real titles also contain " and " or commas (Harry Potter
      // and the Cursed Child, One Man Two Guvnors, People Places and Things).
      // Conservative approach: include both the raw original AND best-effort
      // splits in nominees. enrich-awards-with-precursors.js iterates each
      // nominee and matches against shows.json — the real title matches,
      // the bogus halves don't. Set `winners` (array) so enrich attributes
      // the win to whichever halves match.
      const splitCandidates = splitMultiWinnerTitle(winner);
      const nominees = splitCandidates.length > 1
        ? [winner, ...splitCandidates]  // raw first (in case it's one real title)
        : [winner];
      const winners = splitCandidates.length > 1
        ? [winner, ...splitCandidates]
        : [winner];
      entries.push({ year, winner, nominees, winners });
    }
  }

  // Dedupe by year (in case decade tables overlap)
  const byYear = new Map();
  for (const e of entries) {
    if (!byYear.has(e.year)) byYear.set(e.year, e);
  }
  return Array.from(byYear.values()).sort((a, b) => a.year - b.year);
}

/**
 * Best-effort split of a multi-winner title string. Returns split candidates
 * if the input looks like a multi-work join; otherwise an empty array (=
 * single title, no split needed).
 *
 * Heuristics (conservative — false positives are worse than misses since
 * enrich.js also keeps the raw title as a nominee):
 *   - Split on ", X and Y" (comma + "and" pattern)
 *   - Split on " and " ONLY if both halves are 2+ words AND each half starts
 *     with capital letter (rules out "Harry Potter and the Cursed Child"
 *     where "the Cursed Child" starts lowercase)
 *
 * Exported for unit testing.
 */
function splitMultiWinnerTitle(s) {
  if (!s || typeof s !== 'string') return [];
  // Pattern 1: "A, B and C" — three or more titles
  if (/^.+, .+ and .+$/.test(s) && s.split(',').length >= 2) {
    const parts = s.split(/,\s*|\s+and\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3 && parts.every((p) => /^[A-Z0-9]/.test(p))) {
      return parts;
    }
  }
  // Pattern 2: "X and Y" — two titles
  const andMatch = s.match(/^(.+?)\s+and\s+(.+)$/);
  if (andMatch) {
    const [, left, right] = andMatch;
    // Both halves must start with capital AND be ≥2 words.
    // "Harry Potter and the Cursed Child" → right="the Cursed Child" starts
    // lowercase → no split.
    // "Blues for an Alabama Sky and Othello" → right="Othello" 1 word but capital.
    // Allow 1-word right side if it's clearly a play title (capital, ≥4 chars).
    const isLeftTitle = /^[A-Z]/.test(left) && left.split(/\s+/).length >= 2;
    const isRightTitle = /^[A-Z]/.test(right) && (right.split(/\s+/).length >= 2 || right.length >= 4);
    if (isLeftTitle && isRightTitle) return [left.trim(), right.trim()];
  }
  return [];
}

module.exports = { fetchCCPage, extractCategoryEntries, splitMultiWinnerTitle, SHOW_COLUMN_BY_CATEGORY, SECTION_ID_BY_CATEGORY };
