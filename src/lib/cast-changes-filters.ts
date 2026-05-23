// TypeScript port of scripts/lib/cast-changes-filters.js for client/SSR use.
// Keep this in sync with the Node CJS module — both ship the same logic.

import type { CastEvent } from './data-types';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseISO(s?: string | null): Date | null {
  if (!s || typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isAutoFlaggedEvent(event: CastEvent): boolean {
  return Boolean(event && event.note && event.note.includes('[AUTO-FLAGGED]'));
}

export function filterAutoFlagged(events: CastEvent[]): CastEvent[] {
  return events.filter(e => !isAutoFlaggedEvent(e));
}

export function filterStaleAbsences(events: CastEvent[], today: Date = new Date()): CastEvent[] {
  return events.filter(e => {
    if (e.type !== 'absence') return true;
    const end = parseISO(e.endDate);
    if (!end) return true;
    return end >= today;
  });
}

export function filterPastEvents(
  events: CastEvent[],
  today: Date = new Date(),
  keepDaysAfter = 7,
): CastEvent[] {
  const cutoff = new Date(today.getTime() - keepDaysAfter * DAY_MS);
  return events.filter(e => {
    if (e.type === 'absence') return true;
    const eventDate = parseISO(e.date);
    if (!eventDate) return true;
    return eventDate >= cutoff;
  });
}

export function filterStaleAddedDates(
  events: CastEvent[],
  today: Date = new Date(),
  maxAgeDays = 60,
): CastEvent[] {
  const cutoff = new Date(today.getTime() - maxAgeDays * DAY_MS);
  return events.filter(e => {
    if (e.date) return true;
    const added = parseISO(e.addedDate);
    if (!added) return true;
    return added >= cutoff;
  });
}

export function dedupeByPersonShow(events: CastEvent[]): CastEvent[] {
  const groups = new Map<string, CastEvent>();
  for (const event of events) {
    const key = `${event.name}::${event.type}::${event.role || ''}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, event);
      continue;
    }
    const newAdded = parseISO(event.addedDate);
    const oldAdded = parseISO(existing.addedDate);
    let winner: CastEvent = existing;
    if (newAdded && oldAdded) winner = newAdded > oldAdded ? event : existing;
    else if (newAdded && !oldAdded) winner = event;
    groups.set(key, winner);
  }
  return Array.from(groups.values());
}

export function reconcileClosure(events: CastEvent[]): CastEvent[] {
  const closureDates = new Set(
    events.filter(e => e.type === 'closure' && e.date).map(c => c.date as string),
  );
  if (closureDates.size === 0) return events;
  return events.filter(e => {
    if (e.type !== 'departure') return true;
    if (!e.date || !closureDates.has(e.date)) return true;
    const note = (e.note || '').toLowerCase();
    if (note.includes('production closes') || note.includes('production ends')) return false;
    return true;
  });
}

export interface PublicFilterOptions {
  maxAddedAgeDays?: number;
  keepDaysAfter?: number;
}

export function applyPublicFilters(
  events: CastEvent[],
  today: Date = new Date(),
  opts: PublicFilterOptions = {},
): CastEvent[] {
  const maxAddedAgeDays = opts.maxAddedAgeDays ?? 60;
  const keepDaysAfter = opts.keepDaysAfter ?? 7;
  let out = events.slice();
  out = filterAutoFlagged(out);
  out = filterStaleAbsences(out, today);
  out = filterPastEvents(out, today, keepDaysAfter);
  out = filterStaleAddedDates(out, today, maxAddedAgeDays);
  out = dedupeByPersonShow(out);
  out = reconcileClosure(out);
  return out;
}
