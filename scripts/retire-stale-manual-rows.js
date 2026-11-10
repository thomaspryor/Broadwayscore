#!/usr/bin/env node
/**
 * Remove named stale manualEntry rows from data/reviews.json (BRO-7257). The next rebuild
 * restores the pipeline twin. Targets are given as --row=showId:outletId:critic_name:score.
 * Usage: node scripts/retire-stale-manual-rows.js --row=... [--row=...] [--apply --expect=N]
 */
const fs = require('fs');
const path = require('path');
const { applyRetire } = require('./lib/retire-stale-manual-rows');

require('./lib/cli-help.js').exitOnHelp(module);
const args = process.argv.slice(2);
const targets = args.filter((a) => a.startsWith('--row=')).map((a) => {
  const parts = a.slice(6).split(':');
  const [showId, outletId, critic, score] = parts;
  const ok = parts.length === 4 && /^\d+$/.test(score || '');
  return { showId, outletId, critic: String(critic || '').replace(/_/g, ' '), score: ok ? Number(score) : NaN };
});
const apply = args.includes('--apply');
const expect = (args.find((a) => a.startsWith('--expect=')) || '').slice(9);
const file = path.join(__dirname, '..', 'data', 'reviews.json');
if (!targets.length || targets.some((t) => !t.showId || !t.outletId || !t.critic || Number.isNaN(t.score))) {
  console.error('need --row=showId:outletId:critic_name:score'); process.exit(2);
}
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = applyRetire(doc.reviews, targets);
for (const r of out.report) console.log(`${r.matched === 1 ? 'OK ' : 'BAD'} ${r.showId} ${r.outletId} ${r.critic} ${r.score} matched=${r.matched}`);
if (out.report.some((r) => r.matched !== 1)) { console.error('every target must match exactly one manual row'); process.exit(1); }
if (!apply) { console.log(`dry run: would remove ${out.removed}`); process.exit(0); }
if (expect !== String(out.removed)) { console.error(`--expect=${expect} but would remove ${out.removed}`); process.exit(1); }
doc.reviews = out.reviews;
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
console.log(`removed ${out.removed}`);
