#!/usr/bin/env node
/**
 * Turn recorded national-tour roundup candidates into owner digest suggestions
 * (BRO-4211 Phase E). scrape-bww-reviews.js --landing-discover writes
 * data/audit/tour-roundup-candidates.json; this routes each open one through
 * routeAlert as a digest decision ("Add the <Show> national tour?"), once per
 * row (notifiedAt). Rows whose show has since gained a tour entry are dropped
 * from the file.
 *
 * Run by scrape-new-aggregators.yml's scrape-bww-landing job, whose commit step
 * stages the candidates file and the alert-router files.
 *
 * Usage: node scripts/route-tour-candidates.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { openTourCandidates } = require('./lib/tour-roundup-candidate');
const { routeAlert } = require('./lib/owner-alert-router');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `route-tour-candidates.js — route national-tour roundup candidates to the owner digest.

Usage:
  node scripts/route-tour-candidates.js [--dry-run]
  node scripts/route-tour-candidates.js --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'audit', 'tour-roundup-candidates.json');

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const dryRun = process.argv.includes('--dry-run');
  if (!fs.existsSync(FILE)) { console.log('No tour candidates recorded.'); return; }
  const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const open = openTourCandidates(rows, shows);
  // Each candidate is suggested ONCE (notifiedAt); the owner answers it or
  // ignores it, and a later landing run doesn't ask again. A failed send
  // leaves notifiedAt unset so the next run retries that row only.
  let sent = 0;
  for (const c of open) {
    if (c.notifiedAt) continue;
    console.log(`${dryRun ? '[dry-run] would suggest' : 'suggesting'}: ${c.title} (${c.broadwayShowId}) ← ${c.url}`);
    if (dryRun) continue;
    try {
      await routeAlert({
        conditionKey: `tour-candidate:${c.broadwayShowId}`,
        title: `Tour candidate: ${c.title} national tour`,
        severity: 'info',
        disposition: 'digest',
        decision: true,
        decisionPrompt: `Add the ${c.title} national tour as a tracked tour?`,
        url: c.url,
        description: `BroadwayWorld published a national-tour review roundup for ${c.title} (${c.broadwayShowId}), which has no tour entry. Add a category:'tour' entry with tourOf:${c.broadwayShowId}, then run node scripts/sweep-tour-reviews.js --tour=<id>.`,
        cooldownHours: 24 * 30,
      });
      c.notifiedAt = new Date().toISOString();
      sent++;
    } catch (e) {
      console.log(`  [WARN] ${c.broadwayShowId}: ${e.message} (will retry next run)`);
    }
  }
  if (!dryRun && (sent > 0 || open.length !== rows.length)) {
    fs.writeFileSync(FILE, JSON.stringify(open, null, 2) + '\n');
    if (open.length !== rows.length) console.log(`Dropped ${rows.length - open.length} candidate(s) whose show now has a tour entry.`);
  }
  console.log(`${open.length} open tour candidate(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
