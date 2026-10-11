'use client';

import { useFantasyOwnership } from '@/lib/use-fantasy-ownership';
import { formatOwnershipPct } from '../../../scripts/lib/fantasy-ownership';

/**
 * "34% picked": the share of this season's rosters that include the show
 * (BRO-4338). Renders nothing until the league has enough rosters to publish.
 */
export default function FantasyOwnershipTag({ showId, className = '' }: { showId: string; className?: string }) {
  const ownership = useFantasyOwnership();
  if (!ownership) return null;
  const pct = formatOwnershipPct(ownership.shows[showId]);
  return (
    <span
      className={`whitespace-nowrap tabular-nums text-gray-400 ${className}`}
      title={`On ${pct} of ${ownership.totalEntries.toLocaleString()} rosters this season`}
      data-testid="fantasy-ownership"
    >
      {pct} picked
    </span>
  );
}
