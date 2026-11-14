/**
 * A show that has not opened yet: in previews, or announced/upcoming with no
 * performances. The show page leads with what a reader can learn about it
 * (synopsis, cast, creative team, earlier productions) instead of empty
 * score cards (BRO-7426).
 */
export function isPreOpeningStatus(status: string | null | undefined): boolean {
  return status === 'previews' || status === 'upcoming' || status === 'announced';
}
