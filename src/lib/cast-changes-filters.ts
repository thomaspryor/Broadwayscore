// TypeScript port of scripts/lib/cast-changes-filters.js for client/SSR use.
// Keep this in sync with the Node CJS module — both ship the same logic.

import type { CastEvent } from './data-types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Closure-departure phrase list — single source of truth for "this departure
 * event is really a show-wide closure misrepresented as a per-actor exit".
 * Mirror of CLOSURE_NOTE_PHRASES in scripts/lib/cast-changes-filters.js —
 * any addition here must be added there (and vice versa) or the TS web app
 * and the Node audit/newsletter pipelines silently desync. The parity is
 * guarded by tests/unit/cast-changes-filters.test.mjs.
 */
export const CLOSURE_NOTE_PHRASES: readonly string[] = Object.freeze([
  'production closes',
  'production close',
  'production ends',
  'show closes',
  'show ends',
  'final performance of the production',
  'final performance as show closes',
  'final performance as production closes',
]);

export function noteMatchesClosurePhrase(note?: string | null): boolean {
  if (!note || typeof note !== 'string') return false;
  const lower = note.toLowerCase();
  for (const phrase of CLOSURE_NOTE_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

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
    .replace(/(^|\s)["“]([^"”]+)["”](?=\s|$|[.,!?;])/g, '$1')
    .replace(/(^|\s)['‘]([^'’]+)['’](?=\s|$|[.,!?;])/g, '$1')
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

export interface ContradictionWarning {
  kind: 'closure-vs-later-arrival' | 'arrival-already-in-current-cast';
  closureDate?: string;
  closureSourceUrl?: string | null;
  laterArrivals?: Array<{
    name: string;
    date?: string;
    endDate?: string | null;
    sourceUrl?: string | null;
  }>;
  name?: string;
  role?: string;
  arrivalDate?: string;
  sinceDate?: string;
  sourceUrl?: string | null;
}

export interface CurrentCastMember {
  name: string;
  role: string;
  since?: string;
}

export function detectContradictions(
  events: CastEvent[],
  currentCast: CurrentCastMember[] = [],
): ContradictionWarning[] {
  const warnings: ContradictionWarning[] = [];

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

  if (Array.isArray(currentCast) && currentCast.length > 0) {
    const castIndex = new Map<string, CurrentCastMember>();
    for (const member of currentCast) {
      const k = `${normalizeIdentifier(member.name)}::${normalizeIdentifier(member.role)}`;
      castIndex.set(k, member);
    }
    for (const a of arrivals) {
      const k = `${normalizeIdentifier(a.name)}::${normalizeIdentifier(a.role)}`;
      if (!castIndex.has(k)) continue;
      const member = castIndex.get(k)!;
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

export interface CrossShowConflict {
  kind: 'cross-show-overlap-without-exit';
  name: string;
  showA: string;
  showB: string;
  datesA: { start: string; end: string | null };
  datesB: { start: string; end: string | null };
}

const DAY_MS_FOR_CROSS_SHOW = 24 * 60 * 60 * 1000;

export function detectCrossShowConflicts(
  showsData: Record<string, { currentCast?: CurrentCastMember[]; upcoming?: CastEvent[] }>,
): CrossShowConflict[] {
  const warnings: CrossShowConflict[] = [];
  if (!showsData || typeof showsData !== 'object') return warnings;

  const byActor = new Map<string, Array<{ showId: string; event: CastEvent }>>();
  for (const [showId, show] of Object.entries(showsData)) {
    const upcoming = (show && show.upcoming) || [];
    for (const event of upcoming) {
      if (event.type !== 'arrival' || !event.date) continue;
      const key = normalizeIdentifier(event.name);
      if (!byActor.has(key)) byActor.set(key, []);
      byActor.get(key)!.push({ showId, event });
    }
  }

  for (const [normName, entries] of Array.from(byActor.entries())) {
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
        const aEnd = parseISO(a.event.endDate) || new Date(aStart.getTime() + 30 * DAY_MS_FOR_CROSS_SHOW);
        const bEnd = parseISO(b.event.endDate) || new Date(bStart.getTime() + 30 * DAY_MS_FOR_CROSS_SHOW);
        if (aStart <= bEnd && bStart <= aEnd) {
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
              datesA: { start: a.event.date as string, end: a.event.endDate || null },
              datesB: { start: b.event.date as string, end: b.event.endDate || null },
            });
          }
        }
      }
    }
  }

  return warnings;
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
