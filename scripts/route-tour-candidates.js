#!/usr/bin/env node
/**
 * Turn recorded national-tour roundup candidates into digest rows
 * (BRO-4211 Phase E). scrape-bww-reviews.js --landing-discover writes
 * data/audit/tour-roundup-candidates.json; this routes each open one through
 * routeAlert once per row (notifiedAt). Rows whose show has since gained a tour
 * entry are dropped from the file.
 *
 * None of this is an owner decision (owner 2026-10-30: "these are all silly
 * ones that a model can make the decision on"; 90 of 93 digest decisions were
 * tour candidates). A row is a digest FIX row (decision:false), which
 * digest-autofix.js hands to a worker. A tour that has already ended is not
 * routed at all: create-tour-entries.js re-checks its evidence every day and
 * creates it once a closing is confirmed, and an untracked closed tour is the
 * safe default. shouldRouteTourCandidate() is the rule; its test pins it.
 *
 * Run by scrape-new-aggregators.yml's scrape-bww-landing job, whose commit step
 * stages the candidates file and the alert-router files.
 *
 * Usage: node scripts/route-tour-candidates.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { openTourCandidates, candidateParentId, candidateKey, resolveRetiredTourCandidates, resolveStaleTourCandidateConditions, tourCandidateTitle, shouldRouteTourCandidate, TOUR_CANDIDATE_ROUTING } = require('./lib/tour-roundup-candidate');
const { routeAlert, resolveCondition, removeDigestLines, loadLedger } = require('./lib/owner-alert-router');
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
  if (!dryRun) resolveRetiredTourCandidates(rows, shows, { resolveCondition, removeDigestLines });
  const open = openTourCandidates(rows, shows);
  // Each candidate is suggested ONCE (notifiedAt); the owner answers it or
  // ignores it, and a later landing run doesn't ask again. A failed send
  // leaves notifiedAt unset so the next run retries that row only.
  let sent = 0;
  // Rows routed before 2026-10-30 went out as owner decisions. Their ledger
  // rows are resolved below (resolveStaleTourCandidateConditions skips only
  // routable keys); a routable one is routed again as a fix row.
  for (const c of open) {
    if (c.notifiedAt && c.routing !== TOUR_CANDIDATE_ROUTING && shouldRouteTourCandidate(c)) {
      if (!dryRun) { resolveCondition(`tour-candidate:${candidateKey(c)}`, { reason: 'Re-routed as a fix row, not an owner decision' }); removeDigestLines([`tour-candidate:${candidateKey(c)}`, `digest-needs-you:${tourCandidateTitle(c)}`]); }
      delete c.notifiedAt;
    }
  }
  for (const c of open) {
    if (c.notifiedAt) continue;
    if (!shouldRouteTourCandidate(c)) continue;
    // A tour found running on Tours To You (BRO-4325) gets two weeks for
    // create-tour-entries.js to confirm it (a launch next week, a Wikipedia
    // edit) before the owner is asked.
    const found = c.source === 'tourstoyou';
    if (found && Date.now() - Date.parse(c.firstSeen || 0) < 14 * 86400000) continue;
    // Not launched yet: create-tour-entries.js decides it once it has.
    if (found && c.segmentStart && c.segmentStart > new Date().toISOString().slice(0, 10)) continue;
    const key = candidateKey(c);
    const parentId = candidateParentId(c);
    console.log(`${dryRun ? '[dry-run] would suggest' : 'suggesting'}: ${c.title} (${key}) ← ${c.url}`);
    if (dryRun) continue;
    try {
      await routeAlert({
        conditionKey: `tour-candidate:${key}`,
        title: tourCandidateTitle(c),
        severity: 'info',
        disposition: 'digest',
        // A fix row for a worker, never an owner decision (see header).
        decision: false,
        url: c.url,
        description: `${c.needsClassification
          ? `Tours To You lists ${c.title} touring since ${c.segmentStart}, but it matches no tracked production and Wikipedia doesn't say it is a musical or play, so it wasn't added automatically. Add it to data/tour-page-classes.json as slug ${c.tourScheduleSlug} (class production with title and type, or event/aggregator to stop asking).`
          : found
          ? (c.ambiguous
            ? `Tours To You lists two ${c.title} tours running at once (${c.ambiguous}), so which one to track wasn't decided automatically.`
            : `Tours To You lists a ${c.title} tour ${c.ended ? `from ${c.segmentStart} through ${c.segmentEnd}, but its launch or closing is unconfirmed` : `running since ${c.segmentStart}, but Wikipedia doesn't confirm its launch`}, so it wasn't added automatically.`)
          : `BroadwayWorld published a national-tour review roundup for ${c.title} (${parentId}), which has no tour entry.`} ${c.needsClassification ? '' : parentId ? `Add a category:'tour' entry with tourOf:${parentId} (the production it tours; any market counts), then run node scripts/sweep-tour-reviews.js --tour=<id>.` : `Add a category:'tour' entry with tourScheduleSlug:${c.tourScheduleSlug} and no tourOf (a standalone tour), then run node scripts/sweep-tour-reviews.js --tour=<id>.`}`,
        cooldownHours: 24 * 30,
      });
      c.notifiedAt = new Date().toISOString();
      c.routing = TOUR_CANDIDATE_ROUTING;
      sent++;
    } catch (e) {
      console.log(`  [WARN] ${key}: ${e.message} (will retry next run)`);
    }
  }
  // Roundup-only rows (no show to suggest a tour for) wait for the Tours To You
  // pairing step; they are not suggestions here but must survive the rewrite (BRO-4931).
  const keep = rows.filter(r => (!r.broadwayShowId && !r.key) || String(r.key || '').startsWith('roundup:') || open.includes(r));
  // An ended tour is not asked about, so its old owner-decision row closes too.
  if (!dryRun) resolveStaleTourCandidateConditions(open.filter(shouldRouteTourCandidate).map(candidateKey), loadLedger(), { resolveCondition, removeDigestLines });
  if (!dryRun && (sent > 0 || keep.length !== rows.length)) {
    fs.writeFileSync(FILE, JSON.stringify(keep, null, 2) + '\n');
    if (keep.length !== rows.length) console.log(`Dropped ${rows.length - keep.length} candidate(s) with tracked or retired tours, or no longer eligible.`);
  }
  console.log(`${open.length} open tour candidate(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
