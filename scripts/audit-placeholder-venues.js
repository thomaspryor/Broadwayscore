#!/usr/bin/env node
/**
 * Placeholder-venue census (#987, sprint S0-T1).
 *
 * WHY THIS EXISTS
 * The Off-Off-Broadway category (owner decision 2026-08-03, "Option A") is to be
 * derived from an ENUMERATED venue list, mirroring how `off-broadway` already
 * works (scripts/lib/venue-classification.js:16-33 — note `off-west-end` is a
 * *residual*, `off-broadway` is *enumerated*, so the two markets are not
 * symmetric and OOB must follow the enumerated model).
 *
 * That derivation is only safe once `venue` actually holds a venue. It does not
 * today. Census on 2026-08-03, against data/off-broadway-venues.json (121 venues):
 *
 *     off-broadway shows ................. 389
 *       venue IS in enumerated list ...... 322
 *       venue NOT in list ................. 67
 *         of which placeholder/blob ....... 60   <-- NOT Off-Off-Broadway
 *         real named venue outside list .... 7
 *
 * So "venue not in the Off-Broadway list" would mislabel 60 shows as
 * Off-Off-Broadway, 24 of which have no venue at all (`TBA`). The blobs are
 * neighbourhood strings (`Midtown E`, `Soho/Tribeca`) written into the venue
 * field, plus one literal `Please check your confirmation email for address`.
 *
 * These are arriving from a LIVE path, not historical debt: The Vessel
 * (`Midtown E`), We've Been Here Before (`Soho/Tribeca`) and Matilda
 * (`Midtown W`) were all ingested in the last few weeks.
 *
 * READ-ONLY. Writes nothing. The predicate itself (`isPlaceholderVenue`,
 * `UNKNOWN_MARKERS`, `NEIGHBOURHOOD_BLOBS`, `JUNK_SUBSTRINGS`) LIVES in
 * scripts/lib/placeholder-venue.js since S4-T7 (BRO-4204) — this census, the
 * write-time guard (sanitizeVenueForWrite, S0-T3) and the source lint
 * (venue-write-guard-detector.js) all require() that one module, so the three
 * can never disagree about what a placeholder is again (CLAUDE.md §15 —
 * never copy logic; the lint's private copy is exactly how "West End" slipped
 * through). Re-exported here unchanged so existing callers
 * (enrich-west-end-shows.js, enrich-ob-dates-from-showscore.js, the S0-T3 unit
 * test) keep working.
 */

const fs = require('fs');
const path = require('path');
const { isPlaceholderVenue, NEIGHBOURHOOD_BLOBS, UNKNOWN_MARKERS, JUNK_SUBSTRINGS } = require('./lib/placeholder-venue');

// Worktrees never have their own data/ (gitignored + symlinked in the main
// checkout, not copied on EnterWorktree), so the __dirname-relative path below
// resolves to a worktree root with no shows.json. Fall back to the canonical
// repo — same idiom load-env.js and dispatch-ledger.js use (task #983).
const CANONICAL_REPO = '/Users/tompryor/Broadwayscore';

function loadShows(explicitPath) {
  // Resolve from __dirname, not cwd — this script runs from worktrees and from CI.
  // `--shows=<path>` (S4-T7) overrides both: cloud worktrees have neither a
  // local data/shows.json nor the canonical macOS path.
  const local = path.join(__dirname, '..', 'data', 'shows.json');
  const p = explicitPath
    ? path.resolve(explicitPath)
    : (fs.existsSync(local) ? local : path.join(CANONICAL_REPO, 'data', 'shows.json'));
  const raw = require(p);
  return Array.isArray(raw) ? raw : raw.shows;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: node scripts/audit-placeholder-venues.js [--json] [--category=off-broadway]

Read-only census of shows whose \`venue\` field holds a placeholder
(TBA, a neighbourhood name, or scraped junk) rather than a real venue.

Blocks S0-T4 backfill and S4-T5 (enumerated off-off-broadway venue list):
the enumerated list cannot discriminate OOB while venues are placeholders.

  --json                machine-readable output
  --category=<cat>      restrict to one category (default: off-broadway)
  --all-categories      census every category
  --shows=<path>        read this shows.json instead of data/shows.json
Writes nothing.`);
    process.exit(0);
  }

  const asJson = argv.includes('--json');
  const allCategories = argv.includes('--all-categories');
  const catArg = argv.find(a => a.startsWith('--category='));
  const category = catArg ? catArg.split('=')[1] : 'off-broadway';
  const showsArg = argv.find(a => a.startsWith('--shows='));

  const shows = loadShows(showsArg ? showsArg.slice('--shows='.length) : undefined);
  const scope = allCategories ? shows : shows.filter(s => s.category === category);

  const flagged = [];
  for (const s of scope) {
    const { placeholder, reason } = isPlaceholderVenue(s.venue);
    if (placeholder) flagged.push({ id: s.id, title: s.title, venue: s.venue ?? null, reason, category: s.category });
  }

  if (asJson) {
    console.log(JSON.stringify({ scope: allCategories ? 'all' : category, total: scope.length, flagged }, null, 2));
    process.exit(0);
  }

  const scopeLabel = allCategories ? 'all categories' : category;
  console.log(`placeholder-venue ${scopeLabel} shows: ${flagged.length}`);
  console.log(`(of ${scope.length} in scope)\n`);

  if (flagged.length === 0) {
    console.log('No placeholder venues. S0 exit criterion met.');
    process.exit(0);
  }

  const byReason = {};
  const byValue = {};
  for (const f of flagged) {
    byReason[f.reason] = (byReason[f.reason] || 0) + 1;
    const key = f.venue === null ? '(null)' : f.venue;
    byValue[key] = (byValue[key] || 0) + 1;
  }

  console.log('by reason:');
  Object.entries(byReason).sort((a, b) => b[1] - a[1])
    .forEach(([r, n]) => console.log(`  ${String(n).padStart(4)}  ${r}`));

  console.log('\nby value:');
  Object.entries(byValue).sort((a, b) => b[1] - a[1])
    .forEach(([v, n]) => console.log(`  ${String(n).padStart(4)}  ${v}`));

  console.log('\nsample (first 10):');
  flagged.slice(0, 10).forEach(f => console.log(`  ${f.title} | ${f.venue ?? '(null)'} | ${f.reason}`));

  console.log(`\nThese block S4-T5: an enumerated off-off-broadway list cannot`);
  console.log(`discriminate OOB while ${flagged.length} shows carry a non-venue in \`venue\`.`);
  // Census, not a gate — exit 0 so it can run informationally in CI.
  process.exit(0);
}

if (require.main === module) main();

module.exports = { isPlaceholderVenue, NEIGHBOURHOOD_BLOBS, UNKNOWN_MARKERS, JUNK_SUBSTRINGS };
