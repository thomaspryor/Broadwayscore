'use client';

import { useState } from 'react';
import { ToggleBar } from '@/components/show-cards';
import TonyPredictionsTable from '@/components/TonyPredictionsTable';
import type { PredictionMode } from '@/components/TonyPredictionsTable';
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
}

const MODE_OPTIONS: Array<{ value: PredictionMode; label: string }> = [
  { value: 'combined', label: 'Combined' },
  { value: 'critics', label: 'Critics' },
  { value: 'audience', label: 'Audience' },
];

export default function TonyPredictionsClient({ categories, outcomes, categoryOutcomes }: TonyPredictionsClientProps) {
  const [mode, setMode] = useState<PredictionMode>('combined');

  let runningIndex = 0;

  return (
    <>
      <div className="mb-6">
        <ToggleBar<PredictionMode>
          label="Ranked by"
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
          ariaLabel="Prediction ranking mode"
        />
      </div>

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
            mode={mode}
          />
        );
      })}
    </>
  );
}
