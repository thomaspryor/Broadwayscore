#!/usr/bin/env node
/**
 * Audit + clean data/cast-changes.json.
 *
 * Detects and fixes the bugs surfaced in the newsletter on 2026-05-23:
 *   1. "Production closes …" stored as per-actor `departure` (Chess case).
 *      → reclassify ONE of them into a show-level `closure` event,
 *        drop the rest.
 *   2. Closure event contradicted by a later `arrival` event.
 *      → resolve by recency of addedDate (resolveClosureArrivalContradictions):
 *        a newer arrival means the show extended (drop the stale closure); a
 *        newer/tied closure means the show is closing early (drop the stale
 *        arrival, e.g. chess-2025 early-close June 21 vs JoJo June 23).
 *   3. Ended `absence` events still in upcoming (Alison Luff Wonder leave).
 *      → drop where endDate < today.
 *   4. Stale [AUTO-FLAGGED] entries (> 30 days).
 *      → drop; the scraper would have re-asserted them by now if real.
 *
 * Usage:
 *   node scripts/audit-cast-changes.js          # dry-run (default)
 *   node scripts/audit-cast-changes.js --write  # rewrite cast-changes.json
 *   node scripts/audit-cast-changes.js --strict # exit non-zero if ANY issue
 *   node scripts/audit-cast-changes.js --gate   # per-push trunk catastrophe FLOOR
 *
 * --gate (vs --strict) as of 2026-06-29: --strict blocks on totalIssues > 0, but
 * almost all of those kinds (stale closure-date repairs, collapsed departures,
 * dropped contradictions/absences, stale [AUTO-FLAGGED], name dedupes, redundant
 * in-cast arrivals) are AUTO-HEALED by this script's own --write (run on schedule).
 * Blocking on a handful reddens the trunk for non-code reasons in the window before
 * --write runs. --gate blocks only on a genuine catastrophe — a cross-show conflict
 * (actor in two shows at once, NOT auto-fixed) or a mass churn spike past the floor
 * (cast-scraper regression). Decision logic + tests:
 * scripts/lib/cast-changes-gate.{js,test.mjs}. The FULL --strict triage runs daily
 * in check-corpus-drift.yml, surfaced non-blocking in the digest.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  detectContradictions,
  resolveClosureArrivalContradictions,
  detectCrossShowConflicts,
  dedupeByPersonShow,
  detectDuplicateCastEntries,
  normalizeIdentifier,
  noteMatchesClosurePhrase,
  reconcileClosureDateWithClosingDate,
} = require('./lib/cast-changes-filters');
const { shouldBlockCastChangesGate } = require('./lib/cast-changes-gate');

const DATA_PATH = path.join(__dirname, '..', 'data', 'cast-changes.json');
const TODAY = new Date();
const TODAY_STR = TODAY.toISOString().slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;

// Per-push gate floor: routine churn the cast scraper introduces between --write
// passes exits 0; a spike beyond this signals a scraper regression and blocks.
const GATE_FLOOR = 15;

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const STRICT = args.has('--strict');
const GATE = args.has('--gate');

function parseISO(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isClosureDeparture(event) {
  if (event.type !== 'departure') return false;
  // Phrase list lives in scripts/lib/cast-changes-filters.js so audit + runtime
  // + TS web app can't drift. See CLOSURE_NOTE_PHRASES doc-comment there.
  return noteMatchesClosurePhrase(event.note);
}

// Minimum cluster size for auto-reclassification. A single departure with a
// matching note like "final performance as show closes" could legitimately
// be one actor's exit on the closing date, NOT a fresh show-wide closure
// announcement that the scraper failed to emit as a `closure` event.
// Two or more same-date matching departures is a much stronger signal that
// the scrape collapsed a closure into per-actor rows (the original DBH bug
// pattern). Singletons should be left to humans / a future scraper pass.
const MIN_RECLASS_GROUP_SIZE = 2;

function reclassifyClosureDepartures(events, showId) {
  const closureGroups = new Map();
  const nonClosure = [];
  const departuresByGroupKey = new Map();

  for (const e of events) {
    if (isClosureDeparture(e) && e.date) {
      if (!closureGroups.has(e.date)) closureGroups.set(e.date, []);
      closureGroups.get(e.date).push(e);
    } else {
      nonClosure.push(e);
    }
  }

  const newClosures = [];
  const reclassifiedDates = new Set();
  for (const [date, group] of closureGroups) {
    const alreadyHasClosure = events.some(
      e => e.type === 'closure' && e.date === date,
    );
    // Don't promote a singleton matching departure into a show-wide closure.
    // We still suppress it at render time via reconcileClosure() when a
    // sibling `closure` event exists, but we won't fabricate one from a
    // single ambiguous note.
    if (group.length < MIN_RECLASS_GROUP_SIZE && !alreadyHasClosure) continue;
    if (!alreadyHasClosure) {
      const seed = group[0];
      newClosures.push({
        type: 'closure',
        name: showId,
        role: 'Production',
        date,
        note: seed.note || 'Production closes',
        sourceUrl: seed.sourceUrl,
        sourceType: seed.sourceType,
        addedDate: seed.addedDate || TODAY_STR,
      });
    }
    reclassifiedDates.add(date);
  }

  // For closure dates where a closure event now exists (newly created OR
  // pre-existing), drop the per-actor departures (they're redundant). For
  // closure dates we DIDN'T promote (singleton with no existing closure),
  // keep the per-actor departure rows — they may be legitimate single
  // exits that happen to match a closure phrase.
  const keptDepartures = [];
  for (const [date, group] of closureGroups) {
    if (!reclassifiedDates.has(date)) {
      for (const e of group) keptDepartures.push(e);
    }
  }
  const collapsedCount = Array.from(closureGroups.entries())
    .filter(([date]) => reclassifiedDates.has(date))
    .reduce((n, [, g]) => n + g.length, 0);

  return {
    rewritten: [...newClosures, ...nonClosure, ...keptDepartures],
    reclassifiedCount: collapsedCount,
    closureGroupCount: reclassifiedDates.size,
  };
}

function dropContradictedClosures(events) {
  // Recency-aware: keep whichever of {closure, contradicting later arrival} was
  // added most recently and drop the stale side. A blanket "always drop the
  // closure" rule shipped a phantom arrival once chess-2025 announced an early
  // close (closure newer than the planned-succession arrival).
  const res = resolveClosureArrivalContradictions(events);
  return {
    events: res.events,
    dropped: res.droppedClosures + res.droppedArrivals,
    droppedClosures: res.droppedClosures,
    droppedArrivals: res.droppedArrivals,
  };
}

function dropEndedAbsences(events) {
  let dropped = 0;
  const filtered = events.filter(e => {
    if (e.type !== 'absence') return true;
    const end = parseISO(e.endDate);
    if (!end) return true;
    if (end < TODAY) {
      dropped++;
      return false;
    }
    return true;
  });
  return { events: filtered, dropped };
}

function dropStaleAutoFlagged(events, maxAgeDays = 30) {
  let dropped = 0;
  const cutoff = new Date(TODAY.getTime() - maxAgeDays * DAY_MS);
  const filtered = events.filter(e => {
    if (!e.note || !e.note.includes('[AUTO-FLAGGED]')) return true;
    const added = parseISO(e.addedDate);
    if (!added) return true;
    if (added < cutoff) {
      dropped++;
      return false;
    }
    return true;
  });
  return { events: filtered, dropped };
}

// Canonical closing dates live in shows.json (broadway.com-audited daily). Build
// showId -> closingDate so we can reconcile stale closure events. Missing file is
// tolerated (CI workspaces without private data) — reconciliation simply no-ops.
function loadClosingDates() {
  const map = new Map();
  try {
    const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    for (const s of shows.shows || []) {
      if (s.id && s.closingDate) map.set(s.id, s.closingDate);
    }
  } catch {
    /* shows.json absent (CI without private data) — skip reconciliation */
  }
  return map;
}

function main() {
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const data = JSON.parse(raw);
  const closingDates = loadClosingDates();

  const report = {
    showsExamined: 0,
    staleClosureDatesRepaired: 0,
    closuresReclassified: 0,
    departuresReclassifiedAsClosure: 0,
    contradictedClosuresDropped: 0,
    contradictedArrivalsDropped: 0,
    endedAbsencesDropped: 0,
    staleAutoFlaggedDropped: 0,
    nameVariantDedupes: 0,
    inCastArrivalsDropped: 0,
    duplicateCastEntriesFlagged: 0,
    contradictionsByShow: {},
    duplicateCastEntriesByShow: {},
    crossShowConflicts: [],
  };

  for (const [showId, show] of Object.entries(data.shows || {})) {
    report.showsExamined++;

    // Detection gate (flag-only, NOT auto-healed): currentCast entries
    // duplicated by person (different role text for the same actor — e.g. a
    // departed star lingering under 4 role-variant entries, the Daniel
    // Radcliffe P0). Deliberately NOT auto-collapsed by --write: some
    // "duplicates" are genuinely different roles for the same actor (an
    // ensemble swing covering two named parts), and blindly merging by name
    // alone would silently destroy that second-role record across the whole
    // corpus with no human review. dedupeCurrentCastByName is available
    // (and unit-tested) for a human to apply per-show after checking the
    // source. Runs unconditionally, independent of `upcoming` — a show with
    // an empty upcoming queue can still carry stale currentCast duplicates.
    const castDupes = detectDuplicateCastEntries(show.currentCast || []);
    if (castDupes.length > 0) {
      report.duplicateCastEntriesByShow[showId] = castDupes;
      report.duplicateCastEntriesFlagged += castDupes.reduce((n, d) => n + d.entries.length - 1, 0);
    }

    let upcoming = show.upcoming || [];
    if (upcoming.length === 0) continue;

    const reclass = reclassifyClosureDepartures(upcoming, showId);
    upcoming = reclass.rewritten;
    report.closuresReclassified += reclass.closureGroupCount;
    report.departuresReclassifiedAsClosure += reclass.reclassifiedCount;

    // Reconcile stale closure dates against canonical shows.json closingDate.
    // A closure event is never updated when the show extends, so it drifts.
    const recon = reconcileClosureDateWithClosingDate(upcoming, closingDates.get(showId));
    upcoming = recon.events;
    report.staleClosureDatesRepaired += recon.repaired;

    // Name-variant dedup (e.g. "Joanna 'JoJo' Levesque" + "Joanna Levesque" + smart-quote twin)
    const beforeDedup = upcoming.length;
    upcoming = dedupeByPersonShow(upcoming);
    report.nameVariantDedupes += beforeDedup - upcoming.length;

    const contradictions = detectContradictions(upcoming, show.currentCast || []);
    if (contradictions.length > 0) {
      report.contradictionsByShow[showId] = contradictions;
    }

    // Drop arrivals that are already covered by currentCast (same person + role,
    // arrival date <= since date). Keeps the data tight and prevents the UI from
    // implying a "new" arrival that's actually historical.
    const inCastDups = contradictions.filter(c => c.kind === 'arrival-already-in-current-cast');
    if (inCastDups.length > 0) {
      // Key on NORMALIZED name + role + arrival date so the drop step matches
      // the same quote/paren-variant entries that detectContradictions flagged.
      // Without this, "Joanna 'JoJo' Levesque" gets flagged by the
      // contradiction detector (which normalizes) but missed by the drop
      // filter (which used raw strings).
      const dropKeys = new Set(
        inCastDups.map(
          c => `${normalizeIdentifier(c.name)}::${normalizeIdentifier(c.role)}::${c.arrivalDate}`,
        ),
      );
      const before = upcoming.length;
      upcoming = upcoming.filter(
        e =>
          !(
            e.type === 'arrival' &&
            dropKeys.has(
              `${normalizeIdentifier(e.name)}::${normalizeIdentifier(e.role)}::${e.date}`,
            )
          ),
      );
      report.inCastArrivalsDropped += before - upcoming.length;
    }

    const dropC = dropContradictedClosures(upcoming);
    upcoming = dropC.events;
    report.contradictedClosuresDropped += dropC.droppedClosures;
    report.contradictedArrivalsDropped += dropC.droppedArrivals;

    const dropA = dropEndedAbsences(upcoming);
    upcoming = dropA.events;
    report.endedAbsencesDropped += dropA.dropped;

    const dropF = dropStaleAutoFlagged(upcoming);
    upcoming = dropF.events;
    report.staleAutoFlaggedDropped += dropF.dropped;

    show.upcoming = upcoming;
  }

  // Cross-show conflict detection (Eric-Anderson-Gatsby-and-Moulin-Rouge type)
  report.crossShowConflicts = detectCrossShowConflicts(data.shows);

  data.lastUpdated = TODAY_STR;

  console.log('Audit summary:');
  console.log(`  Shows examined:                              ${report.showsExamined}`);
  console.log(`  Stale closure dates repaired (vs shows.json):${report.staleClosureDatesRepaired}`);
  console.log(`  Closure groups reclassified:                 ${report.closuresReclassified}`);
  console.log(`  Per-actor departures collapsed into closure: ${report.departuresReclassifiedAsClosure}`);
  console.log(`  Contradicted closures dropped (stale):       ${report.contradictedClosuresDropped}`);
  console.log(`  Contradicting arrivals dropped (stale):      ${report.contradictedArrivalsDropped}`);
  console.log(`  Ended absences dropped:                      ${report.endedAbsencesDropped}`);
  console.log(`  Stale [AUTO-FLAGGED] entries dropped:        ${report.staleAutoFlaggedDropped}`);
  console.log(`  Name-variant dedupes:                        ${report.nameVariantDedupes}`);
  console.log(`  Redundant in-cast arrivals dropped:          ${report.inCastArrivalsDropped}`);
  console.log(`  Duplicate currentCast entries flagged:       ${report.duplicateCastEntriesFlagged}`);
  console.log(`  Cross-show overlap conflicts flagged:        ${report.crossShowConflicts.length}`);
  if (Object.keys(report.contradictionsByShow).length > 0) {
    console.log('\n  Contradictions detected per show:');
    for (const [showId, warnings] of Object.entries(report.contradictionsByShow)) {
      for (const w of warnings) {
        if (w.kind === 'closure-vs-later-arrival') {
          console.log(`    [${showId}] closure ${w.closureDate} contradicted by:`);
          for (const a of w.laterArrivals) {
            console.log(`      - ${a.name} arrives ${a.date}${a.endDate ? ` (through ${a.endDate})` : ''}`);
          }
        } else if (w.kind === 'arrival-already-in-current-cast') {
          console.log(`    [${showId}] arrival redundant: ${w.name} (${w.role}) already in cast since ${w.sinceDate}`);
        }
      }
    }
  }
  if (report.crossShowConflicts.length > 0) {
    console.log('\n  Cross-show conflicts (actor in two shows, overlapping dates, no exit from either):');
    for (const w of report.crossShowConflicts) {
      console.log(`    - ${w.name}: ${w.showA} (${w.datesA.start}..${w.datesA.end || '?'}) vs ${w.showB} (${w.datesB.start}..${w.datesB.end || '?'})`);
    }
  }
  if (Object.keys(report.duplicateCastEntriesByShow).length > 0) {
    console.log('\n  Duplicate currentCast entries by person (NOT auto-collapsed — verify per-show before merging,');
    console.log('  some may be legitimate dual-role castings rather than scrape artifacts):');
    for (const [showId, dupes] of Object.entries(report.duplicateCastEntriesByShow)) {
      for (const d of dupes) {
        const roles = d.entries.map(e => `${e.role || 'Unknown'} (since ${e.since || '?'})`).join(', ');
        console.log(`    [${showId}] ${d.name}: ${roles}`);
      }
    }
  }

  // NOTE: duplicateCastEntriesFlagged is intentionally NOT summed here.
  // Every other term is a count of something this run just AUTO-HEALED via
  // --write, so totalIssues > 0 on a rerun means --write itself is broken.
  // Duplicate currentCast entries are deliberately never auto-collapsed (see
  // the detection-gate comment above), so they'd persist across every run
  // and permanently trip --strict in the scheduled workflow. They're
  // reported (duplicateCastEntriesByShow, printed above) for human review /
  // the daily digest, same treatment as contradictionsByShow.
  const totalIssues =
    report.staleClosureDatesRepaired +
    report.departuresReclassifiedAsClosure +
    report.contradictedClosuresDropped +
    report.contradictedArrivalsDropped +
    report.endedAbsencesDropped +
    report.staleAutoFlaggedDropped +
    report.nameVariantDedupes +
    report.inCastArrivalsDropped +
    report.crossShowConflicts.length;

  if (WRITE) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
    console.log(`\n✔ wrote ${DATA_PATH}`);
  } else {
    console.log('\n(dry-run; pass --write to persist)');
  }

  // --gate: catastrophe floor only. A cross-show conflict (actor in two shows at
  // once — never auto-fixed by --write) ALWAYS blocks; otherwise block only on a
  // mass churn spike past GATE_FLOOR. Routine sub-floor churn is surfaced above but
  // does NOT fail the trunk (the scheduled --write heals it). Decision is the pure
  // scripts/lib/cast-changes-gate.js (unit-tested, CLAUDE.md §15).
  if (GATE) {
    const crossShowConflicts = report.crossShowConflicts.length;
    if (shouldBlockCastChangesGate({ crossShowConflicts, totalIssues, floor: GATE_FLOOR })) {
      console.error(`\n❌ GATE: ${crossShowConflicts} cross-show conflict(s) (zero-tolerance) + ${totalIssues} total issue(s) vs floor ${GATE_FLOOR}. Failing the trunk.`);
      process.exit(1);
    }
    console.log(`\n✅ GATE: 0 cross-show conflicts, ${totalIssues} issue(s) ≤ floor ${GATE_FLOOR}. Auto-healable churn — surfaced above, not blocking the trunk. Full --strict triage runs daily in check-corpus-drift.yml (→ digest).`);
    return;
  }

  if (STRICT && totalIssues > 0) {
    console.error(`\n✗ strict mode: ${totalIssues} issue(s) found`);
    process.exit(1);
  }
}

main();
