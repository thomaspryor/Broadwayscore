/**
 * Off-Broadway/Off-West-End/homepage lazy-load closed shows into
 * `archiveShows` once the status filter needs them (All/Closed) OR a search
 * is active (search must reach closed shows too — see each page's
 * fetchArchive-triggering useEffect). Until that fetch resolves, filteredCount
 * can legitimately be 0 even though matching shows exist, so that gap must
 * render a loading state, not the "No shows found" empty state. Off-Broadway
 * shipped without this guard (BRO-3622): clicking "All" while the archive was
 * still loading looked unresponsive and drew rage clicks. `hasSearchQuery`
 * covers the same gap for a search whose only matches are closed shows.
 */
export type ShowListEmptyState = 'loading' | 'empty' | 'none';

export function getShowListEmptyState({
  filteredCount,
  archiveLoaded,
  statusFilter,
  hasSearchQuery = false,
}: {
  filteredCount: number;
  archiveLoaded: boolean;
  statusFilter: string;
  hasSearchQuery?: boolean;
}): ShowListEmptyState {
  if (filteredCount > 0) return 'none';
  const needsArchive = statusFilter === 'all' || statusFilter === 'closed' || hasSearchQuery;
  if (!archiveLoaded && needsArchive) return 'loading';
  return 'empty';
}
