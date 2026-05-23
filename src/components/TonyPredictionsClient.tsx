'use client';

import TonyPredictionsTable from '@/components/TonyPredictionsTable';
import type { TonyCategory } from '@/lib/data-tony-predictions';

export interface CategoryOutcome {
  status: 'correct' | 'missed';
  winnerTitle: string;
  winnerRank: number | null;
  predictedTitle: string | null;
}

interface TonyPredictionsClientProps {
  categories: TonyCategory[];
  outcomes?: Record<string, 'winner' | 'nominated'>;
  categoryOutcomes?: Record<string, CategoryOutcome>;
  /** Per-category list of shows ruled ineligible by the Tony Administration Committee */
  ineligibleByCategory?: Record<string, Array<{ slug: string; title: string; note: string }>>;
}

export default function TonyPredictionsClient({ categories, outcomes, categoryOutcomes, ineligibleByCategory }: TonyPredictionsClientProps) {
  let runningIndex = 0;

  return (
    <>
      {categories.map(cat => {
        const startIndex = runningIndex;
        runningIndex += cat.shows.length + cat.upcoming.length;
        return (
          <TonyPredictionsTable
            key={cat.key}
            sectionId={cat.key}
            title={cat.title}
            description={cat.description}
            shows={cat.shows}
            upcoming={cat.upcoming}
            startIndex={startIndex}
            outcomes={outcomes && Object.keys(outcomes).length > 0 ? outcomes : undefined}
            categoryOutcome={categoryOutcomes?.[cat.key]}
            ineligible={ineligibleByCategory?.[cat.key]}
            mode="combined"
          />
        );
      })}
    </>
  );
}
