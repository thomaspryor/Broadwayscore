#!/usr/bin/env node
/**
 * Classify stale closures (owner decision 2026-10-24, BRO-6158, superseding
 * policy B's 183-day wait). A closed Broadway show with no recoupment news
 * gets our best-estimate designation right away (Flop under 30% returned,
 * Fizzle 30%+, Trickle or Windfall at 100%+), from the record's own estimate
 * or our model, stamped designationBasis 'model-estimate', which the site
 * shows as our estimate. With no figure at all it stays TBD, flagged
 * needsLossEvidence.
 * Kill switch: --require-loss-evidence or STALE_CLOSURE_REQUIRE_LOSS_EVIDENCE=1
 * flags every such row and labels none. Later recoupment news clears the
 * label automatically (commercial-apply-gate.js recoupClaimDesignationAction).
 *
 * Side effects:
 *   - Updates data/commercial.json in place (labels, flags, undos).
 *     The merge-commercial-data.js reconciler ensures concurrent writers
 *     don't lose entries on push.
 *   - With --report-json, writes human-review escalations for
 *     notify-pending-commercial-linear.js to file as Linear issues (BRO-3490).
 *
 * Usage:
 *   node scripts/classify-stale-closures.js --dry-run
 *   node scripts/classify-stale-closures.js --max-shows=50
 *   node scripts/classify-stale-closures.js --show=specific-slug
 *   node scripts/classify-stale-closures.js --grace-days=45 --max-age-days=180
 *   node scripts/classify-stale-closures.js --report-json=/tmp/r.json   # human-review rows for Linear (BRO-3490)
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { classifyStaleClosure, buildClassifiedClosureEntry, undoAutoFizzleOnRunningShow } = require('./lib/classify-stale-closure');
const { isCommercialScope } = require('./lib/commercial-scope');
const { loadCommercial, saveCommercial } = require('./lib/commercial-write-guard');
const { buildClosureReviewItems } = require('./lib/stale-closure-review-card');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');
const PENDING_PATH = path.join(DATA_DIR, 'commercial-pending-review.json');
const ARCHIVE_PATH = path.join(DATA_DIR, 'commercial-pending-archive.json');

const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  }
}

const DRY_RUN = flags['dry-run'] === true;
const TARGET = flags['show'] || null;
// BRO-3490: where to write the human-review bucket for
// notify-pending-commercial-linear.js to file as Linear issues.
const REPORT_JSON = typeof flags['report-json'] === 'string' ? flags['report-json'] : null;
// intOr — avoid `parseInt(x) || default` so 0 is preserved as a real cap.
const intOr = (k, def) => {
  if (flags[k] === undefined || flags[k] === true) return def;
  const n = parseInt(flags[k], 10);
  return Number.isNaN(n) ? def : n;
};
const MAX_SHOWS = intOr('max-shows', 50);
const thresholds = {
  graceDays: intOr('grace-days', 7),
  maxAgeDays: intOr('max-age-days', 365),
  recentSignalDays: intOr('recent-signal-days', 30),
  // Kill switch for policy B: never label a loss on silence, only flag.
  requireLossEvidence: ['1', 'true'].includes(String(flags['require-loss-evidence'])) || process.env.STALE_CLOSURE_REQUIRE_LOSS_EVIDENCE === '1',
};

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function main() {
  const allShows = loadJSON(SHOWS_PATH, { shows: [] });
  const shows = allShows.shows || allShows;
  const commercial = fs.existsSync(COMMERCIAL_PATH) ? loadCommercial() : { shows: {}, _meta: {} };
  const pending = loadJSON(PENDING_PATH, { shows: {} });
  const archive = loadJSON(ARCHIVE_PATH, { shows: {} });

  commercial.shows = commercial.shows || {};
  pending.shows = pending.shows || {};
  archive.shows = archive.shows || {};

  // Only Broadway closed shows — the carve-out for OB/WE production-types
  // already exists in the classifier, but filtering up-front saves cycles.
  // Must gate on category via isCommercialScope(), not market: every
  // Off-Broadway show has market:'broadway' (see scripts/lib/
  // commercial-scope.js's SCOPE TRAP note) — a market-only check here let
  // closed Off-Broadway shows silently re-enter commercial.json as Fizzle
  // (2026-07-14 audit sweep).
  const targets = shows.filter(s => {
    if (TARGET) return s.slug === TARGET;
    if (s.status !== 'closed') return false;
    if (!isCommercialScope(s)) return false;
    return true;
  });

  const buckets = { wait: [], 'no-change': [], 'skip-carve-out': [], 'classify-fizzle': [], 'flag-needs-loss-evidence': [], 'human-review': [] };
  for (const show of targets) {
    const entry = commercial.shows[show.slug];
    const pendingEntry = pending.shows[show.slug];
    const archiveEntry = archive.shows[show.slug];
    const result = classifyStaleClosure({
      show, entry,
      pending: pendingEntry, archive: archiveEntry,
      thresholds,
    });
    buckets[result.action].push({ show, entry, result });
  }

  const toApply = buckets['classify-fizzle'].slice(0, MAX_SHOWS);
  const overflowApply = buckets['classify-fizzle'].length - toApply.length;

  // Undo this classifier's own Fizzle on shows that are running again.
  const showBySlug = new Map(shows.filter(s => s && s.slug).map(s => [s.slug, s]));
  const reopened = [];
  for (const [slug, entry] of Object.entries(commercial.shows)) {
    if (TARGET && slug !== TARGET) continue;
    const undone = undoAutoFizzleOnRunningShow(entry, showBySlug.get(slug));
    if (undone) reopened.push({ slug, undone, status: showBySlug.get(slug).status });
  }

  console.log('=== Stale-closure classification plan ===');
  console.log(`Closed Broadway shows scanned: ${targets.length}`);
  console.log(`  classify-fizzle:   ${toApply.length} (overflow: ${overflowApply})`);
  console.log(`  undo-fizzle:       ${reopened.length} (running again)`);
  console.log(`  needs-loss-evidence: ${buckets['flag-needs-loss-evidence'].length} (stay TBD)`);
  console.log(`  human-review:      ${buckets['human-review'].length}`);
  console.log(`  skip-carve-out:    ${buckets['skip-carve-out'].length}`);
  console.log(`  wait (grace):      ${buckets.wait.length}`);
  console.log(`  no-change:         ${buckets['no-change'].length}`);
  console.log('');

  if (REPORT_JSON) {
    const staleClosureReviews = buildClosureReviewItems(buckets['human-review']);
    fs.writeFileSync(REPORT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), staleClosureReviews }, null, 2));
    const awaitingResearch = buckets['human-review'].length - staleClosureReviews.length;
    console.log(`Report: ${staleClosureReviews.length} judgment row(s) -> ${REPORT_JSON} (${awaitingResearch} never-researched row(s) left to deep research's priority tier)\n`);
  }

  if (DRY_RUN) {
    console.log('[dry-run] no writes. Sample of each bucket:');
    for (const k of ['classify-fizzle', 'flag-needs-loss-evidence', 'human-review', 'skip-carve-out']) {
      for (const it of buckets[k].slice(0, 3)) {
        console.log(`  [${k}] ${it.show.slug} — ${it.result.reason}`);
      }
    }
    for (const it of reopened.slice(0, 3)) {
      console.log(`  [undo-fizzle] ${it.slug} — status is "${it.status}"`);
    }
    return;
  }

  // Apply the loss label directly to commercial.json
  const now = new Date().toISOString();
  let applied = 0;
  for (const { show, entry, result } of toApply) {
    const slug = show.slug;
    commercial.shows[slug] = buildClassifiedClosureEntry(entry, show, result, Date.parse(now));
    applied++;
    console.log(`  ✓ ${slug}: ${result.designation} (${result.designationBasis}): ${result.reason}`);
  }

  // Flag (never relabel) researched closures with no cited loss source.
  // Only the flag changes, so designation and recouped stay as they were.
  let flagged = 0;
  for (const { show, entry } of buckets['flag-needs-loss-evidence']) {
    // Any existing value (true, or false/null set by a person) is left alone,
    // so a hand-cleared flag is not re-raised the next day.
    if (!entry || 'needsLossEvidence' in entry) continue;
    commercial.shows[show.slug] = { ...entry, needsLossEvidence: true, lastUpdated: now };
    flagged++;
    console.log(`  ⚑ ${show.slug}: needs a cited loss source, stays ${entry.designation || 'TBD'}`);
  }

  for (const { slug, undone, status } of reopened) {
    commercial.shows[slug] = { ...undone, lastUpdated: now };
    console.log(`  ↩ ${slug}: loss label -> TBD (status is "${status}")`);
  }

  if (applied > 0 || flagged > 0 || reopened.length > 0) {
    commercial._meta = commercial._meta || {};
    commercial._meta.lastUpdated = now.slice(0, 10);
    saveCommercial(commercial);
    console.log(`\n✓ Wrote ${applied} loss labels, ${flagged} needsLossEvidence flags and ${reopened.length} undos to commercial.json`);
  } else {
    console.log('\nNothing to write (no new loss label, flag or undo).');
  }

  // Human-review cases reach Linear through --report-json +
  // notify-pending-commercial-linear.js (BRO-3490); the workflow runs both.
  if (buckets['human-review'].length > 0) {
    console.log(`\n⚠ ${buckets['human-review'].length} shows need human review:`);
    for (const it of buckets['human-review']) {
      console.log(`  - ${it.show.slug}: ${it.result.reason}`);
    }
    if (!REPORT_JSON) console.log('\n::warning::stale-closure escalations not written to a report (no --report-json); nothing files them on Linear');
  }
}

main();
