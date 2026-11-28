#!/usr/bin/env node
'use strict';
/**
 * BRO-8418: BRO-8264 stamps the Pages on Stages wall only at fetch time, so
 * files stored before it carry no stamp. After a forced re-fetch through the
 * collector this reports, per stored review file: how many Pages on Stages
 * files are stamped (and still hash-bound to their text) and whether any other
 * outlet was stamped by mistake.
 *
 * Usage: node scripts/audit-paywall-stamp-coverage.js [reviewTextsDir] [--strict]
 *   --strict exits 1 when another outlet carries a subscriber-paywall stamp, or
 *   when a stamp no longer matches its text.
 */
const fs = require('fs');
const path = require('path');
const { isPaywalledText } = require('./lib/paywall-detector');

const POS = /(^|\.)pagesonstages\.com$/;
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** @param {Array<{file:string,data:object}>} records */
function summarizeStamps(records) {
  const out = { pagesOnStages: 0, stamped: 0, staleStamps: [], falseFlags: [] };
  for (const { file, data } of records) {
    const host = hostOf(data && data.url);
    const isPos = POS.test(host);
    const flagged = !!(data && data.paywalled === true);
    if (isPos) {
      out.pagesOnStages++;
      if (flagged && isPaywalledText(data)) out.stamped++;
      else if (flagged) out.staleStamps.push(file);
    } else if (flagged && data.paywallTextHash) {
      // Only the subscriber-paywall stamp carries a text hash; other outlets must not.
      out.falseFlags.push(file);
    }
  }
  return out;
}

function loadRecords(dir) {
  const recs = [];
  for (const d of fs.readdirSync(dir)) {
    if (d.startsWith('_')) continue;
    let files;
    try { files = fs.readdirSync(path.join(dir, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { recs.push({ file: `${d}/${f}`, data: JSON.parse(fs.readFileSync(path.join(dir, d, f), 'utf8')) }); } catch { /* skip */ }
    }
  }
  return recs;
}

if (require.main === module) {
  const dir = process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'data', 'review-texts');
  const s = summarizeStamps(loadRecords(dir));
  console.log(`pagesonstages files: ${s.pagesOnStages}, stamped: ${s.stamped}, stale stamps: ${s.staleStamps.length}, false flags on other outlets: ${s.falseFlags.length}`);
  for (const f of s.falseFlags) console.log(`  FALSE FLAG ${f}`);
  for (const f of s.staleStamps) console.log(`  STALE ${f}`);
  if (process.argv.includes('--strict') && (s.falseFlags.length || s.staleStamps.length)) process.exit(1);
}

module.exports = { summarizeStamps };
