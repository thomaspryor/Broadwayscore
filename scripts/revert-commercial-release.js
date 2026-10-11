#!/usr/bin/env node
/**
 * Revert a held-row release for named shows (BRO-5041).
 *
 * Usage:
 *   node scripts/revert-commercial-release.js --previous=FILE --shows=a,b [--dry-run]
 *
 * --previous is commercial.json as it was before the release commit (the
 * workflow writes it with `git show <release>^:commercial.json`). Each named
 * record in data/commercial.json is put back to that version, or removed when
 * the release created it. The pending rows are not touched: a released row is
 * deleted from the pending file, and re-holding it is the caller's job.
 */

const fs = require('fs');
const { loadCommercial, saveCommercial } = require('./lib/commercial-write-guard');
const { revertReleasedRecords } = require('./lib/commercial-release-revert');

const flags = {};
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue;
  const [key, ...rest] = arg.slice(2).split('=');
  flags[key] = rest.length ? rest.join('=') : true;
}

if (flags.help) {
  console.log('Usage: node scripts/revert-commercial-release.js --previous=FILE --shows=a,b [--dry-run]');
  process.exit(0);
}
if (typeof flags.previous !== 'string' || typeof flags.shows !== 'string') {
  console.error('--previous=FILE and --shows=a,b are both required');
  process.exit(2);
}
const slugs = flags.shows.split(',').map((s) => s.trim()).filter(Boolean);
if (!slugs.length || slugs.some((s) => !/^[a-z0-9-]+$/.test(s))) {
  console.error('--shows must be comma-separated slugs (a-z, 0-9, -)');
  process.exit(2);
}

const previous = JSON.parse(fs.readFileSync(flags.previous, 'utf8'));
const commercial = loadCommercial();
const { restored, removed, unchanged } = revertReleasedRecords(commercial, previous, slugs);

for (const s of restored) console.log(`  ↩️  "${s}" restored to its pre-release record (${previous.shows[s].designation || 'no designation'})`);
for (const s of removed) console.log(`  🗑️  "${s}" removed (the release created it)`);
for (const s of unchanged) console.log(`  ·  "${s}" already matches the pre-release state`);

if (flags['dry-run']) {
  console.log(`🏁 Dry run: would restore ${restored.length}, remove ${removed.length}, leave ${unchanged.length}`);
  process.exit(0);
}
if (restored.length || removed.length) saveCommercial(commercial);
console.log(`🏁 Restored ${restored.length}, removed ${removed.length}, left ${unchanged.length}`);
