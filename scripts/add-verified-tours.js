#!/usr/bin/env node
/**
 * add-verified-tours.js (BRO-4601): create national-tour entries whose
 * current-era launch was checked by hand, for long-running tours that
 * create-tour-entries.js cannot date (Tours To You keeps only recent rows,
 * and its first row is often a resumption or another company).
 *
 * Input: a JSON list
 *   [{ "parent": "hamilton-2015", "launch": "2024-08-16", "closing": null,
 *      "scheduleSlug": "hamilton", "sources": ["https://...", "https://..."] }]
 * Each entry goes through tour-entry.js buildTourEntry (same shape, id,
 * overlap and image checks as auto-created tours) with launchSource
 * 'hand-verified'; two source URLs are required.
 *
 * Usage:
 *   node scripts/add-verified-tours.js --file=tours.json            report
 *   node scripts/add-verified-tours.js --file=tours.json --write    write shows.json
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { buildTourEntry } = require('./lib/tour-entry');
const { createShowsWriteGuard } = require('./lib/shows-write-guard');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

/** Build entries for the list against `shows`. Pure. */
function planVerifiedTours(list, shows, now = new Date()) {
  const byId = new Map(shows.map(s => [s.id, s]));
  // Entries built earlier in the list count too: two companies of one title
  // in one file must not both become <title>-tour-<year> (code review).
  const seen = [...shows];
  return list.map(t => {
    const parent = byId.get(t.parent);
    const decision = {
      write: { openingDate: t.launch, ...(t.closing ? { closingDate: t.closing } : {}) },
      notes: [`current-era launch ${t.launch} verified by hand`],
      launchSource: 'hand-verified',
      evidenceUrls: t.sources || [],
    };
    const scheduleUrl = t.scheduleSlug ? `https://tourstoyou.org/shows/${t.scheduleSlug}/` : null;
    const built = buildTourEntry({ parent, shows: seen, decision, scheduleUrl, now });
    if (built.entry) seen.push(built.entry);
    return { parent: t.parent, ...built };
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log('add-verified-tours.js --file=tours.json [--write]'); return; }
  const file = (argv.find(a => a.startsWith('--file=')) || '').split('=')[1];
  if (!file) { console.error('--file=tours.json is required'); process.exit(2); }
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { loadShows, saveShows } = createShowsWriteGuard(SHOWS_PATH);
  const snapshot = loadShows();
  const plan = planVerifiedTours(list, snapshot.shows);
  for (const p of plan) console.log(p.entry ? `${argv.includes('--write') ? 'creating' : 'would create'} ${p.entry.id} (${p.entry.openingDate}..${p.entry.closingDate || 'running'})` : `skip ${p.parent}: ${p.skip}`);
  const entries = plan.filter(p => p.entry).map(p => p.entry);
  if (argv.includes('--write') && entries.length) {
    snapshot.shows.push(...entries);
    saveShows(snapshot);
    console.log(`Wrote ${entries.length} tour(s)`);
  }
}

if (require.main === module) main();

module.exports = { planVerifiedTours };
