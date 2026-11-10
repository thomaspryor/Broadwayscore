#!/usr/bin/env node
'use strict';
/**
 * BRO-7296 dry run: how many reviews would the CV wrongProduction build gate hold?
 * Runs the full rebuild twice in advisory mode (no exclusion, only counting). Needs review-texts
 * and the previous data/reviews.json (run via cloud-run-script.js --review-texts; writes are discarded).
 *   grandfathered:   expected 0 for rows already live (no live score moves)
 *   ungrandfathered: the whole lifetime backlog the gate would have held (the BRO-6523 sweep counted 223)
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/dryrun-cv-wp-build-gate.js  (needs review-texts; run via cloud-run-script.js --review-texts)');
  process.exit(0);
}
const { spawnSync } = require('child_process');
const path = require('path');
const rebuild = path.join(__dirname, 'rebuild-all-reviews.js');
function run(label, env) {
  const r = spawnSync(process.execPath, [rebuild], { env: { ...process.env, CV_WP_BUILD_GATE: 'advisory', ...env }, encoding: 'utf8', maxBuffer: 1 << 29 });
  const lines = (r.stdout || '').split('\n').filter((l) => l.includes('[CV-WP-BUILD-GATE advisory]'));
  const byShow = {};
  for (const l of lines) { const m = l.match(/\] (\S+?)\/(\S+): would hold/); if (m) byShow[m[1]] = (byShow[m[1]] || 0) + 1; }
  console.log(`${label}: exit=${r.status} wouldHold=${lines.length} shows=${Object.keys(byShow).length}`);
  const top = Object.entries(byShow).sort((a, b) => b[1] - a[1]).slice(0, 40);
  for (const [s, n] of top) console.log(`  ${s}: ${n}`);
  return lines.length;
}
const gf = run('grandfathered (live rows exempt)', {});
const all = run('ungrandfathered (lifetime backlog)', { CV_WP_BUILD_GATE_GRANDFATHER: 'off' });
console.log(`SUMMARY grandfathered=${gf} lifetime=${all}`);
process.exit(0);
