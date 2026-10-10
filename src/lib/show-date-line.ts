/**
 * Show hero date-line rules — single source of truth for both heroes
 * (src/app/show/[slug]/page.tsx RedesignOff branch, and
 * src/components/show-page/ShowHeroRedesign.tsx DateLine). Mirrors
 * HeroRankLine.tsx's "shared component" precedent so the two heroes cannot
 * silently diverge on start/closing/duration wording again (task #951).
 *
 * openingDate is routinely null Off-Broadway/Off-West End (no separate press
 * night) — every branch below falls back to previewsStartDate for the start
 * half. Without the fallback a show with a known first-preview AND closing
 * date showed neither the start nor a "Running since" line (owner reports on
 * The Pass and the-magicians-table-off-west-end-2026, 2026-08-02/03).
 *
 * Also home to the hero's "Most reviews from N years ago" caveat
 * (getReviewAgeNote), for the same both-heroes-must-agree reason.
 */

import { getOperaDurationSuffix } from './show-market';
import { getRunLength } from './date-utils';

export interface ShowDateLineInput {
  status?: string | null;
  openingDate?: string | null;
  previewsStartDate?: string | null;
  closingDate?: string | null;
}

export interface DurationSuffixShowInput {
  category?: string;
  type?: string;
}

/**
 * Duration suffix for the hero's "X months <suffix>" fragment on open shows
 * with a real openingDate (getBroadwayDuration's suffix param). null
 * suppresses the fragment entirely — regional tryouts aren't "X months on
 * Broadway" or any other market, that's the whole point of a tryout.
 */
export function getHeroDurationSuffix(show: DurationSuffixShowInput): string | null {
  const opera = getOperaDurationSuffix(show);
  if (opera) return opera;
  if (show.category === 'off-west-end') return 'Off-West End';
  if (show.category === 'west-end') return 'in the West End';
  if (show.category === 'off-broadway') return 'Off-Broadway';
  if (show.category === 'regional') return null;
  if (show.category === 'tour') return 'on tour';
  return 'on Broadway';
}

export interface DateLineSegment {
  kind: 'start' | 'closing' | 'duration';
  text: string;
  /** Closing segments get the "run is ending/ended" visual treatment (amber in the legacy hero). */
  emphasize?: boolean;
}

/**
 * Format an ISO date as "Apr 10, 2026". UTC-based to avoid timezone-related
 * hydration mismatch. Strips ordinal suffixes (1st/2nd/3rd/4th) that break
 * Date parsing. Hides (returns '') on invalid or pre-1950 input rather than
 * echoing a raw/garbage string — the legacy hero always did this; the
 * redesign hero's separate formatDate() used to echo the raw ISO string on
 * malformed input instead (hand-synced in df208b74f9c, now unified here).
 */
export function formatShowDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const cleaned = dateStr.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  const date = new Date(cleaned);
  if (isNaN(date.getTime()) || date.getFullYear() < 1950) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/**
 * Build the ordered date-line segments for a show. Callers render the
 * segments however fits their visual treatment (inline spans with dot
 * separators, a single joined line, etc.) — see formatDateLineString for the
 * plain-text join both heroes must produce identically.
 *
 * durationText is precomputed by the caller (getBroadwayDuration + a
 * market-specific suffix like "on Broadway" / "in the West End") since the
 * suffix wording depends on category, which this module doesn't own. Only
 * used for open/running shows with no closing date and a real openingDate.
 *
 * Every branch below gates on the FORMATTED value (formattedStart /
 * formattedClosing), not the raw field — gating on the raw field let an
 * invalid/pre-1950 date produce a dangling "Opened " or "Closed " label with
 * no date after it. This was the exact class of bug the two heroes had
 * already diverged on (legacy gated on the formatted value, the redesign
 * hero gated on the raw field) before this module unified them.
 */
export function getShowDateLineSegments(
  show: ShowDateLineInput,
  durationText?: string | null
): DateLineSegment[] {
  const start = show.openingDate || show.previewsStartDate || null;
  const startIsPreview = !show.openingDate && !!show.previewsStartDate;
  const closing = show.closingDate || null;
  const formattedStart = formatShowDate(start);
  const formattedClosing = formatShowDate(closing);

  if (show.status === 'closed') {
    if (formattedStart && formattedClosing) {
      const segments: DateLineSegment[] = [
        { kind: 'start', text: `${startIsPreview ? 'Ran from' : 'Opened'} ${formattedStart}` },
        { kind: 'closing', text: `Closed ${formattedClosing}`, emphasize: true },
      ];
      const ran = getRunLength(start, closing, 'precise');
      if (ran) segments.push({ kind: 'duration', text: `Ran for ${ran}` });
      return segments;
    }
    if (formattedStart) return [{ kind: 'start', text: `Ran from ${formattedStart}` }];
    if (formattedClosing) return [{ kind: 'closing', text: `Closed ${formattedClosing}`, emphasize: true }];
    return [];
  }

  if (show.status === 'previews' || show.status === 'upcoming') {
    const segments: DateLineSegment[] = [];
    if (formattedStart) segments.push({ kind: 'start', text: `${startIsPreview ? 'Previews from' : 'Opens'} ${formattedStart}` });
    if (formattedClosing) segments.push({ kind: 'closing', text: `Closes ${formattedClosing}`, emphasize: true });
    return segments;
  }

  // Open (or any other running status).
  const segments: DateLineSegment[] = [];
  if (formattedStart) segments.push({ kind: 'start', text: `${startIsPreview ? 'Running since' : 'Opened'} ${formattedStart}` });
  if (formattedClosing) {
    segments.push({ kind: 'closing', text: `Closes ${formattedClosing}`, emphasize: true });
  } else if (durationText) {
    segments.push({ kind: 'duration', text: durationText });
  }
  return segments;
}

/** Plain-text join both heroes must produce identically for the same show. */
export function formatDateLineString(segments: DateLineSegment[]): string {
  return segments.map((s) => s.text).join(' · ');
}

/**
 * Publish years of a show's reviews, skipping any review without a readable
 * year. publishDate is ISO for nearly all reviews but some are "2015-07" or
 * prose ("November 20, 2025"), so this pulls the 4-digit year out of the
 * string instead of trusting Date parsing (which is also timezone-free).
 */
export function getReviewPublishYears(
  reviews: ReadonlyArray<{ publishDate?: string | null }> | null | undefined
): number[] {
  const years: number[] = [];
  for (const r of reviews || []) {
    const m = String(r.publishDate || '').match(/\b(19|20)\d{2}\b/);
    if (m) years.push(Number(m[0]));
  }
  return years;
}

/**
 * The year most of an open show's reviews date from, when that is 10+ years
 * ago; null otherwise. Single rule behind the "most reviews are old" caveat on
 * both heroes (getReviewAgeNote) and the list cards (engine.ts reviewYearNote),
 * so a show page and its card can't disagree (BRO-4525: the cards kept the old
 * openingDate math and still said "Most reviews from 1952" for The Mousetrap).
 *
 * Counts from the reviews' own publish years (the year a strict majority of
 * them were published by), not openingDate. West End re-entries and shows
 * re-reviewed after a reopening carry reviews decades newer than the original
 * opening: counting from openingDate told readers The Mousetrap's reviews were
 * 74 years old when most are from 2021. Needs 3+ dated reviews. Callers pass
 * only shows that display a critic score.
 */
export function getReviewAgeYear(
  show: Pick<ShowDateLineInput, 'status'>,
  reviews: ReadonlyArray<{ publishDate?: string | null }> | null | undefined,
  now: Date = new Date()
): number | null {
  if (show.status === 'closed') return null;
  const years = getReviewPublishYears(reviews).sort((a, b) => a - b);
  if (years.length < 3) return null;
  // Upper median: more than half the reviews are from this year or earlier.
  const majorityYear = years[Math.floor(years.length / 2)];
  if (now.getUTCFullYear() - majorityYear < 10) return null;
  return majorityYear;
}

/**
 * Hero wording of getReviewAgeYear: "Most reviews from N years ago" under the
 * critic score. Shared by both heroes so the redesign can't silently drop it
 * again (BRO-4525: the redesign shipped to demo without it).
 */
export function getReviewAgeNote(
  show: Pick<ShowDateLineInput, 'status'>,
  reviews: ReadonlyArray<{ publishDate?: string | null }> | null | undefined,
  now: Date = new Date()
): string | null {
  const year = getReviewAgeYear(show, reviews, now);
  return year === null ? null : `Most reviews from ${now.getUTCFullYear() - year} years ago`;
}
