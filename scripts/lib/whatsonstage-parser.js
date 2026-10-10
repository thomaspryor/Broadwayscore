/**
 * Custom parser for WhatsOnStage Awards Wikipedia pages.
 *
 * WOS uses per-year pages (`{YEAR}_WhatsOnStage_Awards`), each with ONE
 * `<table class="wikitable">` in the "Winners and nominees" section. The
 * table is a paired-column layout: header rows have two TH category names
 * (Cat A | Cat B), followed by a data row with two TD cells holding the
 * winner + nominees for each.
 *
 * Cell shape:
 *   <ul>
 *     <li><b>WINNER</b><ul><li>nominee1</li>...</ul></li>
 *   </ul>
 *
 * For SHOW categories (Best New Play, Best Musical Revival, etc.) the
 * show title is wrapped in <i>...</i> directly.
 *
 * For PERFORMER categories (Best Performer in a Play, etc.) the cell is
 * formatted as "Performer, <i>Show</i>" — the SHOW is still inside <i>
 * tags, so extracting the LAST <i> in each <li> reliably yields the show.
 *
 * Category names change over time (e.g. 2020+ uses "Performer", earlier
 * years used "Actor in a Play" / "Actress in a Play"). We pass through
 * whatever the page says — category canonicalization happens at scoring.
 *
 * Usage:
 *   const { fetchWOSPage, extractYearEntries } = require('./whatsonstage-parser');
 *   const html = await fetchWOSPage(2024);
 *   const entries = extractYearEntries(html, 2024);
 *   // entries: [{ category, year, winner, nominees }, ...]
 */

const https = require('https');
const { JSDOM } = require('jsdom');

const WOS_BASE_URL = 'https://en.wikipedia.org/wiki/';

function fetchWOSPage(year) {
  const url = `${WOS_BASE_URL}${year}_WhatsOnStage_Awards`;
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

/**
 * Extract the show/work name from a <li> element.
 *
 * Wikipedia WOS cells use four shapes:
 *   A. show with article link: <a><i><b>Show</b></i></a>
 *   B. show with article + standalone modifier:
 *      <a><i><b>Show</b></i></a> <i><b>25th anniversary</b></i>
 *      (the trailing italic is a non-title note, not the winner)
 *   C. performer + show: <b>Performer, <i>Show</i></b>
 *   D. performer + linked show: Performer for <i><a>Show</a></i>
 *
 * Strategy: prefer the LAST <i> that has an <a href="/wiki/..."> association
 * (either ancestor or descendant). That captures the linked title in A/B/D
 * and ignores trailing italicized modifiers like "25th anniversary". If no
 * <i> has any link association (case C — performer-comma-unlinked-show),
 * fall back to the last <i>.
 */
function extractShow(li) {
  // Use only direct text children + immediate <i>/<b> — IGNORE nested <ul>
  // (nominees nested inside the winner <li>).
  const clone = li.cloneNode(true);
  // Strip nested ULs so we only see this li's own text.
  for (const u of clone.querySelectorAll('ul')) u.remove();

  const italics = Array.from(clone.querySelectorAll('i'));
  if (italics.length > 0) {
    const hasWikiLink = (i) =>
      !!i.querySelector('a[href^="/wiki/"]') ||
      (i.closest && !!i.closest('a[href^="/wiki/"]'));
    const linked = italics.filter(hasWikiLink);
    const pick = linked.length > 0 ? linked[linked.length - 1] : italics[italics.length - 1];
    const txt = pick.textContent.replace(/\[\s*\d+\s*\]/g, '').trim();
    if (txt) return txt;
  }
  // Fallback: full text minus citations
  const full = clone.textContent.replace(/\[\s*\d+\s*\]/g, '').trim();
  return full;
}

/**
 * Is this <li> the winner row? Winners are wrapped in <b>.
 */
function isWinnerLi(li) {
  // Check direct children only (don't be fooled by <b> inside nested <ul>)
  const clone = li.cloneNode(true);
  for (const u of clone.querySelectorAll('ul')) u.remove();
  return !!clone.querySelector('b, strong');
}

/**
 * Parse one TD cell → { winner: string|null, nominees: string[] }.
 *
 * Handles both the canonical nested format (outer <li> = winner, inner <ul>
 * = nominees) AND the rare flat format where everything is at the same
 * level (winner identified by <b>).
 */
function parseCell(td) {
  const winners = [];
  const nominees = [];

  const outerUls = Array.from(td.children).filter((c) => c.tagName === 'UL');
  if (outerUls.length === 0) {
    // No structure — try to parse as a single bolded line.
    const txt = td.textContent.replace(/\[\s*\d+\s*\]/g, '').trim();
    if (txt && !/^\s*(?:No award|—|–|TBD)\s*$/i.test(txt)) {
      return { winner: txt, nominees: [txt] };
    }
    return { winner: null, nominees: [] };
  }

  for (const ul of outerUls) {
    for (const li of Array.from(ul.children).filter((c) => c.tagName === 'LI')) {
      const show = extractShow(li);
      if (show) {
        if (isWinnerLi(li)) winners.push(show);
        else nominees.push(show);
      }
      // Recurse into nested <ul>: those are the nominees under a winner.
      const nestedUls = Array.from(li.children).filter((c) => c.tagName === 'UL');
      for (const nested of nestedUls) {
        for (const sub of Array.from(nested.children).filter((c) => c.tagName === 'LI')) {
          const subShow = extractShow(sub);
          if (subShow) nominees.push(subShow);
        }
      }
    }
  }

  // Winners are also implicitly nominees.
  for (const w of winners) if (!nominees.includes(w)) nominees.push(w);

  const uniqWinners = Array.from(new Set(winners));
  const uniqNominees = Array.from(new Set(nominees));
  return {
    winner: uniqWinners[0] || null,
    winners: uniqWinners.length > 1 ? uniqWinners : undefined,
    nominees: uniqNominees,
  };
}

/**
 * Extract all category entries from a WOS year page.
 *
 * @param {string} html
 * @param {number} year - the ceremony year (e.g. 2024)
 * @returns {Array<{category: string, year: number, winner: string|null, nominees: string[]}>}
 */
function extractYearEntries(html, year) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const tables = doc.querySelectorAll('table.wikitable');
  const out = [];

  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tbody > tr'));
    let pendingCategories = null;

    for (const row of rows) {
      const children = Array.from(row.children).filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
      if (children.length === 0) continue;

      const allTh = children.every((c) => c.tagName === 'TH');
      const allTd = children.every((c) => c.tagName === 'TD');

      if (allTh) {
        // Header row: capture category names for the next data row.
        pendingCategories = children.map((th) =>
          th.textContent.replace(/\[\s*\d+\s*\]/g, '').replace(/\s+/g, ' ').trim()
        );
        continue;
      }

      if (allTd && pendingCategories && children.length === pendingCategories.length) {
        for (let i = 0; i < children.length; i++) {
          const category = pendingCategories[i];
          if (!category) continue; // skip blank-header cells
          // Drop bookkeeping pseudo-categories from pre-2008 "Theatregoers' Choice
          // Awards" pages — those use a 3-column "Category | Winner | % of Vote"
          // layout the paired-column parser misreads as 3 separate awards.
          if (/^(Category|Winner|% of Vote)$/i.test(category)) continue;
          const { winner, winners, nominees } = parseCell(children[i]);
          const entry = { category, year, winner, nominees };
          if (winners) entry.winners = winners;
          out.push(entry);
        }
        pendingCategories = null;
      }
    }
  }

  return out;
}

module.exports = {
  fetchWOSPage,
  extractYearEntries,
  parseCell,
  extractShow,
  isWinnerLi,
};
