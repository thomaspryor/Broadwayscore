#!/usr/bin/env node
/**
 * Convert scripts/scrape-precursor-noms.js JSON output into JS const-array
 * snippets ready to paste into scripts/enrich-awards-with-precursors.js.
 *
 * Reads data/audit/scraped-precursor-noms.json. Emits one snippet per
 * (precursor, category) suitable for inclusion in DRAMA_DESK / OUTER_CRITICS /
 * DRAMA_LEAGUE const blocks. Winners not detected by the scraper (the bold
 * marker is lost during noBold preprocessing); user should manually mark
 * winners by inspecting Wikipedia.
 */

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'data/audit/scraped-precursor-noms.json');

const PRECURSOR_TO_VAR = {
  DD: 'DRAMA_DESK',
  OCC: 'OUTER_CRITICS',
  DL: 'DRAMA_LEAGUE',
};

function fmtList(arr) {
  return '[' + arr.map(s => JSON.stringify(s)).join(',') + ']';
}

function main() {
  const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const grouped = {};   // precursor → category → [ { year, nominees } ]
  for (const page of data) {
    const p = page.precursor;
    grouped[p] = grouped[p] || {};
    for (const [cat, info] of Object.entries(page.categories)) {
      grouped[p][cat] = grouped[p][cat] || [];
      grouped[p][cat].push({ year: info.year, nominees: info.nominees });
    }
  }

  // Emit const-snippet per precursor → category
  for (const [pre, cats] of Object.entries(grouped)) {
    console.log(`\n// ============ ${pre} (${PRECURSOR_TO_VAR[pre]}) ============`);
    for (const [cat, yearEntries] of Object.entries(cats)) {
      console.log(`\n  '${cat}': [`);
      for (const entry of yearEntries) {
        // No winner — set null. User manually edits after pasting.
        console.log(`    { year: ${entry.year}, winner: null, nominees: ${fmtList(entry.nominees)} },`);
      }
      console.log(`  ],`);
    }
  }
}

main();
