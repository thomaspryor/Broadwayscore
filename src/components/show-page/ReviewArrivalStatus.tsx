import { arrivalText, type ReviewArrival } from '@/lib/review-arrival';

/**
 * The status as one short line that sits with the Critic Score where the review
 * count already reads. Rendered inside the hero's score block, never as its own section.
 */
export default function ReviewArrivalLine({ arrival, className = '' }: { arrival: ReviewArrival; className?: string }) {
  return (
    <span className={`flex flex-col gap-1.5 ${className}`} data-testid="review-arrival" data-phase={arrival.phase}>
      <span className="flex items-start gap-1.5 leading-snug">
        <span>{arrivalText(arrival)}</span>
      </span>
    </span>
  );
}
