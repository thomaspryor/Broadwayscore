#!/usr/bin/env node
/**
 * Audit creativeTeam director vs synopsis "directed by X" mentions.
 *
 * Catches cross-production contamination like:
 *   - Seagull: True Story (Molochnikov) getting Jamie Lloyd from his 2025 Seagull
 *   - FLYBY (Adam Lenson) getting Racky Plews from a different musical
 *
 * Most same-title collisions happen on shows with generic / revival-prone titles
 * (Macbeth, Hamlet, A Doll's House, The Seagull). The synopsis is the anchor
 * of truth because it's written to describe THIS production.
 *
 * Usage:
 *   node scripts/audit-creative-team-vs-synopsis.js            # dry-run report
 *   node scripts/audit-creative-team-vs-synopsis.js --open     # only open/upcoming shows
 *   node scripts/audit-creative-team-vs-synopsis.js --json     # machine-readable
 */
const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const ONLY_OPEN = process.argv.includes('--open');
const AS_JSON = process.argv.includes('--json');

const d = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const shows = Array.isArray(d.shows) ? d.shows : Object.values(d.shows || d);

const DIR_IN_SYNOPSIS = /directed\s+by\s+([A-Z][a-zA-Z'’\-]+(?:\s+[A-Z][a-zA-Z'’\-]+){1,3})/;

const mismatches = [];
for (const s of shows) {
  if (ONLY_OPEN && !['open', 'previews', 'upcoming'].includes(s.status)) continue;
  if (!s.synopsis || !s.creativeTeam) continue;
  const m = s.synopsis.match(DIR_IN_SYNOPSIS);
  if (!m) continue;
  const synopsisDir = m[1].trim();
  const teamDirs = s.creativeTeam.filter(c => /(^|\s|&\s*)Director(\s|$|&)/i.test(c.role || ''));
  if (!teamDirs.length) continue;

  const lastSyn = synopsisDir.toLowerCase().split(/\s+/).pop();
  const match = teamDirs.some(c => {
    const n = c.name.toLowerCase();
    const lastTeam = n.split(/\s+/).pop();
    return n.includes(synopsisDir.toLowerCase())
      || synopsisDir.toLowerCase().includes(n)
      || (lastSyn && lastSyn === lastTeam);
  });

  if (!match) {
    mismatches.push({
      id: s.id,
      title: s.title,
      status: s.status,
      synopsisDirector: synopsisDir,
      teamDirectors: teamDirs.map(c => c.name),
    });
  }
}

if (AS_JSON) {
  console.log(JSON.stringify(mismatches, null, 2));
} else {
  console.log(`Audit: ${mismatches.length} director/synopsis mismatches found${ONLY_OPEN ? ' (open/upcoming only)' : ''}`);
  if (mismatches.length) {
    console.log('\nNOTE: some of these are false positives — the regex catches film');
    console.log('directors ("based on the 1988 Sidney Lumet film") and same-name but');
    console.log('different people. Review each manually.\n');
    for (const x of mismatches) {
      console.log(`  ${x.id} [${x.status}]`);
      console.log(`    synopsis: directed by "${x.synopsisDirector}"`);
      console.log(`    team:     ${x.teamDirectors.join(', ')}`);
    }
  }
}

process.exit(0);
