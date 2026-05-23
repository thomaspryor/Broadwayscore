'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

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
    const key = `${event.name}::${event.type}::${event.role || ''}`;
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

function reconcileClosure(events) {
  const closures = events.filter(e => e.type === 'closure');
  if (closures.length === 0) return events;

  const closureDates = new Set(closures.map(c => c.date).filter(Boolean));
  return events.filter(e => {
    if (e.type !== 'departure') return true;
    if (!e.date || !closureDates.has(e.date)) return true;
    const note = (e.note || '').toLowerCase();
    if (note.includes('production closes') || note.includes('production ends')) return false;
    return true;
  });
}

function detectContradictions(events) {
  const warnings = [];
  const closures = events.filter(e => e.type === 'closure' && e.date);
  if (closures.length === 0) return warnings;

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
  filterAutoFlagged,
  filterStaleAbsences,
  filterPastEvents,
  filterStaleAddedDates,
  dedupeByPersonShow,
  reconcileClosure,
  detectContradictions,
  applyPublicFilters,
};
