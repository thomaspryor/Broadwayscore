#!/usr/bin/env node
/**
 * audit-title-quality.js (BRO-3915): permanent version of the ad-hoc title
 * audit. Buckets shows.json titles by artifact class so short ALL-CAPS titles
 * (which title-display-case.js deliberately leaves alone, so validate-data
 * never flags them) stay visible. Report only; exit 0.
 *   node scripts/audit-title-quality.js [--json]
 */
const fs = require('fs');
const path = require('path');
const { KEEP_SHOUTED_IDS } = require('./lib/title-display-case');

function bucketTitles(shows) {
  const b = { allcaps1to2w: [], allcaps3plus: [], allLower: [], doubleSpace: [], entities: [], urlFragment: [] };
  for (const s of shows) {
    const t = s && s.title;
    if (typeof t !== 'string') continue;
    const words = t.trim().split(/\s+/).filter(Boolean);
    const letters = t.replace(/[^\p{L}]/gu, '');
    const row = `${s.id} | ${t}`;
    if (/^[?#]|=/.test(t)) b.urlFragment.push(row);
    if (/&(amp|lt|gt|quot|#\d+);/.test(t)) b.entities.push(row);
    if (/\s{2,}/.test(t)) b.doubleSpace.push(row);
    if (letters && letters === letters.toLowerCase() && letters !== letters.toUpperCase()) b.allLower.push(row);
    if (letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
      const kept = KEEP_SHOUTED_IDS && (KEEP_SHOUTED_IDS.has ? KEEP_SHOUTED_IDS.has(s.id) : KEEP_SHOUTED_IDS.includes(s.id));
      if (!kept) (words.length >= 3 ? b.allcaps3plus : b.allcaps1to2w).push(row);
    }
  }
  return b;
}

if (require.main === module) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const b = bucketTitles(raw.shows || Object.values(raw));
  if (process.argv.includes('--json')) console.log(JSON.stringify(b, null, 2));
  else for (const [k, v] of Object.entries(b)) { console.log(`${k}: ${v.length}`); v.slice(0, 40).forEach(r => console.log(`  ${r}`)); }
}
module.exports = { bucketTitles };
