#!/usr/bin/env node
/**
 * Revert a held-row release for named shows (BRO-5041).
 *
 * Usage:
 *   node scripts/revert-commercial-release.js --previous=FILE [--released=FILE] --shows=a,b [--dry-run]
 *
 * --previous is commercial.json as it was before the release commit (the
 * workflow writes it with `git show <release>^:commercial.json`). Each named
 * record in data/commercial.json is put back to that version, or removed when
 * the release created it. --released is commercial.json at the release commit
 * itself: named shows the release did not change are skipped, and edits made
 * after the release are listed before they are thrown away. The pending rows are not touched: a released row is
 * deleted from the pending file, and re-holding it is the caller's job.
 */

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const { loadCommercial, saveCommercial } = require('./lib/commercial-write-guard');
const { revertReleasedRecords } = require('./lib/commercial-release-revert');

const flags = {};
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue;
  const [key, ...rest] = arg.slice(2).split('=');
  flags[key] = rest.length ? rest.join('=') : true;
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
const released = typeof flags.released === 'string' ? JSON.parse(fs.readFileSync(flags.released, 'utf8')) : undefined;
const commercial = loadCommercial();
const { restored, removed, unchanged, notInRelease, editedSince } = revertReleasedRecords(commercial, previous, slugs, released);

for (const s of restored) console.log(`  ↩️  "${s}" restored to its pre-release record (${previous.shows[s].designation || 'no designation'})`);
for (const s of removed) console.log(`  🗑️  "${s}" removed (the release created it)`);
for (const s of unchanged) console.log(`  ·  "${s}" already matches the pre-release state`);
for (const s of notInRelease) console.log(`  ⏭️  "${s}" skipped: that release did not change it`);
for (const [s, fields] of Object.entries(editedSince)) console.log(`  ⚠️  "${s}" was edited after the release; restoring drops: ${fields.join(', ')}`);

if (flags['dry-run']) {
  console.log(`🏁 Dry run: would restore ${restored.length}, remove ${removed.length}, leave ${unchanged.length}`);
  process.exit(0);
}
// allowShrink: removing records the release created is a deliberate delete.
if (restored.length || removed.length) saveCommercial(commercial, { allowShrink: true });
console.log(`🏁 Restored ${restored.length}, removed ${removed.length}, left ${unchanged.length}`);
