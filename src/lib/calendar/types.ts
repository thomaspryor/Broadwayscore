/**
 * The one event shape. Watchlist rows, outings (Phase 2), and URL params all
 * map INTO this before any builder touches them — so a Phase 2 token swap
 * changes the mapping, never the builders.
 *
 * Deliberately free of show-domain types: this module is vendored standalone
 * into the iOS app (see scripts/vendor-stats-lib.js for the mechanism it
 * mirrors), so it must not import from `@/lib/engine`, `@/lib/stats`, or
 * anything else outside this directory. Callers pre-resolve everything.
 */
export interface PerformanceEvent {
  /**
   * shows.json id or diary-catalog id — same convention as watchlist.show_id.
   * This is the UID stem, so it must be stable across reschedules: changing it
   * makes a re-export create a second event instead of updating the first.
   */
  showId: string;
  /** Show title, unescaped. The builder handles RFC 5545 escaping. */
  title: string;
  /** Local calendar date of the performance, YYYY-MM-DD. */
  date: string;
  /** Local curtain time, HH:MM (24h). null = no time set → all-day event. */
  time: string | null;
  /** IANA zone, e.g. America/New_York. null = floating local time (§4.4). */
  tz: string | null;
  /** Total event length in minutes, already parsed and buffered by the caller. */
  durationMin: number;
  /** Venue name or street address, whichever the caller resolved. */
  location: string;
  /** Canonical show page URL. */
  showUrl: string;
  /** Phase 1+: the invite link, embedded so the event itself carries it. */
  joinUrl?: string;
  /** Phase 2: display names only, never emails or user ids. */
  companions?: string[];
}

/** A time-of-day classification stored alongside the curtain time. */
export type TimeSlot = 'matinee' | 'evening' | 'custom';

export interface BuildIcsOptions {
  /**
   * RFC 5545 SEQUENCE. Callers pass a monotonically non-decreasing integer;
   * `sequenceFromTimestamp` derives one that does not collide within a second.
   * Never generated internally — this module is pure, so it cannot read a clock.
   */
  sequence?: number;
  /** Overrides the UID domain. Defaults to broadwayscorecard.com. */
  uidDomain?: string;
  /** DTSTAMP as a unix ms timestamp. Callers pass their own clock reading. */
  generatedAt: number;
}
