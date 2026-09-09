#!/usr/bin/env node
/**
 * Regenerate data/off-broadway-venues.json — the known-Off-Broadway venue
 * allowlist used by the TodayTix discovery fallback (scripts/discover-new-shows.js
 * via isKnownOffBroadwayVenue). TodayTix mis-tags some OB shows (no "Off Broadway"
 * subcategory); the fallback rescues them when they play a venue we already
 * classify as Off-Broadway. This script keeps that list in sync with the data
 * instead of relying on the hand-seeded snapshot drifting out of date.
 *
 * Source of truth (union, deduped, normalized):
 *   1. venue names from every category='off-broadway' show in shows.json
 *   2. venue names from OB_VENUE_CONFIGS (the non-profit subscription houses)
 * minus BLOCKLIST (neighborhoods, placeholders, non-venues — see below).
 *
 * Names are stored ALREADY-NORMALIZED (lowercase, trailing "Theatre"/"Theater"
 * + trailing parenthetical stripped) via normalizeVenueName, matching the
 * data/west-end-venues.json convention so isKnownOffBroadwayVenue can do an
 * O(1) Set.has(normalize(input)) lookup.
 *
 * Usage:
 *   node scripts/build-ob-venues.js            # rewrite the JSON file
 *   node scripts/build-ob-venues.js --check    # exit 1 if the committed file
 *                                              # is stale (for CI / pre-push)
 *   node scripts/build-ob-venues.js --dry-run  # print the list, write nothing
 */

const fs = require('fs');
const path = require('path');
const { normalizeVenueName } = require('./lib/venue-classification');
const { OB_VENUE_CONFIGS } = require('./lib/venue-listing-discover');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'off-broadway-venues.json');

// Normalized names that are NOT real, matchable Off-Broadway venues:
// neighborhoods, geographic catch-alls, show names, and data placeholders that
// leaked into the venue field. Kept as a small, explicit data list (not lambdas)
// so it's auditable and the regen is deterministic.
const BLOCKLIST = new Set([
  '', 'tba',
  'midtown e', 'midtown w', 'greenwich v', 'east village', 'west village',
  'soho/tribeca', 'west end',
  'music city', 'magic mike live', 'masquerade nyc', 'paradise club',
  'bowery ballroom', 'lotte new york palace hotel',
  'please check your confirmation email for address',
]);

function buildList() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows || [];

  const obShowVenues = shows
    .filter(s => s.category === 'off-broadway')
    .map(s => s.venue);
  const configVenues = OB_VENUE_CONFIGS.map(c => c.name);

  const set = new Set();
  for (const venue of [...obShowVenues, ...configVenues]) {
    const normalized = normalizeVenueName(venue || '');
    if (!normalized || BLOCKLIST.has(normalized)) continue;
    set.add(normalized);
  }
  return [...set].sort();
}

// Match the on-disk format exactly (2-space indent + trailing newline) so
// --check diffs only on real content changes, not formatting.
function serialize(list) {
  return JSON.stringify(list, null, 2) + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run');

  const list = buildList();
  const next = serialize(list);

  if (dryRun) {
    console.log(list.join('\n'));
    console.log(`\n${list.length} Off-Broadway venues (dry run, nothing written)`);
    return;
  }

  const current = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf8') : '';

  if (check) {
    if (current !== next) {
      const currentCount = current ? JSON.parse(current).length : 0;
      console.error(
        `❌ data/off-broadway-venues.json is stale (${currentCount} entries on disk, ${list.length} expected).\n` +
        `   Run: node scripts/build-ob-venues.js`
      );
      process.exit(1);
    }
    console.log(`✅ data/off-broadway-venues.json is up to date (${list.length} venues)`);
    return;
  }

  if (current === next) {
    console.log(`✅ No change — data/off-broadway-venues.json already has ${list.length} venues`);
    return;
  }
  fs.writeFileSync(OUTPUT_FILE, next);
  console.log(`✅ Wrote ${list.length} Off-Broadway venues to data/off-broadway-venues.json`);
}

if (require.main === module) {
  main();
}

module.exports = { buildList, serialize, BLOCKLIST };
