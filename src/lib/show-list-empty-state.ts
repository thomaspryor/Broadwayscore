/**
 * Off-Broadway page (and homepage) lazy-load closed shows into `archiveShows`
 * only once the status filter needs them (All/Closed) — see fetchArchive().
 * Until that fetch resolves, filteredCount can legitimately be 0 even though
 * matching shows exist, so that gap must render a loading state, not the
 * "No shows found" empty state. Off-Broadway shipped without this guard
 * (BRO-3622): clicking "All" while the archive was still loading looked
 * unresponsive and drew rage clicks.
 */
export type ShowListEmptyState = 'loading' | 'empty' | 'none';

export function getShowListEmptyState({
  filteredCount,
  archiveLoaded,
  statusFilter,
}: {
  filteredCount: number;
  archiveLoaded: boolean;
  statusFilter: string;
}): ShowListEmptyState {
  if (filteredCount > 0) return 'none';
  const needsArchive = statusFilter === 'all' || statusFilter === 'closed';
  if (!archiveLoaded && needsArchive) return 'loading';
  return 'empty';
}
