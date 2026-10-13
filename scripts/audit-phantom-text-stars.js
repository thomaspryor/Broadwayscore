#!/usr/bin/env node
'use strict';
/**
 * audit-phantom-text-stars.js (BRO-5295): stored numeric-stars / text-pattern
 * ratings that came from prose ("1992 starring ...", "(c) 2014 StarTribune"),
 * not from a rating, and humanReviewScores that are really such a star. See
 * scripts/lib/phantom-text-star.js.
 *
 * Usage: node scripts/audit-phantom-text-stars.js [--max=N] [--json] [--dir=PATH]
 * Exit: 0 hits <= N (default 0) / 1 above / 3 bad args or corpus missing.
 * Runs daily (non-blocking) in check-corpus-drift.js.
 */
const fs = require('fs');
const path = require('path');
const { extractScore } = require('./lib/score-extractors');
const { findPhantomTextStar, findMachinePinnedHumanScore } = require('./lib/phantom-text-star');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-phantom-text-stars.js — stored text-derived stars that came from prose
Usage:
  node scripts/audit-phantom-text-stars.js [--max=N] [--json] [--dir=PATH]
  node scripts/audit-phantom-text-stars.js --help, -h    print this usage and exit
`;

function main(argv) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
  const maxRaw = arg('max');
  const max = maxRaw === '' ? 0 : Number(maxRaw);
  if (!Number.isInteger(max) || max < 0) { console.error(`bad --max: ${maxRaw}`); return 3; }
  const root = arg('dir') || path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(root)) { console.error(`corpus missing: ${root}`); return 3; }

  const hits = [];
  for (const show of fs.readdirSync(root)) {
    const dir = path.join(root, show);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory() || show.startsWith('_')) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const hit = findPhantomTextStar(d, extractScore);
      const pinned = findMachinePinnedHumanScore(d);
      if (pinned) hits.push({ file: `${show}/${f}`, stored: `humanReviewScore ${pinned.humanReviewScore}`, source: `${pinned.source} (machine-pinned human score)`, assignedScore: d.assignedScore ?? null, humanReviewScore: d.humanReviewScore });
      if (hit) hits.push({ file: `${show}/${f}`, stored: hit.stored, source: d.originalScoreSource, assignedScore: d.assignedScore ?? null, humanReviewScore: d.humanReviewScore ?? null });
    }
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ count: hits.length, max, hits }, null, 2));
  else {
    console.log(`phantom text stars: ${hits.length} (max ${max})`);
    for (const h of hits) console.log(`  ${h.file} stored ${h.stored} [${h.source}] assigned ${h.assignedScore} human ${h.humanReviewScore}`);
  }
  return hits.length <= max ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
