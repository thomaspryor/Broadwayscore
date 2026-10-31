#!/usr/bin/env node
/**
 * plan-we-dateless-openings.js (BRO-5850): read data/audit/we-dateless-tr-lookups.json
 * (written by resolve-we-unlisted-tr.js --dateless in we-dateless-tr-resolve.yml)
 * and write an actions file of openingDate data-edits for new-fix-plan.js.
 *
 *   node scripts/plan-we-dateless-openings.js [--out=actions.json]
 * Prints accepted/rejected counts and every rejection reason. The openingDate
 * edit stamps openingDateSource 'human-correction' when the plan is applied.
 */
const fs = require('fs');
const path = require('path');
const { planFromLookups } = require('./lib/we-dateless-openings');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/plan-we-dateless-openings.js [--out=actions.json]\nReads data/audit/we-dateless-tr-lookups.json; prints accepted/rejected tally; --out writes data-edit actions for new-fix-plan.js.');
  process.exit(0);
}
const arg = n => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', 'we-dateless-tr-lookups.json'), 'utf8'));
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const { edits, rejected } = planFromLookups(file, Array.isArray(raw) ? raw : raw.shows);
if (file.partial) console.warn('WARNING: lookups file is partial (the run timed out); undated rows past the checkpoint were not looked up');
console.log(`accepted ${edits.length}, rejected ${rejected.length}`);
for (const e of edits) console.log(`  ok   ${e.showId} ${e.openingDate} ${e.link}`);
const tally = {};
for (const r of rejected) { const k = r.reason.replace(/\d{4}-\d{2}-\d{2}/g, 'D'); tally[k] = (tally[k] || 0) + 1; }
console.log(tally);
const out = arg('out');
if (out) {
  const actions = edits.map(e => ({
    type: 'data-edit', file: 'shows.json', showId: e.showId, field: 'openingDate', newValue: e.openingDate,
    description: `${e.showId}: openingDate null -> ${e.openingDate} (BRO-5850: Theatre Record press night, ${e.link})`,
  }));
  fs.writeFileSync(out, JSON.stringify(actions, null, 2) + '\n');
  console.log(`wrote ${actions.length} actions to ${out}`);
}
