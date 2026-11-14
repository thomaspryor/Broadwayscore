// BRO-6984: "About N people visited show pages featuring your reviews in the
// last 30 days", shown only to the critic who owns the page. Pure helpers, so
// tests require() the real functions (CLAUDE.md §15).
//
// The number is unique people across the union of the critic's show pages
// (scripts/critic-reach.ts, PostHog). It counts visits to show pages, never
// reads of the review, and the wording must keep saying so.

/** Below this, the stat is hidden: a tiny number reads as a put-down. */
export const REACH_MIN_PEOPLE = 50;
export const REACH_WINDOW_DAYS = 30;

/** Nearest 10 under 1,000, nearest 100 from 1,000; null when hidden. */
export function roundReach(people: unknown): number | null {
  if (typeof people !== 'number' || !Number.isFinite(people) || people < REACH_MIN_PEOPLE) return null;
  return people < 1000 ? Math.round(people / 10) * 10 : Math.round(people / 100) * 100;
}

/** The sentence for the owner bar, or null when hidden. */
export function reachPhrase(people: unknown): string | null {
  const n = roundReach(people);
  if (n === null) return null;
  return `About ${n.toLocaleString('en-US')} people visited show pages featuring your reviews in the last ${REACH_WINDOW_DAYS} days`;
}

/** The show-page paths a critic's reach counts, one per show, sorted. */
export function showPathsFor(reviews: readonly { showSlug: string }[]): string[] {
  return [...new Set(reviews.map(r => r.showSlug).filter(s => /^[a-z0-9][a-z0-9-]*$/.test(s)))].sort().map(s => `/show/${s}`);
}
