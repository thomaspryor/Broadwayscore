#!/usr/bin/env node
'use strict';

/**
 * press-night-audit-summary.js — prints the press-night verdicts for the morning-after audit
 * (BRO-6067). One verdict line per show that opened on --night, then every gate's line.
 * A show with no record is UNKNOWN, never PASS. Pure reader over data/audit/press-night.
 *
 * Usage: node scripts/press-night-audit-summary.js --night=YYYY-MM-DD
 */
const path = require('path');
const { pressNightResults } = require('./lib/press-night-audit-note');

const RANK = { FAIL: 2, UNKNOWN: 1, PASS: 0 };

function formatSummary(results) {
  if (!results.length) return 'Press-night record: UNKNOWN (no shows or records found for that night)';
  const worst = results.reduce((w, r) => (RANK[r.verdict] > RANK[w] ? r.verdict : w), 'PASS');
  const lines = [`Press-night record: ${worst}`];
  for (const r of results) {
    lines.push('', `${r.showId} ${r.night}: ${r.verdict}`);
    for (const g of r.gates || []) lines.push(`  ${g.name} ${String(g.status).toUpperCase()}: ${g.detail}`);
  }
  return lines.join('\n');
}

function main() {
  const arg = process.argv.slice(2).find(a => a.startsWith('--night='));
  const night = arg && arg.slice(8);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night || '')) {
    console.log('Press-night record: UNKNOWN (usage: --night=YYYY-MM-DD)');
    process.exit(2);
  }
  const root = process.env.PRESS_NIGHT_ROOT || path.join(__dirname, '..');
  const raw = require(path.join(root, 'data/shows.json'));
  const shows = (Array.isArray(raw) ? raw : raw.shows).filter(s => s.openingDate === night);
  const results = pressNightResults({ nights: [night], dir: path.join(root, 'data/audit/press-night'), shows });
  console.log(formatSummary(results));
}

if (require.main === module) main();
module.exports = { formatSummary };
