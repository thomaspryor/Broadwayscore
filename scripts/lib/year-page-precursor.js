#!/usr/bin/env node
/**
 * Shared template for Wikipedia YEAR-PAGE precursor scrapers.
 *
 * Pulls one Wikipedia page per ceremony year (e.g. `2024_Outer_Critics_Circle_Awards`,
 * `70th_Drama_Desk_Awards`, `92nd_Drama_League_Awards`). Each page renders
 * categories as wikitable rows with bullet-listed winner+nominees cells. The
 * winner bullet uses `'''''Show'''''` (five-quote bold-italic); person+show
 * categories use `'''[[Person]], ''[[Show]]'''''`.
 *
 * The companion per-category scrapers in scripts/scrape-{drama-desk,drama-league,
 * outer-critics}.js fetch Wikipedia category pages, where the winner is stored
 * as PERSON-NAME with show pairing lost — the enrich step's adjacency rule
 * then misattributes craft/acting wins to the wrong show. Year-page data has
 * `winner=Show` + `winnerPersonName=Person` for the same row, so enrich
 * resolves correctly.
 *
 * Usage (from a caller script):
 *   const { runYearPageScraper } = require('./lib/year-page-precursor');
 *   await runYearPageScraper({
 *     ceremonyName: 'drama-desk',
 *     pageTitleFn: (year) => `${year - 1956}th_Drama_Desk_Awards`,
 *     years: [2024, 2025, 2026],
 *     sectionHeadings: /==\s*(?:Winners and nominees|Awards and nominations)\s*==/i,
 *     categoryPrefixRe: /(?:Outstanding|Best|John Gassner|Special)/i,
 *     minCategoriesPerYear: 10,   // hard-fail if a year returns <N categories (format drift)
 *     write: true,
 *     force: false,
 *   });
 *
 * SAFETY:
 *   - minCategoriesPerYear refuses to write if any scraped year falls below
 *     the threshold. Prevents silent corruption when Wikipedia page format
 *     drifts (Pre-mortem reviewer P0).
 *   - Existing nominees in baseline are UNIONED with new year-page nominees
 *     for the same year, then writePrecursorJson applies its own
 *     same-year-override / other-year-preserve logic.
 *   - 5% shrink guard from writePrecursorJson still applies.
 */

const fs = require('fs');
const path = require('path');
const {
  fetchWikitext,
  cleanWikiText,
  extractTables,
  splitRows,
  writePrecursorJson,
  sleep,
  RATE_LIMIT_MS,
  PRECURSORS_DIR,
} = require('./precursor-wikipedia');

/** Pull category name from the first cell of a row.
 *  Pattern is `'''[[Ceremony Award for X|X]]'''` OR `'''[X]'''`. */
function extractCategory(firstCell) {
  // First try to find a wikilink with optional pipe alias.
  const m1 = firstCell.match(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/);
  if (m1) return cleanWikiText(m1[1].split('|').pop()).trim();
  // Fallback: extract bold text minus markup.
  const bold = firstCell.match(/'''([^']+(?:[^'][^']*)*?)'''/);
  if (bold) return cleanWikiText(bold[1]).trim();
  return cleanWikiText(firstCell).trim();
}

/** From the winner+nominees cell, return { winner, nominees, winnerPersonName }.
 *  Two bullet formats appear across years:
 *    YYYY/OCC-2022-2025: `* item1\n* item2\n...`
 *    OCC-2023:           `{{bulleted list |item1|item2|...}}`
 *  Winner row has '''''five quotes''''' wrapping the bold-italic show. */
function parseWinnersNomineesCell(cellText) {
  let normalized = cellText;
  const tmpl = normalized.match(/\{\{\s*bulleted list\s*\|([\s\S]+?)\}\}/i);
  if (tmpl) {
    const items = tmpl[1]
      .split(/(?<!\[\[[^\]]*)\|(?![^[]*\]\])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    normalized = items.map((i) => `* ${i}`).join('\n');
  }

  const bullets = normalized
    .split(/\n\s*\*\s*/)
    .map((s) => s.replace(/^\s*\*\s*/, '').trim())
    .filter((s) => s.length > 0);

  function cleanTitle(raw) {
    return cleanWikiText(raw)
      .replace(/\s*\((?:musical|play|opera|ballet|revival|film|TV series)\)\s*$/i, '')
      .trim();
  }

  /** Extract the SHOW title from a bullet. */
  function bulletTitle(b) {
    // 1) Italic-linked title: ''[[Show]]'' or ''[[Target|Display]]''
    //    When pipe alias is present, prefer the DISPLAY text — link targets
    //    are often disambiguators (e.g. "Cats (musical)") that cleanTitle then
    //    strips to "Cats" instead of the canonical "Cats: The Jellicle Ball".
    const italicLink = b.match(/''\[\[([^\]|]+)(?:\|([^\]]+))?\]\]''/);
    if (italicLink) return cleanTitle(italicLink[2] || italicLink[1]);
    // 1.5) Bold-italic combo for winner row with UNLINKED show:
    //      `'''Person, ''Show'''''` or `'''Person ''Show'''''`. Step 2's italic
    //      regex confuses the outer `'''` for italic. Match the inner italic
    //      explicitly so we don't capture the person name.
    const boldItalicCombo = b.match(/'''[^']+?,?\s*''([^'\n]+?)'''''/);
    if (boldItalicCombo) {
      const t = cleanTitle(boldItalicCombo[1]);
      if (t && t.length > 1) return t;
    }
    // 1.6) Show-only winner row (no person): `'''''Show'''''`
    const boldItalicOnly = b.match(/'''''([^'\n]+?)'''''/);
    if (boldItalicOnly) {
      const t = cleanTitle(boldItalicOnly[1]);
      if (t && t.length > 1) return t;
    }
    // 2) Italic plain-text title: ''Show''
    const italicPlain = b.match(/''([^'\n]+(?:'[^'\n]+)*?)''/);
    if (italicPlain) {
      const t = cleanTitle(italicPlain[1]);
      if (t && t.length > 1) return t;
    }
    // 3) Bare wikilink
    const bareLink = b.replace(/'+/g, '').match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
    if (bareLink) return cleanTitle(bareLink[1]);
    // 4) Last resort — plain text, take up to first comma
    return cleanWikiText(b.replace(/'+/g, '')).replace(/^([^,]+),.*/, '$1').trim();
  }

  /** Extract person name from a bullet in person+show format. */
  function bulletPersonName(b) {
    const m = b.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*,\s*''/);
    if (m) return cleanTitle(m[2] || m[1]);
    const plain = b.match(/^([^[',\n]+),\s*''/);
    if (plain) {
      const t = cleanWikiText(plain[1]).trim();
      if (t && t.length > 2) return t;
    }
    return null;
  }

  /** Extract the SHOW from a winner segment using ONLY italic-anchored cases,
   *  so a bold bare person `'''[[Person]]'''` is never mis-read as a show
   *  (bulletTitle's bareLink/plain fallbacks would return the person name). */
  function bulletShow(seg) {
    const stripped = seg.replace(/(^|\s)'''\[\[[^\]]+\]\]'''(?!')/g, '$1');
    let m = stripped.match(/''\[\[([^\]|]+)(?:\|([^\]]+))?\]\]''/);
    if (m) {
      const t = cleanTitle(m[2] || m[1]);
      if (t && t.length > 1) return t;
    }
    m = stripped.match(/''([^'\n][^'\n]*?)''/);
    if (m) {
      const t = cleanTitle(m[1]);
      if (t && t.length > 1) return t;
    }
    return null;
  }

  /** Person from a winner segment: bold bare link `'''[[Person]]'''`, or the
   *  `[[Person]], ''Show''` / `Person, ''Show''` pair forms. */
  function winnerPerson(seg) {
    let m = seg.match(/(?<!')'''\[\[([^\]|]+)(?:\|([^\]]+))?\]\]'''(?!')/);
    if (m) return cleanTitle(m[2] || m[1]);
    return bulletPersonName(seg);
  }

  /** Parse a WINNER bullet into [{ person, show }]. Handles ties joined by
   *  " and ": both `'''[[A]]''' and '''[[B]]''', ''Show''` (shared production)
   *  and `'''[[A]], ''ShowA''''' and '''[[B]], ''ShowB'''''` (split shows).
   *  person is null for show-only categories (`'''''Show'''''`). */
  function parseWinnerBullet(b) {
    // Split co-winners ONLY on an " and " that sits between two quote-runs
    // (`...''' and '''...` or `...''''' and '''...`) — the boundary between two
    // independently-bold winners in a tie. A collaborative single win lists its
    // people as `[[A]] and [[B]]` (the "and" flanked by brackets/text, not
    // quotes), and show titles like "Joe Turner's Come and Gone" embed "and"
    // mid-text — neither must split. See the team/title cases in
    // tests/unit/awards-person-winner-pairing.test.mjs.
    const segments = b.split(/(?<=')\s+and\s+(?=')/);
    const parsed = segments.map((seg) => ({ person: winnerPerson(seg), show: bulletShow(seg) }));
    const shows = parsed.map((p) => p.show).filter(Boolean);
    const distinct = [...new Set(shows.map((s) => s.toLowerCase()))];
    if (distinct.length === 1) {
      const only = shows[0];
      for (const p of parsed) if (p.person && !p.show) p.show = only;
    }
    return parsed.filter((p) => p.person || p.show);
  }

  const winnerEntries = []; // [{ person, show }] — supports tie co-winners.
  const nominees = [];
  for (const b of bullets) {
    // Winner rows are bold (`'''`); nominee rows use only italic (`''`) for the show.
    if (/'''/.test(b)) {
      const entries = parseWinnerBullet(b);
      if (entries.length > 0) {
        for (const e of entries) {
          winnerEntries.push(e);
          if (e.show) nominees.push(e.show); // keep winner show in nominees (legacy adjacency)
        }
        continue;
      }
    }
    const title = bulletTitle(b);
    if (title) nominees.push(title);
  }
  // De-dup nominees while preserving order.
  const seen = new Set();
  const unique = nominees.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Back-compat scalar fields point at the first winner; winnerEntries carries
  // the full set (so tie co-winners survive — e.g. Henry + Levy, Ragtime 2026).
  const winner = (winnerEntries.find((e) => e.show) || {}).show || null;
  const winnerPersonName = (winnerEntries.find((e) => e.person) || {}).person || null;
  return { winner, nominees: unique, winnerPersonName, winnerEntries };
}

/** Scrape one Wikipedia year page. Returns `{ [category]: { year, winner, winnerPersonName?, nominees } }`. */
async function scrapeYear({ year, pageTitleFn, sectionHeadings, categoryPrefixRe }) {
  const title = pageTitleFn(year);
  process.stdout.write(`Fetching ${title}... `);
  const wikitext = await fetchWikitext(title);
  if (!wikitext) {
    console.log('MISSING page');
    return {};
  }
  const sectionStart = wikitext.search(sectionHeadings);
  if (sectionStart < 0) {
    console.log('no nominees section found');
    return {};
  }
  const sectionEnd = wikitext.indexOf('\n==', sectionStart + 4);
  const section = wikitext.slice(sectionStart, sectionEnd > 0 ? sectionEnd : undefined);
  const tables = extractTables(section);
  if (!tables.length) {
    console.log('no wikitables in section');
    return {};
  }

  const categories = {};
  let rowCount = 0;
  for (const table of tables) {
    const rows = splitRows(table);
    for (const row of rows) {
      const trimmed = row.replace(/^\s*\n?/, '');
      if (!trimmed.startsWith('|') && !trimmed.startsWith('!')) continue;
      if (/^\s*!/.test(trimmed)) continue;
      const cells = trimmed.split(/\n\s*\|\s*/);
      if (cells.length < 2) continue;
      const firstCell = cells[0].replace(/^\|\s*/, '');
      const restCell = cells.slice(1).join('\n| ');
      const category = extractCategory(firstCell);
      if (!category || !categoryPrefixRe.test(category)) continue;
      const { winner, nominees, winnerPersonName, winnerEntries } = parseWinnersNomineesCell(restCell);
      if (nominees.length === 0) continue;
      categories[category] = {
        year,
        winner,
        nominees,
        ...(winnerPersonName ? { winnerPersonName } : {}),
        ...(winnerEntries && winnerEntries.length > 1 ? { winnerEntries } : {}),
      };
      rowCount++;
    }
  }

  console.log(`${rowCount} categories`);
  return categories;
}

/** Year-page is authoritative for winner+person attribution; nominees union with baseline.
 *  Without override, per-category scrape's winner=PERSON-NAME persists and the
 *  buggy adjacency rule keeps misattributing shows. Year-page format pairs
 *  winner show + person correctly, so we trust it. */
function mergeYearIntoBaseline(baseline, year, perCategory) {
  const out = JSON.parse(JSON.stringify(baseline));
  for (const [cat, entry] of Object.entries(perCategory)) {
    const list = (out[cat] = out[cat] || []);
    const existing = list.find((e) => e.year === year);
    if (existing) {
      // Use year-page nominees as authoritative (preserves person→show pair
      // adjacency the enrich step relies on). Don't union with legacy entries
      // because per-category scrapes mix shows+people in the wrong order and
      // sorting them alphabetically destroys the pair adjacency.
      existing.nominees = [...entry.nominees];
      if (entry.winner) existing.winner = entry.winner;
      if (entry.winnerPersonName) existing.winnerPersonName = entry.winnerPersonName;
      // If year-page provides a winner show, clear stale legacy `winners` array
      // (which often holds person names from per-category scrapes).
      if (entry.winner && existing.winners && !entry.winners) delete existing.winners;
      if (entry.winners) existing.winners = entry.winners;
      // Tie co-winners (year-page authoritative). Drop a stale array if this
      // year is no longer a tie.
      if (entry.winnerEntries) existing.winnerEntries = entry.winnerEntries;
      else delete existing.winnerEntries;
    } else {
      list.push({
        year,
        winner: entry.winner,
        ...(entry.winnerPersonName ? { winnerPersonName: entry.winnerPersonName } : {}),
        ...(entry.winnerEntries ? { winnerEntries: entry.winnerEntries } : {}),
        nominees: [...entry.nominees],
      });
      list.sort((a, b) => a.year - b.year);
    }
  }
  return out;
}

/**
 * @param {{
 *   ceremonyName: string,
 *   pageTitleFn: (year: number) => string,
 *   years: number[],
 *   sectionHeadings: RegExp,
 *   categoryPrefixRe?: RegExp,
 *   minCategoriesPerYear?: number,
 *   write: boolean,
 *   force?: boolean,
 * }} config
 */
async function runYearPageScraper(config) {
  const {
    ceremonyName,
    pageTitleFn,
    years,
    sectionHeadings,
    categoryPrefixRe = /(?:Outstanding|Best|John Gassner|Special|Distinguished)/i,
    minCategoriesPerYear = 5,
    write,
    force = false,
  } = config;

  const fp = path.join(PRECURSORS_DIR, `${ceremonyName}.json`);
  const baseline = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')).data : {};

  let merged = JSON.parse(JSON.stringify(baseline));
  const summary = [];
  const formatDriftYears = [];
  const yearTitles = [];

  for (const year of years) {
    const per = await scrapeYear({ year, pageTitleFn, sectionHeadings, categoryPrefixRe });
    const catCount = Object.keys(per).length;
    yearTitles.push(pageTitleFn(year));
    if (catCount > 0 && catCount < minCategoriesPerYear) {
      formatDriftYears.push({ year, catCount, threshold: minCategoriesPerYear });
    }
    const before = Object.values(merged).reduce(
      (s, list) => s + list.filter((e) => e.year === year).reduce((ss, e) => ss + (e.nominees || []).length, 0),
      0,
    );
    merged = mergeYearIntoBaseline(merged, year, per);
    const after = Object.values(merged).reduce(
      (s, list) => s + list.filter((e) => e.year === year).reduce((ss, e) => ss + (e.nominees || []).length, 0),
      0,
    );
    summary.push({ year, catCount, before, after, delta: after - before });
    await sleep(RATE_LIMIT_MS);
  }

  // Hard-fail if format drift detected — Pre-mortem reviewer P0.
  if (formatDriftYears.length > 0 && !force) {
    console.error('\n❌ FORMAT DRIFT detected — at least one year returned fewer categories than threshold:');
    for (const { year, catCount, threshold } of formatDriftYears) {
      console.error(`  ${year}: ${catCount} categories (threshold: ${threshold}). Page may have changed format.`);
    }
    console.error('\nPass --force to override (NOT RECOMMENDED — investigate page format first).');
    process.exit(2);
  }

  console.log('\nPer-year summary:');
  for (const s of summary) {
    console.log(`  ${s.year}: ${s.catCount} categories scraped (${s.before} → ${s.after} nominees)`);
  }

  writePrecursorJson(ceremonyName, merged, {
    force: true, // we already gated above via minCategoriesPerYear
    dryRun: !write,
    meta: {
      sourcePages: yearTitles,
      mergeMode: 'union-nominees-per-year',
      addedAt: new Date().toISOString(),
    },
  });

  if (!write) console.log('\n(dry-run; pass --write to commit)');
}

module.exports = {
  runYearPageScraper,
  // exported for testing
  extractCategory,
  parseWinnersNomineesCell,
  mergeYearIntoBaseline,
  scrapeYear,
};
