'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Closure-departure phrase list — the single source of truth for "this
 * departure event is really a show-wide closure misrepresented as N
 * per-actor exits". Any module that recognises closure-style notes MUST
 * import this constant rather than maintaining its own copy:
 *   - scripts/audit-cast-changes.js: isClosureDeparture() (mutates cast-changes.json on --write)
 *   - this module:                   reconcileClosure() (runtime suppression)
 *   - src/lib/cast-changes-filters.ts: same logic, TS port for the web app
 * Phrase drift between these callers has shipped two distinct bugs:
 *   2026-05-23: scrape-cast-changes emitted N "Production closes" departures; runtime collapsed them but audit didn't, so they re-appeared after dedup.
 *   2026-05-24: DBH notes said "show closes" — audit's narrower list silently skipped the show. (This file's list was also narrower than the audit at one point.)
 */
const CLOSURE_NOTE_PHRASES = Object.freeze([
  'production closes',
  'production close',
  'production ends',
  'show closes',
  'show ends',
  'final performance of the production',
  'final performance as show closes',
  'final performance as production closes',
]);

function noteMatchesClosurePhrase(note) {
  if (!note || typeof note !== 'string') return false;
  const lower = note.toLowerCase();
  for (const phrase of CLOSURE_NOTE_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

function parseISO(s) {
  if (!s || typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / DAY_MS);
}

function isAutoFlaggedEvent(event) {
  return Boolean(event && event.note && event.note.includes('[AUTO-FLAGGED]'));
}

/**
 * Normalize a name or role for dedup keying.
 * Strips parenthetical/bracketed nicknames and smart quotes so that
 * 'Joanna "JoJo" Levesque', "Joanna 'JoJo' Levesque", 'Joanna Levesque'
 * all collapse to 'joanna levesque'. Does NOT alter the displayed event —
 * only the dedup key.
 */
function normalizeIdentifier(s) {
  if (!s || typeof s !== 'string') return '';
  // Strip nickname quotes ONLY when balanced and adjacent to whitespace/start/end
  // on the opening side AND whitespace/punctuation on the closing side. This
  // prevents apostrophes inside real names (O'Brien, D'Angelo, O'Malley)
  // from being treated as quote delimiters.
  // Examples that strip:
  //   Joanna "JoJo" Levesque → Joanna  Levesque  (double quote, balanced)
  //   Mary “MK” O'Brien → Mary  O'Brien  (curly double, balanced)
  // Examples that do NOT strip:
  //   Sean O'Malley → Sean O'Malley  (apostrophe is intra-word)
  //   Sean O'Malley 'Slick' Jones → Sean O'Malley  Jones (only the balanced 'Slick' is stripped)
  return s
    // Double quotes (straight + curly) — usually unambiguous
    .replace(/(^|\s)["“]([^"”]+)["”](?=\s|$|[.,!?;])/g, '$1')
    // Single quotes / apostrophes — require whitespace/start before AND after the closer
    // (so 'Slick' between spaces strips, but O'Malley keeps its apostrophe)
    .replace(/(^|\s)['‘]([^'’]+)['’](?=\s|$|[.,!?;])/g, '$1')
    // Strip parentheticals
    .replace(/\([^)]*\)/g, '')
    // Strip bracketed text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function filterAutoFlagged(events) {
  return events.filter(e => !isAutoFlaggedEvent(e));
}

function filterStaleAbsences(events, today = new Date()) {
  return events.filter(e => {
    if (e.type !== 'absence') return true;
    const end = parseISO(e.endDate);
    if (!end) return true;
    return end >= today;
  });
}

function filterPastEvents(events, today = new Date(), keepDaysAfter = 7) {
  const cutoff = new Date(today.getTime() - keepDaysAfter * DAY_MS);
  return events.filter(e => {
    if (e.type === 'absence') return true;
    const eventDate = parseISO(e.date);
    if (!eventDate) return true;
    return eventDate >= cutoff;
  });
}

function filterStaleAddedDates(events, today = new Date(), maxAgeDays = 60) {
  const cutoff = new Date(today.getTime() - maxAgeDays * DAY_MS);
  return events.filter(e => {
    if (e.date) return true;
    const added = parseISO(e.addedDate);
    if (!added) return true;
    return added >= cutoff;
  });
}

function dedupeByPersonShow(events) {
  const groups = new Map();
  for (const event of events) {
    const key = `${normalizeIdentifier(event.name)}::${event.type}::${normalizeIdentifier(event.role)}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, event);
      continue;
    }

    const newAdded = parseISO(event.addedDate);
    const oldAdded = parseISO(existing.addedDate);

    let winner = existing;
    if (newAdded && oldAdded) {
      winner = newAdded > oldAdded ? event : existing;
    } else if (newAdded && !oldAdded) {
      winner = event;
    }

    const newRole = winner.role && winner.role !== 'Unknown' ? winner.role : '';
    const otherRole =
      (winner === event ? existing.role : event.role) &&
      (winner === event ? existing.role : event.role) !== 'Unknown'
        ? winner === event
          ? existing.role
          : event.role
        : '';
    if (newRole.length === 0 && otherRole.length > 0) {
      winner = { ...winner, role: otherRole };
    }

    groups.set(key, winner);
  }
  return Array.from(groups.values());
}

/**
 * Suppress per-actor `departure` events that are really restatements of a
 * show-wide closure. Catches three patterns:
 *   1. Same-date departure with a "production closes" note
 *   2. ±3-day departure with a "production closes" note (LLM date drift)
 *   3. Same-date departure on the closure date regardless of note text
 *
 * The ±3-day window is the LLM-drift slop: the scraper has been seen to
 * encode "final performance June 14" as June 13 or June 15 depending on
 * how the article phrases the date. The closure event always carries the
 * authoritative date from the closure announcement, so we trust that and
 * fold nearby departures into it.
 */
function reconcileClosure(events) {
  const closureDates = events
    .filter(e => e.type === 'closure' && e.date)
    .map(e => parseISO(e.date))
    .filter(Boolean);
  if (closureDates.length === 0) return events;

  const SLOP_DAYS = 3;
  return events.filter(e => {
    if (e.type !== 'departure') return true;
    const noteMatchesClosure = noteMatchesClosurePhrase(e.note);
    const departureDate = parseISO(e.date);
    if (!departureDate) return !noteMatchesClosure;
    for (const cDate of closureDates) {
      const diff = Math.abs((departureDate.getTime() - cDate.getTime()) / DAY_MS);
      if (diff === 0) return false;
      if (diff <= SLOP_DAYS && noteMatchesClosure) return false;
    }
    return true;
  });
}

function detectContradictions(events, currentCast = []) {
  const warnings = [];

  // 1. Closure date contradicted by later arrival
  const closures = events.filter(e => e.type === 'closure' && e.date);
  const arrivals = events.filter(e => e.type === 'arrival' && e.date);
  for (const closure of closures) {
    const closureDate = parseISO(closure.date);
    if (!closureDate) continue;
    const laterArrivals = arrivals.filter(a => {
      const aDate = parseISO(a.date);
      return aDate && aDate > closureDate;
    });
    if (laterArrivals.length > 0) {
      warnings.push({
        kind: 'closure-vs-later-arrival',
        closureDate: closure.date,
        closureSourceUrl: closure.sourceUrl || null,
        laterArrivals: laterArrivals.map(a => ({
          name: a.name,
          date: a.date,
          endDate: a.endDate || null,
          sourceUrl: a.sourceUrl || null,
        })),
      });
    }
  }

  // 2. Arrival redundant — actor already in currentCast in same role
  if (Array.isArray(currentCast) && currentCast.length > 0) {
    const castIndex = new Map();
    for (const member of currentCast) {
      const k = `${normalizeIdentifier(member.name)}::${normalizeIdentifier(member.role)}`;
      castIndex.set(k, member);
    }
    for (const a of arrivals) {
      const k = `${normalizeIdentifier(a.name)}::${normalizeIdentifier(a.role)}`;
      if (!castIndex.has(k)) continue;
      const member = castIndex.get(k);
      const arrivalDate = parseISO(a.date);
      const sinceDate = parseISO(member.since);
      if (sinceDate && arrivalDate && arrivalDate <= sinceDate) {
        warnings.push({
          kind: 'arrival-already-in-current-cast',
          name: a.name,
          role: a.role,
          arrivalDate: a.date,
          sinceDate: member.since,
          sourceUrl: a.sourceUrl || null,
        });
      }
    }
  }

  return warnings;
}

/**
 * Cross-show check. Given the full {shows: {showId: {currentCast, upcoming}}}
 * data file, find actors who appear as 'arrival' in two shows whose run dates
 * overlap, without a corresponding 'absence' or 'departure' from the first
 * show. Eric-Anderson-Gatsby-and-Moulin-Rouge type bug.
 */
function detectCrossShowConflicts(showsData) {
  const warnings = [];
  if (!showsData || typeof showsData !== 'object') return warnings;

  const byActor = new Map();
  for (const [showId, show] of Object.entries(showsData)) {
    const upcoming = (show && show.upcoming) || [];
    for (const event of upcoming) {
      if (event.type !== 'arrival' || !event.date) continue;
      if (!byActor.has(normalizeIdentifier(event.name))) {
        byActor.set(normalizeIdentifier(event.name), []);
      }
      byActor.get(normalizeIdentifier(event.name)).push({ showId, event });
    }
  }

  for (const [normName, entries] of byActor) {
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a.showId === b.showId) continue;
        const aStart = parseISO(a.event.date);
        const bStart = parseISO(b.event.date);
        if (!aStart || !bStart) continue;
        // Cap missing endDate at 30 days (typical short-run / benefit night)
        // instead of a full year — avoids false positives on one-off appearances.
        const aEnd = parseISO(a.event.endDate) || new Date(aStart.getTime() + 30 * DAY_MS);
        const bEnd = parseISO(b.event.endDate) || new Date(bStart.getTime() + 30 * DAY_MS);
        if (aStart <= bEnd && bStart <= aEnd) {
          // Overlapping arrivals — check if there's an 'absence' or
          // 'departure' from the OTHER show covering the conflict.
          const aHasExit = (showsData[a.showId].upcoming || []).some(
            e =>
              (e.type === 'absence' || e.type === 'departure') &&
              normalizeIdentifier(e.name) === normName,
          );
          const bHasExit = (showsData[b.showId].upcoming || []).some(
            e =>
              (e.type === 'absence' || e.type === 'departure') &&
              normalizeIdentifier(e.name) === normName,
          );
          if (!aHasExit && !bHasExit) {
            warnings.push({
              kind: 'cross-show-overlap-without-exit',
              name: a.event.name,
              showA: a.showId,
              showB: b.showId,
              datesA: { start: a.event.date, end: a.event.endDate || null },
              datesB: { start: b.event.date, end: b.event.endDate || null },
            });
          }
        }
      }
    }
  }

  return warnings;
}

function applyPublicFilters(events, today = new Date(), opts = {}) {
  const maxAddedAgeDays = opts.maxAddedAgeDays != null ? opts.maxAddedAgeDays : 60;
  const keepDaysAfter = opts.keepDaysAfter != null ? opts.keepDaysAfter : 7;

  let out = events.slice();
  out = filterAutoFlagged(out);
  out = filterStaleAbsences(out, today);
  out = filterPastEvents(out, today, keepDaysAfter);
  out = filterStaleAddedDates(out, today, maxAddedAgeDays);
  out = dedupeByPersonShow(out);
  out = reconcileClosure(out);
  return out;
}

module.exports = {
  isAutoFlaggedEvent,
  normalizeIdentifier,
  filterAutoFlagged,
  filterStaleAbsences,
  filterPastEvents,
  filterStaleAddedDates,
  dedupeByPersonShow,
  reconcileClosure,
  detectContradictions,
  detectCrossShowConflicts,
  applyPublicFilters,
  CLOSURE_NOTE_PHRASES,
  noteMatchesClosurePhrase,
};
