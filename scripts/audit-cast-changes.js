#!/usr/bin/env node
/**
 * Audit + clean data/cast-changes.json.
 *
 * Detects and fixes the bugs surfaced in the newsletter on 2026-05-23:
 *   1. "Production closes …" stored as per-actor `departure` (Chess case).
 *      → reclassify ONE of them into a show-level `closure` event,
 *        drop the rest.
 *   2. Closure event contradicted by a later `arrival` event
 *      (Chess closure 2026-06-14 vs JoJo arrival through 2026-09-13).
 *      → drop the closure; the production isn't actually closing.
 *   3. Ended `absence` events still in upcoming (Alison Luff Wonder leave).
 *      → drop where endDate < today.
 *   4. Stale [AUTO-FLAGGED] entries (> 30 days).
 *      → drop; the scraper would have re-asserted them by now if real.
 *
 * Usage:
 *   node scripts/audit-cast-changes.js          # dry-run (default)
 *   node scripts/audit-cast-changes.js --write  # rewrite cast-changes.json
 *   node scripts/audit-cast-changes.js --strict # exit non-zero if issues
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  detectContradictions,
  detectCrossShowConflicts,
  dedupeByPersonShow,
  normalizeIdentifier,
} = require('./lib/cast-changes-filters');

const DATA_PATH = path.join(__dirname, '..', 'data', 'cast-changes.json');
const TODAY = new Date();
const TODAY_STR = TODAY.toISOString().slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const STRICT = args.has('--strict');

function parseISO(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isClosureDeparture(event) {
  if (event.type !== 'departure') return false;
  const note = (event.note || '').toLowerCase();
  // Keep this aligned with reconcileClosure() in scripts/lib/cast-changes-filters.js —
  // both functions must recognise the same closure phrasings, otherwise the daily
  // audit reclassifier silently misses closures that the runtime reconciler catches
  // (the 2026-05-23 DBH case: notes said "show closes", audit only matched "production closes").
  return (
    note.includes('production closes') ||
    note.includes('production ends') ||
    note.includes('production close') ||
    note.includes('show closes') ||
    note.includes('show ends') ||
    note.includes('final performance of the production') ||
    note.includes('final performance as show closes') ||
    note.includes('final performance as production closes')
  );
}

function reclassifyClosureDepartures(events, showId) {
  const closureGroups = new Map();
  const nonClosure = [];

  for (const e of events) {
    if (isClosureDeparture(e) && e.date) {
      if (!closureGroups.has(e.date)) closureGroups.set(e.date, []);
      closureGroups.get(e.date).push(e);
    } else {
      nonClosure.push(e);
    }
  }

  const newClosures = [];
  for (const [date, group] of closureGroups) {
    const alreadyHasClosure = events.some(
      e => e.type === 'closure' && e.date === date,
    );
    if (alreadyHasClosure) continue;
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

  return {
    rewritten: [...newClosures, ...nonClosure],
    reclassifiedCount: closureGroups.size > 0
      ? Array.from(closureGroups.values()).reduce((n, g) => n + g.length, 0)
      : 0,
    closureGroupCount: closureGroups.size,
  };
}

function dropContradictedClosures(events) {
  const warnings = detectContradictions(events);
  if (warnings.length === 0) return { events, dropped: 0 };

  const badClosureDates = new Set(warnings.map(w => w.closureDate));
  const filtered = events.filter(e => {
    if (e.type === 'closure' && badClosureDates.has(e.date)) return false;
    return true;
  });

  return { events: filtered, dropped: events.length - filtered.length };
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

function main() {
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const data = JSON.parse(raw);

  const report = {
    showsExamined: 0,
    closuresReclassified: 0,
    departuresReclassifiedAsClosure: 0,
    contradictedClosuresDropped: 0,
    endedAbsencesDropped: 0,
    staleAutoFlaggedDropped: 0,
    nameVariantDedupes: 0,
    inCastArrivalsDropped: 0,
    contradictionsByShow: {},
    crossShowConflicts: [],
  };

  for (const [showId, show] of Object.entries(data.shows || {})) {
    report.showsExamined++;
    let upcoming = show.upcoming || [];
    if (upcoming.length === 0) continue;

    const reclass = reclassifyClosureDepartures(upcoming, showId);
    upcoming = reclass.rewritten;
    report.closuresReclassified += reclass.closureGroupCount;
    report.departuresReclassifiedAsClosure += reclass.reclassifiedCount;

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
    report.contradictedClosuresDropped += dropC.dropped;

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
  console.log(`  Closure groups reclassified:                 ${report.closuresReclassified}`);
  console.log(`  Per-actor departures collapsed into closure: ${report.departuresReclassifiedAsClosure}`);
  console.log(`  Contradicted closures dropped:               ${report.contradictedClosuresDropped}`);
  console.log(`  Ended absences dropped:                      ${report.endedAbsencesDropped}`);
  console.log(`  Stale [AUTO-FLAGGED] entries dropped:        ${report.staleAutoFlaggedDropped}`);
  console.log(`  Name-variant dedupes:                        ${report.nameVariantDedupes}`);
  console.log(`  Redundant in-cast arrivals dropped:          ${report.inCastArrivalsDropped}`);
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

  const totalIssues =
    report.departuresReclassifiedAsClosure +
    report.contradictedClosuresDropped +
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

  if (STRICT && totalIssues > 0) {
    console.error(`\n✗ strict mode: ${totalIssues} issue(s) found`);
    process.exit(1);
  }
}

main();
