'use client';

import { useEffect, useState } from 'react';
import { arrivalText, type ArrivalView } from '@/lib/review-arrival';

/**
 * The status as one short line that sits with the Critic Score where the review
 * count already reads. Rendered inside the hero's score block, never as its own section.
 */
export default function ReviewArrivalLine({ arrival, className = '' }: { arrival: ArrivalView; className?: string }) {
  return (
    <span className={`flex flex-col gap-1.5 ${className}`} data-testid="review-arrival" data-phase={arrival.phase}>
      <span className="flex items-start gap-1.5 leading-snug">
        <span>{arrivalText(arrival)}</span>
      </span>
    </span>
  );
}

/**
 * The page is prerendered and can be served after the window ends (the show page
 * revalidates daily), so the client re-checks the end time after mount.
 */
export function useArrivalActive(arrival: ArrivalView | null | undefined): boolean {
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (arrival && Date.now() > arrival.endsAt) setActive(false);
  }, [arrival]);
  return !!arrival && active;
}
