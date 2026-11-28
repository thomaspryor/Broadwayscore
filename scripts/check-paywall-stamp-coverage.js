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
 *   --strict exits 1 when another outlet carries a subscriber-paywall stamp.
 *   A stamp that no longer matches its text is a released recovery, not an error.
 */
const fs = require('fs');
const path = require('path');
const { isPaywalledText } = require('./lib/paywall-detector');

const POS = /^pagesonstages\.com$/; // same exact-host rule as detectSubscriberPaywall
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** @param {Array<{file:string,data:object}>} records */
function summarizeStamps(records) {
  const out = { pagesOnStages: 0, stamped: 0, unstamped: 0, staleStamps: [], falseFlags: [] };
  for (const { file, data } of records) {
    const host = hostOf(data && data.url);
    const isPos = POS.test(host);
    const flagged = !!(data && data.paywalled === true);
    if (isPos) {
      out.pagesOnStages++;
      if (flagged && isPaywalledText(data)) out.stamped++;
      else if (flagged) out.staleStamps.push(file); // recovered body released the stamp: informational
      else out.unstamped++;
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
  if (!fs.existsSync(dir)) { console.error(`review-texts not found at ${dir} (absent in worktrees; pass the main checkout's data/review-texts)`); process.exit(2); }
  const s = summarizeStamps(loadRecords(dir));
  console.log(`pagesonstages files: ${s.pagesOnStages}, stamped: ${s.stamped}, unstamped: ${s.unstamped}, released (recovered) stamps: ${s.staleStamps.length}, false flags on other outlets: ${s.falseFlags.length}`);
  for (const f of s.falseFlags) console.log(`  FALSE FLAG ${f}`);
  if (process.argv.includes('--strict') && s.falseFlags.length) process.exit(1);
}

module.exports = { summarizeStamps };
