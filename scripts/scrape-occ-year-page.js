#!/usr/bin/env node
/**
 * Scrape Outer Critics Circle Awards YEAR-page wikitexts for the gap years
 * (2022-2025) where the per-category Wikipedia pages don't have those
 * ceremonies broken out separately.
 *
 * Format of each year page (verified on 2022/2023/2024/2025):
 *   ==Winners and nominees==
 *   {| class="wikitable"
 *   | '''[[OCC Award for Category|Category]]'''
 *   | * '''''[[Winner Show]]'''''
 *   * ''[[Nominee Show 1]]''
 *   * ''[[Nominee Show 2]]''
 *   |-
 *   ...
 *
 * Output is per-year-keyed-by-category, MERGE-merged into
 * data/precursors/outer-critics.json so existing per-category-page data
 * (which covers older years cleanly) is preserved.
 *
 * Usage:
 *   node scripts/scrape-occ-year-page.js              # dry-run all gap years
 *   node scripts/scrape-occ-year-page.js --write
 *   node scripts/scrape-occ-year-page.js --year=2024 --write
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
} = require('./lib/precursor-wikipedia');

const GAP_YEARS = [2022, 2023, 2024, 2025];
const WRITE = process.argv.includes('--write');
const YEAR_ARG = process.argv.find((a) => a.startsWith('--year='));
const YEARS = YEAR_ARG ? [parseInt(YEAR_ARG.split('=')[1], 10)] : GAP_YEARS;

/** Pull category name from the first cell of a row: pattern is
 *  `'''[[Outer Critics Circle Award for X|X]]'''` OR `'''[X]'''`. */
function extractCategory(firstCell) {
  // First try to find a wikilink with the OCC prefix and pipe alias.
  const m1 = firstCell.match(/\[\[(?:Outer Critics Circle [^\]|]*\|)?([^\]]+)\]\]/);
  if (m1) return cleanWikiText(m1[1].split('|').pop()).trim();
  // Fallback: extract bold text minus markup.
  const bold = firstCell.match(/'''([^']+(?:[^'][^']*)*?)'''/);
  if (bold) return cleanWikiText(bold[1]).trim();
  return cleanWikiText(firstCell).trim();
}

/** From the winner+nominees cell, return { winner, nominees }.
 *  - Winner = first bullet whose text is wrapped in '''''five quotes'''''
 *  - Nominees = all bullet show titles (italic-wrapped wikilinks), winner included once. */
function parseWinnersNomineesCell(cellText) {
  // Two bullet formats appear across years:
  //   2022/2024/2025: `* item1\n* item2\n...`
  //   2023:           `{{bulleted list |item1|item2|...}}`
  // Convert the template form into a `* item` stream first so the same
  // splitter handles both.
  let normalized = cellText;
  const tmpl = normalized.match(/\{\{\s*bulleted list\s*\|([\s\S]+?)\}\}/i);
  if (tmpl) {
    const items = tmpl[1]
      .split(/(?<!\[\[[^\]]*)\|(?![^[]*\]\])/) // split on `|` not inside [[...]]
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
  /**
   * Extract the SHOW title from a bullet. Person+show categories (Director,
   * Featured Performer, etc.) use the format `[[Person]], ''[[Show]]''`, so
   * the show is always wrapped in italics — we prefer that over the first
   * wikilink (which would be the person).
   *   - Show-only categories (Production, Revival): `'''''[[Show]]'''''`
   *   - Person+show: `'''[[Person]], ''[[Show]]'''''` (winner) or
   *                  `Person, ''[[Show]]''` (nominee)
   *   - Person+plain-show: `Person, ''Show''`
   */
  function bulletTitle(b) {
    // 1) Italic-linked title: ''[[Show]]'' or ''[[Show|Display]]''
    const italicLink = b.match(/''\[\[([^\]|]+)(?:\|[^\]]+)?\]\]''/);
    if (italicLink) return cleanTitle(italicLink[1]);
    // 2) Italic plain-text title: ''Show'' — allow internal apostrophes
    //    (Clyde's, A Doll's House) but not consecutive doubles (which would
    //    indicate the italic boundary itself).
    const italicPlain = b.match(/''([^'\n]+(?:'[^'\n]+)*?)''/);
    if (italicPlain) {
      const t = cleanTitle(italicPlain[1]);
      if (t && t.length > 1) return t;
    }
    // 3) Bare wikilink (show-only categories where show isn't italic-wrapped,
    //    or person-only categories like Special Achievement Award).
    const bareLink = b.replace(/'+/g, '').match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
    if (bareLink) return cleanTitle(bareLink[1]);
    // 4) Last resort — plain text after the bullet, take up to first comma.
    return cleanWikiText(b.replace(/'+/g, '')).replace(/^([^,]+),.*/, '$1').trim();
  }

  /** Extract person name from a bullet in person+show format: [[Person]], ''[[Show]]''.
   *  Returns null for show-only categories. */
  function bulletPersonName(b) {
    // Wikilink person before `, ''`: [[Person]], ''[[Show]]'' or [[Person Name]], ''Show''
    const m = b.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*,\s*''/);
    if (m) return cleanTitle(m[2] || m[1]);
    // Plain text person: Person Name, ''[[Show]]''
    const plain = b.match(/^([^[',\n]+),\s*''/);
    if (plain) {
      const t = cleanWikiText(plain[1]).trim();
      if (t && t.length > 2) return t;
    }
    return null;
  }

  let winner = null;
  let winnerPersonName = null;
  const nominees = [];
  for (const b of bullets) {
    const title = bulletTitle(b);
    if (!title) continue;
    if (winner === null && /'{5}/.test(b)) {
      winner = title;
      winnerPersonName = bulletPersonName(b);
    }
    nominees.push(title);
  }
  // De-dup nominees while preserving order.
  const seen = new Set();
  const unique = nominees.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { winner, nominees: unique, winnerPersonName };
}

async function scrapeYear(year) {
  const title = `${year}_Outer_Critics_Circle_Awards`;
  process.stdout.write(`Fetching ${title}... `);
  const wikitext = await fetchWikitext(title);
  if (!wikitext) {
    console.log('MISSING page');
    return {};
  }

  // Find the nominees section — heading varies year-to-year: "Winners and
  // nominees" (2023-25) or "Awards and nominations" (2022). Scope tables to
  // that section so we don't accidentally walk infobox tables or the
  // "Multiple nominations" tally at the bottom.
  const sectionStart = wikitext.search(
    /==\s*(?:Winners and nominees|Awards and nominations|Nominations and winners)\s*==/i,
  );
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
      // Each row has two pipe-delimited cells (after the leading |- splitter).
      // Strip the optional header markers and split cells.
      const trimmed = row.replace(/^\s*\n?/, '');
      if (!trimmed.startsWith('|') && !trimmed.startsWith('!')) continue;
      // Skip header rows.
      if (/^\s*!/.test(trimmed)) continue;
      // Split into cells: each cell starts with `| `; first one drops it.
      const cells = trimmed.split(/\n\s*\|\s*/);
      if (cells.length < 2) continue;
      const firstCell = cells[0].replace(/^\|\s*/, '');
      const restCell = cells.slice(1).join('\n| ');
      const category = extractCategory(firstCell);
      if (!category || !/(?:Outstanding|Best|John Gassner|Special)/i.test(category)) continue;
      const { winner, nominees, winnerPersonName } = parseWinnersNomineesCell(restCell);
      if (nominees.length === 0) continue;
      categories[category] = { year, winner, nominees, ...(winnerPersonName ? { winnerPersonName } : {}) };
      rowCount++;
    }
  }

  console.log(`${rowCount} categories`);
  return categories;
}

/** Merge new per-year-per-category data INTO the existing outer-critics.json
 *  baseline. For each category present in the year-page:
 *   - If the baseline already has an entry for that year, UNION the nominees
 *     and prefer the year-page winner (more authoritative on that ceremony).
 *   - If baseline has no entry for that year (gap fill), insert the new one.
 *  Categories present in the baseline but not in the year page are untouched. */
function mergeYearIntoBaseline(baseline, year, perCategory) {
  const out = JSON.parse(JSON.stringify(baseline));
  for (const [cat, entry] of Object.entries(perCategory)) {
    const list = (out[cat] = out[cat] || []);
    const existing = list.find((e) => e.year === year);
    if (existing) {
      const union = new Set([...(existing.nominees || []), ...entry.nominees]);
      existing.nominees = [...union].sort();
      if (entry.winner && !existing.winner) existing.winner = entry.winner;
      if (entry.winnerPersonName && !existing.winnerPersonName) existing.winnerPersonName = entry.winnerPersonName;
    } else {
      list.push({
        year,
        winner: entry.winner,
        ...(entry.winnerPersonName ? { winnerPersonName: entry.winnerPersonName } : {}),
        nominees: [...entry.nominees].sort(),
      });
      list.sort((a, b) => a.year - b.year);
    }
  }
  return out;
}

async function main() {
  const fp = path.join(PRECURSORS_DIR, 'outer-critics.json');
  const baseline = fs.existsSync(fp)
    ? JSON.parse(fs.readFileSync(fp, 'utf8')).data
    : {};

  let merged = JSON.parse(JSON.stringify(baseline));
  const summary = [];
  for (const year of YEARS) {
    const per = await scrapeYear(year);
    const before = Object.values(merged).reduce(
      (s, list) => s + list.filter((e) => e.year === year).reduce((ss, e) => ss + (e.nominees || []).length, 0),
      0,
    );
    merged = mergeYearIntoBaseline(merged, year, per);
    const after = Object.values(merged).reduce(
      (s, list) => s + list.filter((e) => e.year === year).reduce((ss, e) => ss + (e.nominees || []).length, 0),
      0,
    );
    const newCats = Object.keys(per).filter(
      (c) => !(baseline[c] || []).some((e) => e.year === year),
    );
    summary.push({ year, before, after, delta: after - before, newCategories: newCats.length });
    await sleep(RATE_LIMIT_MS);
  }

  console.log('\nPer-year delta (nominees in outer-critics.json):');
  for (const s of summary) {
    console.log(
      `  ${s.year}: ${s.before} -> ${s.after} (+${s.delta} nominees, ${s.newCategories} categories not in baseline for this year)`,
    );
  }

  writePrecursorJson('outer-critics', merged, {
    force: true,
    dryRun: !WRITE,
    meta: {
      sourcePages: YEARS.map((y) => `${y}_Outer_Critics_Circle_Awards`),
      mergeMode: 'union-nominees-per-year',
      addedAt: new Date().toISOString(),
    },
  });

  if (!WRITE) console.log('\n(dry-run; pass --write to commit)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
