#!/usr/bin/env node
/**
 * Classify stale closures — auto-Fizzle Broadway shows that closed 30+ days
 * ago with no recoupment news. Writes DIRECTLY to commercial.json (not
 * pending-review) because Fizzle-from-absent-evidence is deterministic policy,
 * not a claim awaiting review. Per Code Design reviewer redesign.
 *
 * Side effects:
 *   - Updates data/commercial.json in place for shows classified as Fizzle.
 *     The merge-commercial-data.js reconciler ensures concurrent writers
 *     don't lose entries on push.
 *   - Logs human-review escalations to stdout JSON for downstream Notion
 *     surfacing (notify-pending-commercial-notion currently handles only
 *     recoupment claims; surfacing closure-review cases is follow-up work —
 *     log for now, surface manually).
 *
 * Usage:
 *   node scripts/classify-stale-closures.js --dry-run
 *   node scripts/classify-stale-closures.js --max-shows=50
 *   node scripts/classify-stale-closures.js --show=specific-slug
 *   node scripts/classify-stale-closures.js --grace-days=45 --max-age-days=180
 */

const fs = require('fs');
const path = require('path');
const { classifyStaleClosure } = require('./lib/classify-stale-closure');
const { isCommercialScope } = require('./lib/commercial-scope');

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
// intOr — avoid `parseInt(x) || default` so 0 is preserved as a real cap.
const intOr = (k, def) => {
  if (flags[k] === undefined || flags[k] === true) return def;
  const n = parseInt(flags[k], 10);
  return Number.isNaN(n) ? def : n;
};
const MAX_SHOWS = intOr('max-shows', 50);
const thresholds = {
  graceDays: intOr('grace-days', 30),
  maxAgeDays: intOr('max-age-days', 365),
  recentSignalDays: intOr('recent-signal-days', 30),
};

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function main() {
  const allShows = loadJSON(SHOWS_PATH, { shows: [] });
  const shows = allShows.shows || allShows;
  const commercial = loadJSON(COMMERCIAL_PATH, { shows: {}, _meta: {} });
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

  const buckets = { wait: [], 'no-change': [], 'skip-carve-out': [], 'classify-fizzle': [], 'human-review': [] };
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

  console.log('=== Stale-closure classification plan ===');
  console.log(`Closed Broadway shows scanned: ${targets.length}`);
  console.log(`  classify-fizzle:   ${toApply.length} (overflow: ${overflowApply})`);
  console.log(`  human-review:      ${buckets['human-review'].length}`);
  console.log(`  skip-carve-out:    ${buckets['skip-carve-out'].length}`);
  console.log(`  wait (grace):      ${buckets.wait.length}`);
  console.log(`  no-change:         ${buckets['no-change'].length}`);
  console.log('');

  if (DRY_RUN) {
    console.log('[dry-run] no writes. Sample of each bucket:');
    for (const k of ['classify-fizzle', 'human-review', 'skip-carve-out']) {
      for (const it of buckets[k].slice(0, 3)) {
        console.log(`  [${k}] ${it.show.slug} — ${it.result.reason}`);
      }
    }
    return;
  }

  // Apply Fizzle directly to commercial.json
  const now = new Date().toISOString();
  let applied = 0;
  for (const { show, entry, result } of toApply) {
    const slug = show.slug;
    const existing = entry || {};
    // Build minimal update: preserve everything existing, overlay Fizzle fields.
    // Don't touch sources, capitalization, weeklyRunningCost etc. — the show
    // might have those from prior research, we're only adding a designation.
    commercial.shows[slug] = {
      ...existing,
      designation: 'Fizzle',
      // recouped:false is the affirmative no-recoup statement that drives
      // newsletter copy. Distinct from null (unknown) and false (was-checked-
      // and-confirmed-no).
      recouped: existing.recouped === true ? true : false,
      recoupedSource: existing.recoupedSource ||
        `Inferred: closed ${Math.floor((Date.now() - Date.parse(show.closingDate)) / 86_400_000)} days ago, no trade-press recoupment found`,
      classifiedBy: 'classify-stale-closures',
      classifiedAt: now,
      classifiedReason: result.reason,
      lastUpdated: now,
      firstAdded: existing.firstAdded || now,
    };
    applied++;
    console.log(`  ✓ ${slug}: ${result.reason}`);
  }

  if (applied > 0) {
    commercial._meta = commercial._meta || {};
    commercial._meta.lastUpdated = now.slice(0, 10);
    fs.writeFileSync(COMMERCIAL_PATH, JSON.stringify(commercial, null, 2) + '\n');
    console.log(`\n✓ Wrote ${applied} Fizzle classifications to commercial.json`);
  } else {
    console.log('\nNo Fizzle classifications to apply.');
  }

  // Surface human-review cases as JSON for downstream Notion processing.
  // notify-pending-commercial-notion currently only handles recoupment claims;
  // wrapping closure-reviews into that contract is follow-up work (Codex
  // CDX-P0-3). For now, just log them prominently for manual handling.
  if (buckets['human-review'].length > 0) {
    console.log(`\n⚠ ${buckets['human-review'].length} shows need human review:`);
    for (const it of buckets['human-review']) {
      console.log(`  - ${it.show.slug}: ${it.result.reason}`);
    }
    console.log('\n::warning::stale-closure escalations need Notion surfacing (follow-up)');
  }
}

main();
