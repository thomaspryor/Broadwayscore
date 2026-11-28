#!/usr/bin/env node
'use strict';
/**
 * BRO-7296 dry run: what does the CV wrongProduction build gate change in the shipped data?
 * Runs the full rebuild in advisory mode (nothing held, counts only) and in enforce mode, snapshots the
 * data/reviews.json each one writes, and diffs the two. The honest acceptance number is the diff (rows that
 * would leave the site), not the "would hold" count: a held file that loses a later dedup changes nothing.
 * Needs review-texts (run via cloud-run-script.js --review-texts; writes are discarded).
 * Also runs once with the grandfather off to show the lifetime backlog the gate would have held.
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/dryrun-cv-wp-build-gate.js  (needs review-texts; run via cloud-run-script.js --review-texts)');
  process.exit(0);
}
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const rebuild = path.join(__dirname, 'rebuild-all-reviews.js');
const reviewsPath = path.join(__dirname, '..', 'data', 'reviews.json');
const rowKey = (r) => `${r.showId}::${r.url || ''}::${r.outletId}::${r.criticName || ''}`;

function run(label, env) {
  const r = spawnSync(process.execPath, [rebuild], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 29 });
  const out = r.stdout || '';
  const lines = out.split('\n').filter((l) => l.includes('[CV-WP-BUILD-GATE advisory]'));
  const rows = fs.existsSync(reviewsPath) ? JSON.parse(fs.readFileSync(reviewsPath, 'utf8')).reviews : [];
  console.log(`${label}: exit=${r.status} wouldHold=${lines.length} rows=${rows.length}`);
  return { lines, rows };
}

const adv = run('advisory, grandfathered', { CV_WP_BUILD_GATE: 'advisory' });
adv.lines.slice(0, 40).forEach((l) => console.log('  ' + l.trim().slice(0, 240)));
const enf = run('enforce, grandfathered', { CV_WP_BUILD_GATE: 'enforce' });
const advKeys = new Map(adv.rows.map((r) => [rowKey(r), r]));
const enfKeys = new Set(enf.rows.map(rowKey));
const removed = [...advKeys.keys()].filter((k) => !enfKeys.has(k));
console.log(`ROWS REMOVED BY THE GATE (enforce vs advisory): ${removed.length}`);
removed.slice(0, 60).forEach((k) => console.log('  ' + k.slice(0, 220)));
const all = run('advisory, grandfather off (lifetime backlog)', { CV_WP_BUILD_GATE: 'advisory', CV_WP_BUILD_GATE_GRANDFATHER: 'off' });
console.log(`SUMMARY wouldHoldGrandfathered=${adv.lines.length} rowsRemovedByGate=${removed.length} lifetimeWouldHold=${all.lines.length}`);
