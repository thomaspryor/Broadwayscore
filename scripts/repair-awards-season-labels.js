#!/usr/bin/env node
/**
 * Repair Tony season labels in data/awards.json (see
 * scripts/lib/awards-season-labels.js). Dry run by default.
 *   node scripts/repair-awards-season-labels.js [--write]
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/repair-awards-season-labels.js [--write]\n\nRepairs Tony season labels in data/awards.json where two of three signals\n(label, ceremony number, opening-date Tony window) agree. Dry run unless --write.');
  process.exit(0);
}
const { repairSeasonLabels } = require('./lib/awards-season-labels');
const { readTonyCutoffs } = require('./lib/tony-cutoffs-reader');

const dataDir = path.join(__dirname, '..', 'data');
const awardsPath = path.join(dataDir, 'awards.json');
const awards = JSON.parse(fs.readFileSync(awardsPath, 'utf8'));
const showsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
const shows = new Map((showsRaw.shows || showsRaw).map(s => [s.id, s]));
const windows = readTonyCutoffs();

const windowLabelFor = id => {
  const s = shows.get(id);
  if (!s?.openingDate || (s.category && s.category !== 'broadway')) return null;
  return windows.find(w => s.openingDate >= w.start && s.openingDate <= w.end)?.label || null;
};

const changes = repairSeasonLabels(awards.shows, windowLabelFor);
for (const c of changes) console.log(`${c.id}: ${c.from.season} ${c.from.ceremony || ''} -> ${c.to.season} ${c.to.ceremony || ''}`);
console.log(`${changes.length} record(s) ${process.argv.includes('--write') ? 'repaired' : 'would change (dry run; --write to save)'}`);
if (process.argv.includes('--write') && changes.length) fs.writeFileSync(awardsPath, JSON.stringify(awards, null, 2) + '\n');
