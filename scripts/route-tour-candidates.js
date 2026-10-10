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
const { openTourCandidates, candidateParentId } = require('./lib/tour-roundup-candidate');
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
    // A tour found running on Tours To You (BRO-4325) gets two weeks for
    // create-tour-entries.js to confirm it (a launch next week, a Wikipedia
    // edit) before the owner is asked.
    const found = c.source === 'tourstoyou';
    if (found && Date.now() - Date.parse(c.firstSeen || 0) < 14 * 86400000) continue;
    // Not launched yet: create-tour-entries.js decides it once it has.
    if (found && c.segmentStart && c.segmentStart > new Date().toISOString().slice(0, 10)) continue;
    const key = c.key || c.broadwayShowId;
    const parentId = candidateParentId(c);
    console.log(`${dryRun ? '[dry-run] would suggest' : 'suggesting'}: ${c.title} (${key}) ← ${c.url}`);
    if (dryRun) continue;
    try {
      await routeAlert({
        conditionKey: `tour-candidate:${key}`,
        title: `Tour candidate: ${c.title} national tour`,
        severity: 'info',
        disposition: 'digest',
        decision: true,
        // A page nothing could classify (BRO-4931): the owner says what it is
        // (data/tour-page-classes.json), not whether a known show tours.
        decisionPrompt: c.needsClassification
          ? `Is ${c.title} a touring stage production worth tracking (not a concert, circus or dance show)?`
          : `Add the ${c.title} national tour as a tracked tour?`,
        url: c.url,
        description: `${c.needsClassification
          ? `Tours To You lists ${c.title} touring since ${c.segmentStart}, but it matches no tracked production and Wikipedia doesn't say it is a musical or play, so it wasn't added automatically. Add it to data/tour-page-classes.json as slug ${c.tourScheduleSlug} (class production with title and type, or event/aggregator to stop asking).`
          : found
          ? (c.ambiguous
            ? `Tours To You lists two ${c.title} tours running at once (${c.ambiguous}), so which one to track wasn't decided automatically.`
            : `Tours To You lists a ${c.title} tour running since ${c.segmentStart}, but Wikipedia doesn't confirm its launch, so it wasn't added automatically.`)
          : `BroadwayWorld published a national-tour review roundup for ${c.title} (${parentId}), which has no tour entry.`} ${c.needsClassification ? '' : parentId ? `Add a category:'tour' entry with tourOf:${parentId} (the production it tours; any market counts), then run node scripts/sweep-tour-reviews.js --tour=<id>.` : `Add a category:'tour' entry with tourScheduleSlug:${c.tourScheduleSlug} and no tourOf (a standalone tour), then run node scripts/sweep-tour-reviews.js --tour=<id>.`}`,
        cooldownHours: 24 * 30,
      });
      c.notifiedAt = new Date().toISOString();
      sent++;
    } catch (e) {
      console.log(`  [WARN] ${key}: ${e.message} (will retry next run)`);
    }
  }
  // Roundup-only rows (no show to suggest a tour for) wait for the Tours To You
  // pairing step; they are not suggestions here but must survive the rewrite (BRO-4931).
  const keep = rows.filter(r => (!r.broadwayShowId && !r.key) || String(r.key || '').startsWith('roundup:') || open.includes(r));
  if (!dryRun && (sent > 0 || keep.length !== rows.length)) {
    fs.writeFileSync(FILE, JSON.stringify(keep, null, 2) + '\n');
    if (keep.length !== rows.length) console.log(`Dropped ${rows.length - keep.length} candidate(s) whose show now has a tour entry.`);
  }
  console.log(`${open.length} open tour candidate(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
