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

    // Preserve the more specific role if the winner's is missing/Unknown
    // (mirror of scripts/lib/cast-changes-filters.js dedupeByPersonShow).
    const loser = winner === event ? existing : event;
    const winnerRole = winner.role && winner.role !== 'Unknown' ? winner.role : '';
    const loserRole = loser.role && loser.role !== 'Unknown' ? loser.role : '';
    if (winnerRole.length === 0 && loserRole.length > 0) {
      winner = { ...winner, role: loserRole };
    }

    groups.set(key, winner);
  }
  return Array.from(groups.values());
}

/**
 * Pick the earliest (first-seen) of two addedDate strings. Mirrors the JS
 * lib helper of the same name.
 */
export function earliestAddedDate(
  a?: string | null,
  b?: string | null,
): string | null | undefined {
  const da = parseISO(a);
  const db = parseISO(b);
  if (da && db) return da <= db ? a : b;
  if (da) return a;
  if (db) return b;
  return a || b;
}

/**
 * Collapse multiple closure events for the same closing date down to one,
 * keeping the richer note and pinning the earliest addedDate. Read-side
 * defense-in-depth so a pre-fix duplicate closure never double-renders.
 * Mirror of dedupeClosures() in scripts/lib/cast-changes-filters.js.
 */
export function dedupeClosures(events: CastEvent[]): CastEvent[] {
  const byDate = new Map<string, CastEvent>();
  const out: CastEvent[] = [];
  for (const e of events) {
    if (e.type !== 'closure' || !e.date) {
      out.push(e);
      continue;
    }
    const prev = byDate.get(e.date);
    if (!prev) {
      const copy = { ...e };
      byDate.set(e.date, copy);
      out.push(copy);
      continue;
    }
    const pinned = earliestAddedDate(prev.addedDate, e.addedDate);
    if ((e.note || '').length > (prev.note || '').length) Object.assign(prev, e);
    prev.addedDate = pinned ?? prev.addedDate;
  }
  return out;
}

/**
 * Reconcile a show's closure event date against the canonical closing date from
 * shows.json. A closure event is never updated when the show extends, so it goes
 * stale; this corrects it. Mirror of reconcileClosureDateWithClosingDate() in
 * scripts/lib/cast-changes-filters.js.
 */
export function reconcileClosureDateWithClosingDate(
  events: CastEvent[],
  canonicalClosingDate?: string | null,
): { events: CastEvent[]; repaired: number } {
  if (!canonicalClosingDate || !/^\d{4}-\d{2}-\d{2}$/.test(canonicalClosingDate)) {
    return { events, repaired: 0 };
  }
  let repaired = 0;
  const out = events.map(e => {
    if (e.type !== 'closure' || !e.date || e.date === canonicalClosingDate) return e;
    repaired++;
    return {
      ...e,
      date: canonicalClosingDate,
      note: `Production closes ${canonicalClosingDate} (date reconciled to broadway.com-audited closingDate).`,
    };
  });
  return { events: out, repaired };
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

export interface ClosureArrivalResolution {
  events: CastEvent[];
  droppedClosures: number;
  droppedArrivals: number;
}

/**
 * Resolve closure-vs-later-arrival contradictions by RECENCY of addedDate.
 * Mirror of scripts/lib/cast-changes-filters.js — keep in lockstep.
 *
 * Closure added on/after the newest contradicting arrival → keep closure, drop
 * the stale arrival (show closing early). A strictly-newer arrival unseats the
 * closure (show extended past the old close date). Tie / missing addedDate
 * keeps the closure. WRITE-time correctness fix — NOT part of applyPublicFilters.
 */
export function resolveClosureArrivalContradictions(
  events: CastEvent[],
): ClosureArrivalResolution {
  const closures = events.filter(e => e.type === 'closure' && e.date);
  if (closures.length === 0) {
    return { events, droppedClosures: 0, droppedArrivals: 0 };
  }
  const arrivals = events.filter(e => e.type === 'arrival' && e.date);

  const closuresToDrop = new Set<CastEvent>();
  const arrivalsToDrop = new Set<CastEvent>();

  for (const closure of closures) {
    const closureDate = parseISO(closure.date);
    if (!closureDate) continue;
    const laterArrivals = arrivals.filter(a => {
      const aDate = parseISO(a.date);
      return aDate && aDate > closureDate;
    });
    if (laterArrivals.length === 0) continue;

    const closureAdded = parseISO(closure.addedDate);
    let newestArrivalAdded: Date | null = null;
    for (const a of laterArrivals) {
      const aAdded = parseISO(a.addedDate);
      if (aAdded && (!newestArrivalAdded || aAdded > newestArrivalAdded)) {
        newestArrivalAdded = aAdded;
      }
    }

    // Closure only unseated when a contradicting arrival was added STRICTLY
    // more recently (both sides dated). Tie / missing on either side keeps the
    // closure — never discard a show-closure on one-sided metadata.
    const closureWins =
      !closureAdded || !newestArrivalAdded || closureAdded >= newestArrivalAdded;

    if (closureWins) {
      for (const a of laterArrivals) arrivalsToDrop.add(a);
    } else {
      closuresToDrop.add(closure);
    }
  }

  if (closuresToDrop.size === 0 && arrivalsToDrop.size === 0) {
    return { events, droppedClosures: 0, droppedArrivals: 0 };
  }

  const filtered = events.filter(e => !closuresToDrop.has(e) && !arrivalsToDrop.has(e));
  return {
    events: filtered,
    droppedClosures: closuresToDrop.size,
    droppedArrivals: arrivalsToDrop.size,
  };
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
  out = dedupeClosures(out);
  out = reconcileClosure(out);
  return out;
}
