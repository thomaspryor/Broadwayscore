import TrendingShowCard from '@/components/trending/TrendingShowCard';
import type { TrendingPick } from '@/lib/data-social-pulse';
import type { ComputedShow } from '@/lib/engine';

/**
 * Shared ordered list of trending show cards. Used by both /trending
 * (Broadway) and /west-end/trending. Extracts the common rendering
 * logic so each page only handles metadata, breadcrumbs, and market-
 * specific copy.
 */

interface TrendingListProps {
  picks: TrendingPick[];
  showLookup: Map<string, ComputedShow>;
  emptyMessage: string;
}

export default function TrendingList({ picks, showLookup, emptyMessage }: TrendingListProps) {
  if (picks.length === 0) {
    return <p className="text-sm text-gray-500 italic">{emptyMessage}</p>;
  }

  return (
    <ol role="list" className="space-y-2.5 list-none p-0">
      {picks.map((pulse, idx) => (
        <li key={pulse.showId}>
          <TrendingShowCard
            rank={idx + 1}
            pulse={pulse}
            show={showLookup.get(pulse.showId)}
          />
        </li>
      ))}
    </ol>
  );
}
