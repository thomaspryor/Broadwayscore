#!/usr/bin/env node
'use strict';

/**
 * audit-form-d-capitalization.js (BRO-5732)
 *
 * Flags commercial.json records whose capitalization equals the maximum of a
 * cited SEC Form D while the filing shows less was sold, and the record does
 * not print as "up to $X" (capitalizationBasis 'maximum'). Advisory: exits 0
 * unless --strict (CLAUDE.md rule 19: arm it only after a clean baseline).
 * Fetches EDGAR (public, no key) through sec-edgar-scraper.
 *
 * Usage: node scripts/audit-form-d-capitalization.js [--json] [--strict] [--show=slug]
 */

const path = require('path');
const { formDXmlUrls, classifyFormDCapitalization } = require('./lib/form-d-capitalization-audit');
const { isMaximumCapitalization } = require('./lib/public-source-text');

async function main() {
  const argv = process.argv.slice(2);
  const only = (argv.find((a) => a.startsWith('--show=')) || '').slice(7);
  const { parseFormDFiling } = require('./lib/sec-edgar-scraper');
  const shows = require(path.join('..', 'data', 'commercial.json')).shows || {};
  const flagged = [];
  let checked = 0;
  let fetchFailures = 0;
  for (const [slug, entry] of Object.entries(shows)) {
    if (!entry || entry.capitalization == null || (only && slug !== only)) continue;
    if (isMaximumCapitalization(entry)) continue;
    const urls = formDXmlUrls(entry);
    if (!urls.length) continue;
    const filings = [];
    for (const url of urls) {
      try { filings.push(await parseFormDFiling(url)); } catch { fetchFailures++; }
    }
    checked++;
    const verdict = classifyFormDCapitalization(entry, filings);
    if (verdict.status !== 'ok') flagged.push({ slug, capitalization: entry.capitalization, ...verdict });
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ checked, fetchFailures, flagged }, null, 1));
  else {
    for (const f of flagged) console.log(`  ${f.slug}: ${f.reason}`);
    console.log(`[audit-form-d-capitalization] ${checked} Form D records checked, ${flagged.length} store the offering maximum as fact, ${fetchFailures} filing fetch(es) failed`);
  }
  if (argv.includes('--strict') && flagged.length) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });
