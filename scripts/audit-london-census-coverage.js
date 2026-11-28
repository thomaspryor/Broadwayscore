#!/usr/bin/env node
/**
 * audit-london-census-coverage.js — acceptance check for the London outlet
 * census (BRO-6488, armed by BRO-5456).
 *
 * Exit 0 iff every outlet in LONDON_SOURCES (scripts/lib/outlet-census-sources.js)
 * has a census report at data/audit/outlet-census/london/<id>.report.json,
 * which `node scripts/outlet-census.js --market=london` writes. Exit 1 lists
 * the outlets with no report. An outlet the census cannot read ('unreadable')
 * still needs a report or a removal from LONDON_SOURCES with its reason: the
 * card's bar is a census for every London T1-T3 outlet, not for the easy ones.
 *
 * Read-only: no writes, spawns or network. Exit 2 when the source list
 * cannot be read (never a pass).
 *
 * Usage: node scripts/audit-london-census-coverage.js [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
// Not require()d: outlet-census-sources.js pulls outlet-ground-truth.js and with
// it the scraper graph, which audit-safe-form-allowlist.js (rightly) refuses for
// an unattended acceptance command. The keys are read from the source text
// instead; the unit test pins this parse to the real module's keys.
const SOURCES_FILE = path.join(__dirname, 'lib', 'outlet-census-sources.js');
const REPORT_DIR = path.join(__dirname, '..', 'data', 'audit', 'outlet-census', 'london');

/**
 * PURE. Top-level keys of the `const LONDON_SOURCES = { ... };` literal in
 * outlet-census-sources.js source text: lines indented exactly two spaces that
 * open with `id:` or `'id':`. Returns [] when the block is not found, which
 * main() treats as cannot-verify.
 */
function londonSourceIdsFromText(text) {
  const m = /^const LONDON_SOURCES = \{\n([\s\S]*?)^\};/m.exec(String(text || ''));
  if (!m) return [];
  const ids = [];
  for (const line of m[1].split('\n')) {
    const k = /^  (?:'([a-z0-9-]+)'|([A-Za-z0-9_]+)):/.exec(line);
    if (k) ids.push(k[1] || k[2]);
  }
  return ids;
}

/** PURE. The ids with no report, given an existence predicate. */
function missingLondonReports(ids, reportExists) {
  return (ids || []).filter((id) => !reportExists(id));
}

function main(argv) {
  const ids = londonSourceIdsFromText(fs.readFileSync(SOURCES_FILE, 'utf8'));
  if (!ids.length) {
    console.error('[audit-london-census-coverage] could not read LONDON_SOURCES from scripts/lib/outlet-census-sources.js; cannot verify');
    return 2;
  }
  const missing = missingLondonReports(ids, (id) => fs.existsSync(path.join(REPORT_DIR, `${id}.report.json`)));
  const total = ids.length;
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ total, covered: total - missing.length, missing }, null, 2));
  } else if (missing.length) {
    console.log(`[audit-london-census-coverage] FAIL: ${missing.length} of ${total} London outlets have no census report: ${missing.join(', ')}`);
  } else {
    console.log(`[audit-london-census-coverage] PASS: all ${total} London outlets have a census report`);
  }
  return missing.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { missingLondonReports, londonSourceIdsFromText };
