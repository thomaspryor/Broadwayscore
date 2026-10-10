'use strict';

/**
 * Pure decision functions for applying departure/arrival events to a show's
 * currentCast + history arrays (scripts/scrape-cast-changes.js:cleanExpiredEvents).
 *
 * Extracted (CLAUDE.md §15) so the currentCast-mutation logic is unit-tested
 * against real dedup/matching edge cases instead of only exercised via a live
 * scrape. Root-caused the Mariska Hargitay / EBT P0 (2026-07-21): the inline
 * version matched `c.name === event.name && c.role === event.role` (exact
 * string equality) — role text varies by source/article ("Narrator/Protagonist"
 * vs "Nameless protagonist" vs "Protagonist (nameless)" for the SAME person),
 * so a departure event silently no-opped instead of removing the stale
 * currentCast entry, and an arrival with slightly different role text added a
 * duplicate instead of recognizing the person was already cast. Both bugs now
 * match on normalizeIdentifier(name) only — a person can't be cast as
 * themselves twice under different role text.
 */

const { normalizeIdentifier } = require('./cast-changes-filters');

/**
 * Remove ALL currentCast entries for the departing person, matched by
 * normalized name. Returns the filtered array plus the removed entries (for
 * history recording) — a person may have accumulated multiple role-text-variant
 * duplicates, and a departure event should clear all of them, not just the one
 * whose role string happens to match exactly.
 */
function applyDepartureToCast(currentCast, event) {
  const targetName = normalizeIdentifier(event.name);
  const removed = [];
  const kept = [];
  for (const member of currentCast || []) {
    if (normalizeIdentifier(member.name) === targetName) {
      removed.push(member);
    } else {
      kept.push(member);
    }
  }
  return { currentCast: kept, removed };
}

/**
 * Add an arrival to currentCast unless the person (by normalized name) is
 * already present — prevents duplicate role-text-variant entries for the same
 * actor accumulating across multiple source scrapes.
 */
function addArrivalToCast(currentCast, event) {
  const targetName = normalizeIdentifier(event.name);
  const alreadyInCast = (currentCast || []).some(
    c => normalizeIdentifier(c.name) === targetName,
  );
  if (alreadyInCast) {
    return { currentCast: currentCast || [], added: false };
  }
  return {
    currentCast: [...(currentCast || []), { name: event.name, role: event.role, since: event.date }],
    added: true,
  };
}

/**
 * Build a history record from a currentCast member who just departed.
 */
function buildHistoryEntryFromDeparture(member, event) {
  return {
    name: member.name,
    role: member.role,
    since: member.since,
    until: event.date,
    note: event.note,
    sourceUrl: event.sourceUrl,
    sourceType: event.sourceType,
  };
}

/**
 * Build a history record for an arrival whose whole limited engagement
 * (start AND end) had already elapsed by the time it was discovered — e.g. a
 * scraper backfill weeks late finds "X takes over May 26, ends July 5" after
 * July 5 has already passed. The prior behavior discarded these events
 * entirely (mark appliedAt, never touch currentCast) because they're not
 * *currently* cast — which is correct — but that meant the stint left NO
 * trace anywhere in the data (the Hargitay P0: her entire 6-week run
 * vanished). Recording it to history preserves the record even though the
 * person is never added to currentCast.
 */
function buildHistoryEntryFromExpiredArrival(event) {
  return {
    name: event.name,
    role: event.role,
    since: event.date,
    until: event.endDate,
    note: event.note,
    sourceUrl: event.sourceUrl,
    sourceType: event.sourceType,
  };
}

module.exports = {
  applyDepartureToCast,
  addArrivalToCast,
  buildHistoryEntryFromDeparture,
  buildHistoryEntryFromExpiredArrival,
};
