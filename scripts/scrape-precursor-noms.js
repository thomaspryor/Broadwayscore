#!/usr/bin/env node
/**
 * Scrape per-category nominee lists from Wikipedia for the 3 in-scope Tony
 * seasons (2022-23, 2023-24, 2024-25). Emits JS const-array snippets ready
 * to paste into scripts/enrich-awards-with-precursors.js.
 *
 * Uses the MediaWiki API (action=parse&prop=wikitext) → no LLM noise.
 * Wikitable parsing extracts {category, nominees[]} per row.
 *
 * Sources (3 precursors × 3 ceremony years):
 *   2024-25 season → 69th Drama Desk (2025), OCC 2024-25, 91st Drama League (2025)
 *   2023-24 season → 68th Drama Desk (2024), OCC 2023-24, 90th Drama League (2024)
 *   2022-23 season → 67th Drama Desk (2023), OCC 2022-23, 89th Drama League (2023)
 *
 * Usage:
 *   node scripts/scrape-precursor-noms.js          # all 9 pages
 *   node scripts/scrape-precursor-noms.js DD 2025  # one page
 */

const https = require('https');

const PAGES = [
  // [precursor, ceremonyYear, wikipedia-page-title]
  ['DD', 2025, '69th_Drama_Desk_Awards'],
  ['DD', 2024, '68th_Drama_Desk_Awards'],
  ['DD', 2023, '67th_Drama_Desk_Awards'],
  ['OCC', 2025, '2024–25_Outer_Critics_Circle_Awards'],
  ['OCC', 2024, '2023–24_Outer_Critics_Circle_Awards'],
  ['OCC', 2023, '2022–23_Outer_Critics_Circle_Awards'],
  ['DL', 2025, '91st_Drama_League_Awards'],
  ['DL', 2024, '90th_Drama_League_Awards'],
  ['DL', 2023, '89th_Drama_League_Awards'],
];

// Tier 2/3 categories we care about (per-precursor canonical names).
// Wikipedia uses slight variations; we match by regex substring.
const TARGET_CATEGORIES = {
  DD: [
    /Outstanding Direction of a (Musical|Play)$/,
    /Outstanding Book of a Musical$/,
    /Outstanding Music$/,
    /Outstanding Lyrics$/,
    /Outstanding Orchestrations$/,
    /Outstanding Choreography$/,
    /Outstanding (Lead|Featured) Performance in a (Musical|Play)$/,
    // Older / gendered naming convention sometimes used
    /Outstanding (Actor|Actress) in a (Musical|Play)$/,
    /Outstanding Featured (Actor|Actress) in a (Musical|Play)$/,
  ],
  OCC: [
    /Outstanding Director of a (Musical|Play)$/,
    /Outstanding Book of a Musical$/,
    /Outstanding New Score$/,
    /Outstanding (Actor|Actress) in a (Musical|Play)$/,
    /Outstanding Featured (Actor|Actress) in a (Musical|Play)$/,
    /Outstanding Choreographer$/,
    /Outstanding Orchestrations$/,
  ],
  DL: [
    /Outstanding Direction of a (Musical|Play)$/,
    /Distinguished Performance/,
  ],
};

function fetchWikitext(title) {
  return new Promise((resolve, reject) => {
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&format=json&prop=wikitext`;
    https.get(url, { headers: { 'User-Agent': 'broadway-scorecard/1.0 (research)' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const wt = data?.parse?.wikitext?.['*'];
          if (!wt) return reject(new Error(`No wikitext for ${title}: ${body.slice(0, 200)}`));
          resolve(wt);
        } catch (e) {
          reject(new Error(`Parse error for ${title}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Parse a wikitable row pair: "| '''[[Drama Desk Award for X|X]]'''\n| \n*''Title'' details..."
 * Returns { category, nominees: [{title, raw}] }
 */
function parseTableRows(wt) {
  // Tables are bounded by {| ... |}
  // Each row separator is |- or {|
  // Within a row, the first cell is the category, second is nominees list
  const out = [];

  // Naive extraction: find every block that starts with "| '''" (category cell)
  // and grab text until next "|-" or "|}"
  const rowRegex = /\|\s*'''(.*?)'''\s*\|([^]*?)(?=\n\|-|\n\|\})/g;
  let m;
  while ((m = rowRegex.exec(wt)) !== null) {
    const categoryRaw = m[1];
    const nomineesRaw = m[2];
    // Strip wiki links from category: [[Page|Display]] → Display
    let category = categoryRaw.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').trim();
    // Strip remaining markdown
    category = category.replace(/'+/g, '').trim();

    // Nominees: each starts with *
    const nominees = [];
    const lines = nomineesRaw.split('\n');
    for (const line of lines) {
      const lm = line.match(/^\*+\s*(.+?)\s*$/);
      if (!lm) continue;
      let text = lm[1].trim();
      if (!text) continue;
      // Extract show titles: italicized text ''...'' which may wrap a wikilink [[Title|Display]] or [[Title]].
      // For acting categories the format is "[[Actor]] – ''[[Show]]''" — show is the LAST italic block.
      // For Best Play it's "''Show'' by Author" — show is the FIRST italic block.
      // Strategy: find ALL italic blocks; take the LAST one (works for both).
      const titles = [];
      // Strip bold (''') from the line entirely. Bold-italic ('''''...''''') becomes
      // italic (''...''), bold ('''...''') becomes plain text. Real italics ('') stay.
      // This handles the winner-line case where show is wrapped in '''[[Actor]] – ''[[Show]]'''.
      const noBold = text.replace(/'''/g, '');
      const italicRegex = /''([^']+?)''/g;
      let im;
      while ((im = italicRegex.exec(noBold)) !== null) {
        let raw = im[1].trim();
        // Strip wikilink: [[Page|Display]] or [[Page]]
        const linkMatch = raw.match(/^\[\[([^\]]+)\]\]$/);
        if (linkMatch) {
          raw = linkMatch[1];
          if (raw.includes('|')) raw = raw.split('|').pop();
        }
        if (raw.length < 2) continue;
        if (/^[\s,;:.]+$/.test(raw)) continue;
        titles.push(raw.trim());
      }
      const title = titles.length > 0 ? titles[titles.length - 1] : null;
      // Mark winner if line contains a wikilink to the show ALSO appearing in the italicized block
      // followed by a separator like ''' (bold) or (winner)
      const isWinner = /\(winner/i.test(text);
      nominees.push({ title, raw: text, isWinner });
    }

    if (nominees.length > 0) {
      out.push({ category, nominees });
    }
  }

  return out;
}

function matchesTarget(category, precursor) {
  const patterns = TARGET_CATEGORIES[precursor] || [];
  return patterns.some(p => p.test(category));
}

async function processPage(precursor, year, pageTitle) {
  console.log(`\n## ${precursor} ${year} — ${pageTitle}`);
  let wt;
  try {
    wt = await fetchWikitext(pageTitle);
  } catch (e) {
    console.error(`  ✗ fetch failed: ${e.message}`);
    return null;
  }
  const rows = parseTableRows(wt);
  const targeted = rows.filter(r => matchesTarget(r.category, precursor));
  const out = {};
  for (const r of targeted) {
    const titles = r.nominees.map(n => n.title).filter(Boolean);
    if (titles.length === 0) continue;
    // Find winner
    const winnerObj = r.nominees.find(n => n.isWinner);
    const winner = winnerObj?.title || null;
    out[r.category] = { year, winner, nominees: titles };
  }
  // Print summary
  console.log(`  (${targeted.length} targeted categories from ${rows.length} total rows)`);
  for (const [cat, info] of Object.entries(out)) {
    console.log(`  ${cat}: ${info.nominees.length} noms (winner: ${info.winner || '?'})`);
  }
  return { precursor, year, pageTitle, categories: out };
}

async function main() {
  const arg = process.argv.slice(2);
  const filterPrecursor = arg[0];
  const filterYear = arg[1] ? parseInt(arg[1], 10) : null;
  const results = [];
  for (const [precursor, year, pageTitle] of PAGES) {
    if (filterPrecursor && precursor !== filterPrecursor) continue;
    if (filterYear && year !== filterYear) continue;
    const r = await processPage(precursor, year, pageTitle);
    if (r) results.push(r);
  }
  const outFile = require('path').join(__dirname, '..', 'data/audit/scraped-precursor-noms.json');
  require('fs').writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${outFile} (${results.length} pages scraped)`);
}

main().catch(e => { console.error(e); process.exit(1); });
