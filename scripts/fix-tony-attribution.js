#!/usr/bin/env node

/**
 * fix-tony-attribution.js
 *
 * Applies surgical fixes to Tony attribution bugs surfaced by
 * audit-tony-attribution.js. Three fix classes:
 *
 *   1. SEASON-RELABEL: stored wins/noms match the actual production's
 *      Tony record, only the season label is wrong. Fix the label.
 *   2. DELETE-EMPTY: tony block has empty wins AND nominations==0/missing,
 *      it's just a misattributed metadata stub. Delete.
 *   3. DELETE-WRONG-PRODUCTION: West End show that wouldn't have Tonys, OR
 *      stored data demonstrably belongs to a different production. Delete.
 *
 * For findings that don't fit any class (need human verification), no
 * action is taken — they remain visible to audit-tony-attribution.js.
 *
 * Usage:
 *   node scripts/fix-tony-attribution.js --dry-run   # preview
 *   node scripts/fix-tony-attribution.js              # apply
 */

const fs = require('fs');
const path = require('path');
const { isBroadwayCategory } = require('./lib/venue-classification');

const AWARDS_FILE = path.join(__dirname, '..', 'data', 'awards.json');
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
const shows = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8')).shows || [];
const showsById = new Map(shows.map(s => [s.id, s]));

// Fixes verified against Wikipedia / Tony Awards archive.
// Format: showId → { action: 'relabel' | 'delete', reason, newSeason?, newCeremony? }
const FIXES = {
  // SEASON-RELABEL: stored data verified to match actual production's Tony record
  'the-boy-from-oz-2003': {
    action: 'relabel',
    newSeason: '2003-04',
    newCeremony: '58th',
    reason: 'Hugh Jackman won Best Actor in a Musical at 2004 Tonys (58th). openingDate 2003-10-16.'
  },
  'red-2010': {
    action: 'relabel',
    newSeason: '2009-10',
    newCeremony: '64th',
    reason: 'Red won Best Play + 5 others at 2010 Tonys (64th). openingDate 2010-04-01.'
  },
  // DELETE-EMPTY: empty wins, wrong season — just a metadata stub
  'harvey-2012': { action: 'delete', reason: 'Empty wins, tagged 1969-70 but opened 2012-06-14. Metadata stub.' },
  'fiddler-on-the-roof-1976': { action: 'delete', reason: 'Empty wins, tagged 1981-82 but opened 1976-12-28. Metadata stub.' },
  'out-cry-1973': { action: 'delete', reason: 'Empty wins, tagged 1969-70 but opened 1973-03-01. Metadata stub.' },
  'cyrano-1973': { action: 'delete', reason: 'Stored season=1993-94 but openingDate=1973-05-13. Misattribution of 1993-94 Tony data to 1973 production.' },

  // DELETE-WRONG-PRODUCTION: West End shows shouldn't have Tony data
  'a-month-in-the-country-west-end-2026': {
    action: 'delete',
    reason: 'West End show tagged with Tony data (1994-95). West End shows don\'t get Tonys.'
  },
  'man-to-man-west-end-2026': {
    action: 'delete',
    reason: 'West End show tagged with Tony data (2011-12). West End shows don\'t get Tonys.'
  },
  'oh-mary-west-end-2025': {
    action: 'delete',
    reason: 'West End transfer of Oh, Mary! tagged with 2024-25 Tony data. Tonys belong to the Broadway production (oh-mary-2024); WE transfer shouldn\'t have its own Tony block.'
  },

  // DELETE-WRONG-PRODUCTION: stored data demonstrably belongs to a different production
  'hair-2011': {
    action: 'delete',
    reason: 'Stored "Best Revival of a Musical" win belongs to hair-2009 revival, not the brief 2011 tour transfer.'
  },
  'purlie-1972': {
    action: 'delete',
    reason: 'shows.json has openingDate 1972-12-27 but Purlie won Best Actor in a Musical at 1969-70 Tonys (24th). Either shows.json date is wrong or this is a tour/revival entry — either way the Tony data needs to be on a separate 1970 production entry, not this one.'
  },
  'private-lives-2025': {
    action: 'delete',
    reason: 'Off-Broadway 2025 production tagged with 1969-70 Tony win (Tammy Grimes won Best Actress in a Play for the 1969 Broadway revival). Historical data attached to wrong (OB) show ID. Tonys are Broadway-only.'
  },
  'monte-cristo-the-york-theatre-company-off-broadway-2026': {
    action: 'delete',
    reason: 'Off-Broadway 2026 production tagged with 1970-71 Tony data (Best Scenic Design winner). Historical data attached to wrong (OB) show ID. Tonys are Broadway-only.'
  },
};

// Remove specific wrongly-attributed wins (the show was nominated but not
// actually a winner). These are misattribution bugs where stale data put a
// show on the winners list of a category another show won outright.
// Verified against Wikipedia Tony Awards by Year.
const WIN_REMOVALS = {
  'porgy-and-bess-1976': ['Best Actress in a Musical'],          // Dorothy Loudon (Annie) won outright
  'the-cherry-orchard-1977': ['Best Costume Design'],            // Theoni V. Aldredge (Annie) won outright
  'talleys-folly-1980': ['Best Scenic Design'],                  // David Mitchell (Barnum) won outright
  'little-me-1982': ['Best Actor in a Musical'],                 // Ben Harney (Dreamgirls) won outright
  'you-cant-take-it-with-you-1983': ['Best Actress in a Play'],  // Jessica Tandy (Foxfire) won outright
  'cabaret-1987': [
    'Best Actor in a Musical',                                    // Michael Crawford (Phantom) won
    'Best Actress in a Musical',                                  // Joanna Gleason (Into the Woods) won
    'Best Featured Actor in a Musical',                           // Bill McCutcheon (Anything Goes) won
  ],
};

let relabeled = 0, deleted = 0, skipped = 0, winsRemoved = 0;
const log = [];

for (const [showId, fix] of Object.entries(FIXES)) {
  const entry = awards.shows[showId];
  if (!entry || !entry.tony) {
    log.push(`SKIP ${showId}: no tony block to fix`);
    skipped++;
    continue;
  }
  if (fix.action === 'relabel') {
    const before = { season: entry.tony.season, ceremony: entry.tony.ceremony };
    entry.tony.season = fix.newSeason;
    entry.tony.ceremony = fix.newCeremony;
    log.push(`RELABEL ${showId}: ${JSON.stringify(before)} → ${JSON.stringify({ season: fix.newSeason, ceremony: fix.newCeremony })}`);
    relabeled++;
  } else if (fix.action === 'delete') {
    log.push(`DELETE ${showId}.tony (${JSON.stringify(entry.tony).slice(0, 80)}…)`);
    delete entry.tony;
    deleted++;
  }
}

for (const [showId, winsToRemove] of Object.entries(WIN_REMOVALS)) {
  const entry = awards.shows[showId];
  if (!entry || !entry.tony) {
    log.push(`SKIP-REMOVE ${showId}: no tony block`);
    skipped++;
    continue;
  }
  const before = entry.tony.wins ? [...entry.tony.wins] : [];
  entry.tony.wins = (entry.tony.wins || []).filter(w => !winsToRemove.includes(w));
  const removed = winsToRemove.filter(w => before.includes(w));
  if (removed.length > 0) {
    log.push(`REMOVE-WINS ${showId}: removed ${JSON.stringify(removed)} (kept ${JSON.stringify(entry.tony.wins)})`);
    winsRemoved += removed.length;
  }
}

// Bulk pass: delete tony blocks from non-Broadway shows. Tonys are
// Broadway-only; any West End or Off-Broadway entry with a tony block is
// fossilized misattribution from pre-validation bootstrap. Done as a bulk
// pass (vs per-ID FIXES) because the population is large (94+ as of
// 2026-05-17) and the rule is uniform.
let nonBroadwayDeleted = 0;
const nonBroadwaySkipped = [];
for (const [showId, awardsEntry] of Object.entries(awards.shows)) {
  if (!awardsEntry.tony) continue;
  const show = showsById.get(showId);
  if (!show || isBroadwayCategory(show)) continue;
  // Surface (don't auto-delete) entries with non-empty wins — they may need
  // human inspection to confirm the data isn't worth preserving on a
  // separate (correct) show ID.
  if ((awardsEntry.tony.wins || []).length > 0) {
    nonBroadwaySkipped.push(`${showId} (${show.category}, wins: ${JSON.stringify(awardsEntry.tony.wins)})`);
    continue;
  }
  delete awardsEntry.tony;
  nonBroadwayDeleted++;
}

console.log(log.join('\n'));
console.log(`\nSummary: ${relabeled} relabeled, ${deleted} deleted, ${winsRemoved} wins removed, ${skipped} skipped`);
console.log(`Non-Broadway sweep: ${nonBroadwayDeleted} deleted (empty/stub), ${nonBroadwaySkipped.length} flagged for human review`);
if (nonBroadwaySkipped.length > 0) {
  console.log('  Flagged (non-empty wins on non-Broadway show — likely historical data attached to wrong show ID):');
  for (const s of nonBroadwaySkipped) console.log('    ' + s);
}

if (DRY_RUN) {
  console.log('\n(dry-run: no file written)');
} else {
  awards._meta = awards._meta || {};
  awards._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(AWARDS_FILE, JSON.stringify(awards, null, 2) + '\n');
  console.log(`\nWrote ${AWARDS_FILE}`);
}
