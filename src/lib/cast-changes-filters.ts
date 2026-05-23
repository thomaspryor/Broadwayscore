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

export function normalizeIdentifier(s?: string | null): string {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/["'“”‘’][^"'“”‘’]+["'“”‘’]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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
    const key = `${normalizeIdentifier(event.name)}::${event.type}::${normalizeIdentifier(event.role)}`;
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
  const closureDates = events
    .filter(e => e.type === 'closure' && e.date)
    .map(e => parseISO(e.date))
    .filter((d): d is Date => d !== null);
  if (closureDates.length === 0) return events;
  const SLOP_DAYS = 3;
  return events.filter(e => {
    if (e.type !== 'departure') return true;
    const note = (e.note || '').toLowerCase();
    const noteMatchesClosure =
      note.includes('production closes') ||
      note.includes('production ends') ||
      note.includes('show closes') ||
      note.includes('final performance of the production');
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
