/**
 * Display-side rules shared by the two Social Pulse surfaces: SocialPulseCard
 * (show page, a client component) and TrendingShowCard (/trending leaderboard).
 *
 * This module deliberately has ZERO imports. `data-social-pulse.ts` would be
 * the obvious home, but it reads the filesystem (`import fs from 'fs'`), so
 * importing it from a `'use client'` component pulls `fs` into the browser
 * bundle and fails the build. Keeping the rule here lets both surfaces share
 * one definition without dragging server-only code across the boundary.
 */

/**
 * Minimum opinion-bearing posts behind `positivePct` before any sentiment
 * (percentage text or bar) renders on a card. A "100% positive" derived from
 * two posts is noise dressed as a signal.
 *
 * 10 is the show-page card's long-standing floor; /trending now shares it so
 * the same show can't read "0% positive" on one surface and blank on the other.
 */
export const MIN_OPINION_SAMPLE = 10;

/** Minimal shape the predicate actually reads — object args (not positional)
 *  so callers can't transpose positivePct/opinionSample. Both fields widen to
 *  the same `number | null | undefined` type, so a positional
 *  `(opinionSample, positivePct)` call compiled cleanly and silently returned
 *  wrong answers (e.g. a 2-post show showing "100% positive") — confirmed by
 *  an independent review during the 2026-07-26 fix. Named fields close that
 *  hole: there's no argument order to get wrong. */
interface SentimentSignals {
  positivePct: number | null | undefined;
  opinionSample?: number | null;
}

/**
 * True when a card may display sentiment for a show.
 *
 * Two independent ways to fail:
 *   1. `positivePct === null` — the scorer found ZERO opinion-bearing posts
 *      (see computePositivePct in scripts/lib/social-pulse-scorer.js). This is
 *      "unknown," not "0% positive." Before the 2026-07-26 credibility audit
 *      the scorer returned 0 here and 27/76 live files rendered "0% positive"
 *      off no opinions at all.
 *   2. `opinionSample < MIN_OPINION_SAMPLE` — a real percentage, but from too
 *      thin a sample to publish.
 *
 * `opinionSample` is undefined in legacy v2 files, which predate the field
 * entirely; those keep rendering (they've always had a numeric percentage) so
 * the fix doesn't blank out shows whose data simply hasn't been regenerated.
 */
export function shouldShowSentiment({ positivePct, opinionSample }: SentimentSignals): boolean {
  if (typeof positivePct !== 'number' || Number.isNaN(positivePct)) return false;
  if (opinionSample === undefined || opinionSample === null) return true;
  return opinionSample >= MIN_OPINION_SAMPLE;
}
